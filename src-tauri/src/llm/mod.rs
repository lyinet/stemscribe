pub mod lyrics;

use crate::audio::{decode_audio_file, resample_linear};
use crate::ml::transcriber::MidiNote;
use anyhow::{anyhow, Context, Result};
use base64::Engine;
use hound::{SampleFormat, WavSpec, WavWriter};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Cursor;

const RELAY_TARGET_SR: u32 = 16_000;
const MAX_RELAY_AUDIO_SEC: f64 = 90.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayProtocol {
    OpenaiInputAudio,
    OpenaiAudioUrl,
    GeminiCompatible,
    TextOnlyMidi,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmRelayConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub protocol: RelayProtocol,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SongSection {
    pub label: String,
    pub time_range: String,
    pub chords: String,
    pub arrangement_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArrangementAnalysis {
    pub key_signature: String,
    pub genre_and_mood: String,
    pub instruments: Vec<String>,
    pub sections: Vec<SongSection>,
    pub practice_tips: Vec<String>,
    pub raw_markdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefinedScoreResponse {
    pub summary: String,
    pub guitar_fingering_tips: Vec<String>,
    pub cleaned_notes: Vec<MidiNote>,
}

pub(crate) fn encode_relay_audio_wav_b64(
    audio_path: &str,
    slice_start_sec: Option<f64>,
    slice_end_sec: Option<f64>,
) -> Result<String> {
    let decoded = decode_audio_file(audio_path)?;
    let mono = decoded.to_mono();
    let sr = decoded.sample_rate.max(1) as f64;

    let start_s = slice_start_sec.unwrap_or(0.0).max(0.0);
    let max_end = (start_s + MAX_RELAY_AUDIO_SEC).min(decoded.duration_sec());
    let end_s = slice_end_sec
        .map(|e| e.min(max_end))
        .unwrap_or(max_end)
        .max(start_s + 0.5);

    let start_idx = ((start_s * sr) as usize).min(mono.len());
    let end_idx = ((end_s * sr) as usize).min(mono.len());
    let slice = &mono[start_idx..end_idx];

    let resampled = resample_linear(slice, decoded.sample_rate, RELAY_TARGET_SR);

    let mut wav_buf = Cursor::new(Vec::<u8>::new());
    {
        let spec = WavSpec {
            channels: 1,
            sample_rate: RELAY_TARGET_SR,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::new(&mut wav_buf, spec)?;
        for &s in &resampled {
            let sample = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            writer.write_sample(sample)?;
        }
        writer.finalize()?;
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(wav_buf.into_inner()))
}

fn openai_endpoint(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

pub async fn test_relay_connection(config: &LlmRelayConfig) -> Result<String> {
    if config.base_url.trim().is_empty() || config.api_key.trim().is_empty() {
        return Err(anyhow!("请先填写中转平台的 Base URL 和 API Key"));
    }

    let client = Client::new();
    let base = config.base_url.trim_end_matches('/');

    match config.protocol {
        RelayProtocol::GeminiCompatible => {
            let endpoint = format!(
                "{base}/v1beta/models/{}:generateContent?key={}",
                config.model, config.api_key
            );
            let payload = json!({
                "contents": [{ "role": "user", "parts": [{ "text": "Reply OK only." }] }],
                "generationConfig": { "maxOutputTokens": 16 }
            });
            let resp = client.post(&endpoint).json(&payload).send().await?;
            let status = resp.status();
            let body: Value = resp.json().await?;
            if !status.is_success() {
                return Err(anyhow!("连接失败 ({status}): {body}"));
            }
            Ok(format!("连接成功 (Gemini 中转 · {})", config.model))
        }
        _ => {
            let endpoint = openai_endpoint(base);
            let payload = json!({
                "model": config.model,
                "max_tokens": 16,
                "messages": [{ "role": "user", "content": "Reply OK only." }]
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
                return Err(anyhow!("连接失败 ({status}): {body}"));
            }
            Ok(format!("连接成功 (OpenAI 兼容中转 · {})", config.model))
        }
    }
}

async fn send_multimodal_request(
    config: &LlmRelayConfig,
    system_prompt: &str,
    user_text: &str,
    audio_b64: Option<&str>,
) -> Result<String> {
    if config.base_url.trim().is_empty() || config.api_key.trim().is_empty() {
        return Err(anyhow!("请先在设置中填写第三方中转平台的 Base URL 和 API Key"));
    }

    let client = Client::new();
    let base = config.base_url.trim_end_matches('/');

    match config.protocol {
        RelayProtocol::OpenaiInputAudio | RelayProtocol::OpenaiAudioUrl | RelayProtocol::TextOnlyMidi => {
            let endpoint = openai_endpoint(base);

            let user_content: Value = match (&config.protocol, audio_b64) {
                (RelayProtocol::OpenaiInputAudio, Some(b64)) => json!([
                    { "type": "text", "text": user_text },
                    {
                        "type": "input_audio",
                        "input_audio": { "data": b64, "format": "wav" }
                    }
                ]),
                (RelayProtocol::OpenaiAudioUrl, Some(b64)) => json!([
                    { "type": "text", "text": user_text },
                    {
                        "type": "audio_url",
                        "audio_url": { "url": format!("data:audio/wav;base64,{b64}") }
                    }
                ]),
                _ => json!(user_text),
            };

            let payload = json!({
                "model": config.model,
                "temperature": 0.2,
                "messages": [
                    { "role": "system", "content": system_prompt },
                    { "role": "user", "content": user_content }
                ]
            });

            let resp = client
                .post(&endpoint)
                .bearer_auth(&config.api_key)
                .json(&payload)
                .send()
                .await
                .with_context(|| format!("Request to relay failed: {endpoint}"))?;

            let status = resp.status();
            let body: Value = resp.json().await?;
            if !status.is_success() {
                return Err(anyhow!("中转平台返回错误 ({status}): {body}"));
            }

            body["choices"][0]["message"]["content"]
                .as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| anyhow!("无法解析中转平台返回的 content 字段"))
        }
        RelayProtocol::GeminiCompatible => {
            let endpoint = format!(
                "{base}/v1beta/models/{}:generateContent?key={}",
                config.model, config.api_key
            );
            let mut parts = vec![json!({ "text": user_text })];
            if let Some(b64) = audio_b64 {
                parts.push(json!({
                    "inline_data": {
                        "mime_type": "audio/wav",
                        "data": b64
                    }
                }));
            }

            let payload = json!({
                "system_instruction": { "parts": [{ "text": system_prompt }] },
                "contents": [{ "role": "user", "parts": parts }],
                "generationConfig": { "temperature": 0.2 }
            });

            let resp = client.post(&endpoint).json(&payload).send().await?;
            let status = resp.status();
            let body: Value = resp.json().await?;
            if !status.is_success() {
                return Err(anyhow!("Gemini 中转接口返回错误 ({status}): {body}"));
            }

            body["candidates"][0]["content"]["parts"][0]["text"]
                .as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| anyhow!("无法解析 Gemini 中转返回的文本内容"))
        }
    }
}

pub async fn analyze_arrangement(
    audio_path: &str,
    bpm: Option<f32>,
    slice_start_sec: Option<f64>,
    slice_end_sec: Option<f64>,
    config: &LlmRelayConfig,
) -> Result<ArrangementAnalysis> {
    let audio_b64 = if matches!(config.protocol, RelayProtocol::TextOnlyMidi) {
        None
    } else {
        let p = audio_path.to_string();
        let encoded = tokio::task::spawn_blocking(move || {
            encode_relay_audio_wav_b64(&p, slice_start_sec, slice_end_sec)
        })
        .await
        .map_err(|e| anyhow!("Audio encode task error: {e}"))??;
        Some(encoded)
    };

    let system_prompt = "你是一位资深编曲人与音乐扒带专家。请结合音频内容输出严格 JSON，包含字段：key_signature (string), genre_and_mood (string), instruments (string[]), sections ({label, time_range, chords, arrangement_note}[]), practice_tips (string[])。不要输出多余解释。";
    let range_note = match (slice_start_sec, slice_end_sec) {
        (Some(a), Some(b)) => format!("当前分析片段为 {a:.1}s - {b:.1}s。"),
        _ => "当前分析为整曲（已自动压缩至 16kHz 单声道 WAV，最长 90s）。".to_string(),
    };
    let user_text = format!(
        "请深度拆解这段音频的调性、曲风情绪、配器编制、段落和弦进行及扒带练琴要点。{range_note} 参考测速 BPM: {}。",
        bpm.map(|v| format!("{v:.1}")).unwrap_or_else(|| "未知".to_string())
    );

    let raw = send_multimodal_request(config, system_prompt, &user_text, audio_b64.as_deref()).await?;
    let json_slice = extract_json_block(&raw);

    if let Ok(mut parsed) = serde_json::from_str::<ArrangementAnalysis>(json_slice) {
        parsed.raw_markdown = raw;
        return Ok(parsed);
    }

    Ok(ArrangementAnalysis {
        key_signature: "待确认".to_string(),
        genre_and_mood: "已生成文本分析".to_string(),
        instruments: vec![],
        sections: vec![],
        practice_tips: vec![],
        raw_markdown: raw,
    })
}

pub async fn refine_midi_score(
    audio_path: &str,
    notes: &[MidiNote],
    instrument: &str,
    user_prompt: Option<&str>,
    slice_start_sec: Option<f64>,
    slice_end_sec: Option<f64>,
    config: &LlmRelayConfig,
) -> Result<RefinedScoreResponse> {
    let audio_b64 = if matches!(config.protocol, RelayProtocol::TextOnlyMidi) {
        None
    } else {
        let p = audio_path.to_string();
        let encoded = tokio::task::spawn_blocking(move || {
            encode_relay_audio_wav_b64(&p, slice_start_sec, slice_end_sec)
        })
        .await
        .map_err(|e| anyhow!("Audio encode task error: {e}"))??;
        Some(encoded)
    };

    let sample_notes: Vec<&MidiNote> = notes.iter().take(120).collect();
    let notes_json = serde_json::to_string(&sample_notes)?;

    let system_prompt = "你是专业乐理校对与吉他/钢琴编配助手。请结合音频与初版 AI 扒出的 MIDI 音符，过滤明显离调杂音与极短鬼音，修正休止与时值，并输出严格 JSON：{summary: string, guitar_fingering_tips: string[], cleaned_notes: MidiNote[]}。";
    let extra = user_prompt.unwrap_or("请优化主旋律连贯性，并给出更顺手的吉他把位建议。");
    let user_text = format!(
        "目标乐器: {instrument}\n用户要求: {extra}\n初版 MIDI 音符(JSON): {notes_json}"
    );

    let raw = send_multimodal_request(config, system_prompt, &user_text, audio_b64.as_deref()).await?;
    let json_slice = extract_json_block(&raw);

    match serde_json::from_str::<RefinedScoreResponse>(json_slice) {
        Ok(parsed) => Ok(parsed),
        Err(_) => Ok(RefinedScoreResponse {
            summary: raw,
            guitar_fingering_tips: vec![],
            cleaned_notes: notes.to_vec(),
        }),
    }
}

pub(crate) fn extract_json_block(text: &str) -> &str {
    if let Some(start) = text.find("```json") {
        let rest = &text[start + 7..];
        if let Some(end) = rest.find("```") {
            return rest[..end].trim();
        }
    }
    if let (Some(s), Some(e)) = (text.find('{'), text.rfind('}')) {
        if e > s {
            return &text[s..=e];
        }
    }
    text.trim()
}
