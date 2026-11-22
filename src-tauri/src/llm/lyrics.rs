use crate::llm::{encode_relay_audio_wav_b64, extract_json_block, LlmRelayConfig, RelayProtocol};
use anyhow::{anyhow, Result};
use reqwest::{multipart, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt::Write as FmtWrite;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricLine {
    pub start_sec: f64,
    pub end_sec: f64,
    pub text: String,
}

/// Extract timestamped lyrics from a vocal stem via third-party relay:
/// - If `use_whisper_endpoint` is true, posts 16kHz WAV to `/audio/transcriptions` (`whisper-1` / `verbose_json`).
/// - Otherwise uses the configured multimodal LLM to return JSON timestamped lyric segments.
pub async fn extract_lyrics(
    audio_path: &str,
    use_whisper_endpoint: bool,
    config: &LlmRelayConfig,
) -> Result<Vec<LyricLine>> {
    if config.base_url.trim().is_empty() || config.api_key.trim().is_empty() {
        return Err(anyhow!("请先在右侧填写第三方中转平台的 Base URL 和 API Key"));
    }

    let path_owned = audio_path.to_string();
    let wav_b64 = tokio::task::spawn_blocking(move || encode_relay_audio_wav_b64(&path_owned, None, None))
        .await
        .map_err(|e| anyhow!("Audio encode task error: {e}"))??;

    let client = Client::new();
    let base = config.base_url.trim_end_matches('/');

    if use_whisper_endpoint {
        let wav_bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &wav_b64)?;
        let endpoint = format!("{base}/audio/transcriptions");
        let part = multipart::Part::bytes(wav_bytes)
            .file_name("vocals.wav")
            .mime_str("audio/wav")?;
        let form = multipart::Form::new()
            .part("file", part)
            .text("model", "whisper-1")
            .text("response_format", "verbose_json");

        let resp = client
            .post(&endpoint)
            .bearer_auth(&config.api_key)
            .multipart(form)
            .send()
            .await?;

        let status = resp.status();
        let body: Value = resp.json().await?;
        if !status.is_success() {
            return Err(anyhow!("Whisper 中转接口返回错误 ({status}): {body}"));
        }

        let mut lines = Vec::new();
        if let Some(segs) = body["segments"].as_array() {
            for seg in segs {
                let start_sec = seg["start"].as_f64().unwrap_or(0.0);
                let end_sec = seg["end"].as_f64().unwrap_or(start_sec + 2.0);
                let text = seg["text"].as_str().unwrap_or("").trim().to_string();
                if !text.is_empty() {
                    lines.push(LyricLine { start_sec, end_sec, text });
                }
            }
        }
        return Ok(lines);
    }

    // Multimodal LLM lyric alignment fallback
    let system_prompt = "你是人声歌词听写与时间轴对齐专家。请听写音频中的人声歌词，输出严格 JSON 数组：[{start_sec: number, end_sec: number, text: string}]。不要输出多余解释。";
    let user_text = "请逐句提取人声歌词并标注准确的起止秒数（start_sec, end_sec）。";

    let raw_text = match config.protocol {
        RelayProtocol::GeminiCompatible => {
            let endpoint = format!(
                "{base}/v1beta/models/{}:generateContent?key={}",
                config.model, config.api_key
            );
            let payload = json!({
                "system_instruction": { "parts": [{ "text": system_prompt }] },
                "contents": [{
                    "role": "user",
                    "parts": [
                        { "text": user_text },
                        { "inline_data": { "mime_type": "audio/wav", "data": wav_b64 } }
                    ]
                }],
                "generationConfig": { "temperature": 0.1 }
            });
            let resp = client.post(&endpoint).json(&payload).send().await?;
            let status = resp.status();
            let body: Value = resp.json().await?;
            if !status.is_success() {
                return Err(anyhow!("Gemini 歌词听写接口错误 ({status}): {body}"));
            }
            body["candidates"][0]["content"]["parts"][0]["text"]
                .as_str()
                .unwrap_or("[]")
                .to_string()
        }
        _ => {
            let endpoint = if base.ends_with("/chat/completions") {
                base.to_string()
            } else {
                format!("{base}/chat/completions")
            };
            let audio_item = match config.protocol {
                RelayProtocol::OpenaiAudioUrl => json!({
                    "type": "audio_url",
                    "audio_url": { "url": format!("data:audio/wav;base64,{wav_b64}") }
                }),
                _ => json!({
                    "type": "input_audio",
                    "input_audio": { "data": wav_b64, "format": "wav" }
                }),
            };
            let payload = json!({
                "model": config.model,
                "temperature": 0.1,
                "messages": [
                    { "role": "system", "content": system_prompt },
                    { "role": "user", "content": [{ "type": "text", "text": user_text }, audio_item] }
                ]
            });
            let resp = client
                .post(&endpoint)
                .bearer_auth(&config.api_key)
                .json(&payload)
                .send()
                .await?;
            let status = resp.status();
            let body: Value = resp.json().await?;
            if !status.is_success() {
                return Err(anyhow!("中转平台歌词听写错误 ({status}): {body}"));
            }
            body["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("[]")
                .to_string()
        }
    };

    let trimmed = extract_json_array(&raw_text);
    let parsed: Vec<LyricLine> = serde_json::from_str(trimmed)
        .or_else(|_| serde_json::from_str(extract_json_block(&raw_text)))
        .unwrap_or_default();
    Ok(parsed)
}

fn extract_json_array(text: &str) -> &str {
    if let (Some(s), Some(e)) = (text.find('['), text.rfind(']')) {
        if e > s {
            return &text[s..=e];
        }
    }
    text.trim()
}

pub fn format_lrc_timestamp(sec: f64) -> String {
    let clamped = sec.max(0.0);
    let mins = (clamped / 60.0).floor() as u32;
    let rem = clamped - (mins as f64 * 60.0);
    format!("[{mins:02}:{rem:05.2}]")
}

pub fn write_lrc_file(title: &str, lines: &[LyricLine], save_path: &str) -> Result<String> {
    let mut out = String::new();
    writeln!(out, "[ti:{title}]")?;
    writeln!(out, "[by:StemScribe v{}]", env!("CARGO_PKG_VERSION"))?;
    for line in lines {
        writeln!(out, "{}{}", format_lrc_timestamp(line.start_sec), line.text.trim())?;
    }
    let path = Path::new(save_path);
    std::fs::write(path, out)?;
    Ok(path.to_string_lossy().to_string())
}

fn parse_lrc_tag_seconds(tag: &str) -> Option<f64> {
    let parts: Vec<&str> = tag.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let mins: f64 = parts[0].trim().parse().ok()?;
    let secs: f64 = parts[1].trim().parse().ok()?;
    if mins < 0.0 || secs < 0.0 {
        return None;
    }
    Some(mins * 60.0 + secs)
}

/// Parse standard `.lrc` text (supporting `[mm:ss.xx]`, `[mm:ss.xxx]`, `[mm:ss]` and multi-timestamp lines).
pub fn parse_lrc_content(raw: &str) -> Vec<LyricLine> {
    let mut entries: Vec<(f64, String)> = Vec::new();
    for line in raw.lines() {
        let mut rest = line.trim();
        if rest.is_empty() {
            continue;
        }
        let mut timestamps = Vec::new();
        while rest.starts_with('[') {
            if let Some(close_idx) = rest.find(']') {
                let tag = &rest[1..close_idx];
                if let Some(sec) = parse_lrc_tag_seconds(tag) {
                    timestamps.push(sec);
                }
                rest = &rest[close_idx + 1..];
            } else {
                break;
            }
        }
        let text = rest.trim();
        if !timestamps.is_empty() && !text.is_empty() {
            for ts in timestamps {
                entries.push((ts, text.to_string()));
            }
        }
    }

    entries.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut out = Vec::with_capacity(entries.len());
    for i in 0..entries.len() {
        let start_sec = entries[i].0;
        let end_sec = if i + 1 < entries.len() {
            let next_start = entries[i + 1].0;
            if next_start > start_sec + 0.1 {
                next_start
            } else {
                start_sec + 2.5
            }
        } else {
            start_sec + 3.5
        };
        out.push(LyricLine {
            start_sec,
            end_sec,
            text: entries[i].1.clone(),
        });
    }
    out
}

pub fn read_lrc_file(file_path: &str) -> Result<Vec<LyricLine>> {
    let raw = std::fs::read_to_string(file_path)
        .map_err(|e| anyhow!("无法读取 LRC 歌词文件 ({file_path}): {e}"))?;
    let lines = parse_lrc_content(&raw);
    if lines.is_empty() {
        return Err(anyhow!("未在 LRC 文件中解析到有效的时间戳歌词行"));
    }
    Ok(lines)
}

pub fn format_srt_timestamp(sec: f64) -> String {
    let total_ms = (sec.max(0.0) * 1000.0).round() as u64;
    let hours = total_ms / 3_600_000;
    let mins = (total_ms % 3_600_000) / 60_000;
    let secs = (total_ms % 60_000) / 1000;
    let ms = total_ms % 1000;
    format!("{hours:02}:{mins:02}:{secs:02},{ms:03}")
}

pub fn write_srt_file(lines: &[LyricLine], save_path: &str) -> Result<String> {
    let mut out = String::new();
    for (idx, line) in lines.iter().enumerate() {
        let start = line.start_sec.max(0.0);
        let end = if line.end_sec > start + 0.05 {
            line.end_sec
        } else {
            start + 2.5
        };
        writeln!(out, "{}", idx + 1)?;
        writeln!(
            out,
            "{} --> {}",
            format_srt_timestamp(start),
            format_srt_timestamp(end)
        )?;
        writeln!(out, "{}", line.text.trim())?;
        writeln!(out)?;
    }
    let path = Path::new(save_path);
    std::fs::write(path, out)?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lrc_timestamp_formatting() {
        assert_eq!(format_lrc_timestamp(0.0), "[00:00.00]");
        assert_eq!(format_lrc_timestamp(65.5), "[01:05.50]");
    }

    #[test]
    fn test_extract_json_array() {
        let raw = "```json\n[{\"start_sec\":0.0,\"end_sec\":2.5,\"text\":\"Hello\"}]\n```";
        let arr = extract_json_array(raw);
        let parsed: Vec<LyricLine> = serde_json::from_str(arr).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].text, "Hello");
    }

    #[test]
    fn test_parse_lrc_multi_timestamp() {
        let lrc = "[ti:Test]\n[00:10.50][01:02.25]副歌重复句\n[00:04.00]第一句主歌\n";
        let lines = parse_lrc_content(lrc);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].text, "第一句主歌");
        assert!((lines[0].start_sec - 4.0).abs() < 1e-6);
        assert!((lines[0].end_sec - 10.5).abs() < 1e-6);
        assert_eq!(lines[1].text, "副歌重复句");
        assert!((lines[2].start_sec - 62.25).abs() < 1e-6);
    }

    #[test]
    fn test_srt_timestamp_and_export() {
        assert_eq!(format_srt_timestamp(0.0), "00:00:00,000");
        assert_eq!(format_srt_timestamp(65.432), "00:01:05,432");
        let tmp = std::env::temp_dir().join("stemscribe_test_subs.srt");
        let lines = vec![LyricLine {
            start_sec: 1.25,
            end_sec: 4.5,
            text: "星海漫游".to_string(),
        }];
        let saved = write_srt_file(&lines, tmp.to_str().unwrap()).unwrap();
        let content = std::fs::read_to_string(&saved).unwrap();
        assert!(content.contains("00:00:01,250 --> 00:00:04,500"));
        assert!(content.contains("星海漫游"));
        let _ = std::fs::remove_file(tmp);
    }
}
