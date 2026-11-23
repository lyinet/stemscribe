//! AI 参谋：把客观诊断 + 当前参数 + 用户要求发给文本 LLM，
//! 解析返回的修复参数提案并合并到当前设置。
//! 只做文本请求 —— 无论什么协议都不附带音频。

use super::{send_multimodal_request, LlmRelayConfig};
use crate::audio::quality::diagnose::QualityReport;
use crate::audio::restore::RestoreSettings;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const SYSTEM_PROMPT: &str = include_str!("prompts/restore_advisor.md");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvisorLastResult {
    pub report: QualityReport,
    pub score: f64,
    #[serde(default)]
    pub terms: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvisorInput {
    pub report: QualityReport,
    #[serde(default)]
    pub stems: Vec<String>,
    pub current: RestoreSettings,
    #[serde(default)]
    pub last_result: Option<AdvisorLastResult>,
    #[serde(default)]
    pub user_request: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvisorChange {
    pub field: String,
    pub label_zh: String,
    pub from: Value,
    pub to: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvisorResult {
    pub settings: RestoreSettings,
    pub changes: Vec<AdvisorChange>,
    pub explanation: Vec<String>,
    pub confidence: String,
    pub warnings: Vec<String>,
    pub raw: String,
}

#[derive(Clone, Copy)]
enum Kind {
    /// 0.5..1.5
    Strength,
    /// 0..1.5 module amount
    Amount,
    /// -3..+3 dB
    Db,
    /// -16..-9 LUFS
    Lufs,
    /// 0.3 / 0.5 / 0.8
    DrumAmount,
    /// boolean
    Flag,
}

struct Spec {
    name: &'static str,
    label: &'static str,
    kind: Kind,
    /// Requires stems; ignored (with warning) in mix-only mode.
    stem_only: bool,
}

const SPECS: &[Spec] = &[
    Spec { name: "strength", label: "整体强度", kind: Kind::Strength, stem_only: false },
    Spec { name: "vocal_cleanup", label: "人声清理", kind: Kind::Amount, stem_only: true },
    Spec { name: "shimmer", label: "金属声抑制", kind: Kind::Amount, stem_only: true },
    Spec { name: "drum_punch", label: "鼓瞬态", kind: Kind::Amount, stem_only: true },
    Spec { name: "low_end", label: "低频控制", kind: Kind::Amount, stem_only: false },
    Spec { name: "width", label: "立体声宽度", kind: Kind::Amount, stem_only: true },
    Spec { name: "vocal_space", label: "人声空间避让", kind: Kind::Amount, stem_only: true },
    Spec { name: "hf_restore", label: "高频补偿", kind: Kind::Amount, stem_only: false },
    Spec { name: "glue", label: "母带粘合", kind: Kind::Amount, stem_only: false },
    Spec { name: "vocal_level_db", label: "人声音量", kind: Kind::Db, stem_only: true },
    Spec { name: "vocal_presence_db", label: "人声清晰度", kind: Kind::Db, stem_only: true },
    Spec { name: "vocal_air_db", label: "人声空气感", kind: Kind::Db, stem_only: true },
    Spec { name: "low_shelf_db", label: "整体低频", kind: Kind::Db, stem_only: false },
    Spec { name: "high_shelf_db", label: "整体高频", kind: Kind::Db, stem_only: false },
    Spec { name: "target_lufs", label: "目标响度", kind: Kind::Lufs, stem_only: false },
    Spec { name: "drum_replace", label: "鼓替换", kind: Kind::Flag, stem_only: true },
    Spec { name: "drum_replace_amount", label: "鼓替换比例", kind: Kind::DrumAmount, stem_only: true },
];

fn spec_for(name: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|s| s.name == name)
}

/// Flat field names as documented in the prompt's table.
fn current_flat(s: &RestoreSettings) -> Value {
    let m = &s.modules;
    json!({
        "strength": s.strength,
        "vocal_cleanup": m.vocal_cleanup,
        "shimmer": m.shimmer,
        "drum_punch": m.drum_punch,
        "low_end": m.low_end,
        "width": m.width,
        "vocal_space": m.vocal_space,
        "hf_restore": m.hf_restore,
        "glue": m.glue,
        "vocal_level_db": s.vocal_level_db,
        "vocal_presence_db": s.vocal_presence_db,
        "vocal_air_db": s.vocal_air_db,
        "low_shelf_db": s.low_shelf_db,
        "high_shelf_db": s.high_shelf_db,
        "target_lufs": s.target_lufs,
        "drum_replace": m.drum_replace,
        "drum_replace_amount": s.drum_replace_amount,
    })
}

fn field_value(s: &RestoreSettings, name: &str) -> Option<Value> {
    let m = &s.modules;
    Some(match name {
        "strength" => json!(s.strength),
        "vocal_cleanup" => json!(m.vocal_cleanup),
        "shimmer" => json!(m.shimmer),
        "drum_punch" => json!(m.drum_punch),
        "low_end" => json!(m.low_end),
        "width" => json!(m.width),
        "vocal_space" => json!(m.vocal_space),
        "hf_restore" => json!(m.hf_restore),
        "glue" => json!(m.glue),
        "vocal_level_db" => json!(s.vocal_level_db),
        "vocal_presence_db" => json!(s.vocal_presence_db),
        "vocal_air_db" => json!(s.vocal_air_db),
        "low_shelf_db" => json!(s.low_shelf_db),
        "high_shelf_db" => json!(s.high_shelf_db),
        "target_lufs" => json!(s.target_lufs),
        "drum_replace" => json!(m.drum_replace),
        "drum_replace_amount" => json!(s.drum_replace_amount),
        _ => return None,
    })
}

fn set_field(s: &mut RestoreSettings, name: &str, v: &Value) {
    let m = &mut s.modules;
    match name {
        "strength" => s.strength = v.as_f64().unwrap_or(s.strength as f64) as f32,
        "vocal_cleanup" => m.vocal_cleanup = v.as_f64().unwrap_or(m.vocal_cleanup as f64) as f32,
        "shimmer" => m.shimmer = v.as_f64().unwrap_or(m.shimmer as f64) as f32,
        "drum_punch" => m.drum_punch = v.as_f64().unwrap_or(m.drum_punch as f64) as f32,
        "low_end" => m.low_end = v.as_f64().unwrap_or(m.low_end as f64) as f32,
        "width" => m.width = v.as_f64().unwrap_or(m.width as f64) as f32,
        "vocal_space" => m.vocal_space = v.as_f64().unwrap_or(m.vocal_space as f64) as f32,
        "hf_restore" => m.hf_restore = v.as_f64().unwrap_or(m.hf_restore as f64) as f32,
        "glue" => m.glue = v.as_f64().unwrap_or(m.glue as f64) as f32,
        "vocal_level_db" => s.vocal_level_db = v.as_f64().unwrap_or(s.vocal_level_db as f64) as f32,
        "vocal_presence_db" => {
            s.vocal_presence_db = v.as_f64().unwrap_or(s.vocal_presence_db as f64) as f32
        }
        "vocal_air_db" => s.vocal_air_db = v.as_f64().unwrap_or(s.vocal_air_db as f64) as f32,
        "low_shelf_db" => s.low_shelf_db = v.as_f64().unwrap_or(s.low_shelf_db as f64) as f32,
        "high_shelf_db" => s.high_shelf_db = v.as_f64().unwrap_or(s.high_shelf_db as f64) as f32,
        "target_lufs" => s.target_lufs = v.as_f64().unwrap_or(s.target_lufs),
        "drum_replace" => {
            if let Some(b) = v.as_bool() {
                m.drum_replace = b;
            }
        }
        "drum_replace_amount" => {
            s.drum_replace_amount = v.as_f64().unwrap_or(s.drum_replace_amount as f64) as f32
        }
        _ => {}
    }
}

/// QualityReport minus `ltas` (and any future per-window payloads).
fn report_for_llm(report: &QualityReport) -> Result<Value> {
    let mut v = serde_json::to_value(report)?;
    if let Some(o) = v.as_object_mut() {
        o.remove("ltas");
    }
    Ok(v)
}

/// The user message: one JSON object matching the prompt's 输入 section.
fn build_user_message(input: &AdvisorInput) -> Result<Value> {
    let mut msg = Map::new();
    msg.insert("report".to_string(), report_for_llm(&input.report)?);
    msg.insert(
        "stems".to_string(),
        Value::Array(input.stems.iter().map(|s| json!(s)).collect()),
    );
    msg.insert("current".to_string(), current_flat(&input.current));
    if let Some(lr) = &input.last_result {
        msg.insert(
            "last_result".to_string(),
            json!({
                "report": report_for_llm(&lr.report)?,
                "score": lr.score,
                "terms": lr.terms,
            }),
        );
    }
    msg.insert("user_request".to_string(), json!(input.user_request));
    Ok(Value::Object(msg))
}

fn strip_code_fences(text: &str) -> String {
    let mut out = String::new();
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// First balanced top-level `{...}` object, string/escape aware.
fn first_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let bytes = text.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for (i, &b) in bytes[start..].iter().enumerate() {
        if in_str {
            if esc {
                esc = false;
            } else if b == b'\\' {
                esc = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[start..start + i + 1]);
                }
            }
            _ => {}
        }
    }
    None
}

const DRUM_AMOUNTS: [f64; 3] = [0.3, 0.5, 0.8];

fn snap_drum_amount(v: f64) -> f64 {
    *DRUM_AMOUNTS
        .iter()
        .min_by(|a, b| {
            (v - **a)
                .abs()
                .partial_cmp(&(v - **b).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap()
}

fn fmt_num(v: f64) -> String {
    if (v - v.round()).abs() < 1e-9 {
        format!("{}", v.round() as i64)
    } else {
        format!("{v:.2}")
    }
}

#[derive(Debug)]
struct ParsedProposal {
    settings: RestoreSettings,
    changes: Vec<AdvisorChange>,
    explanation: Vec<String>,
    confidence: String,
    warnings: Vec<String>,
}

fn parse_proposal(raw: &str, current: &RestoreSettings, has_stems: bool) -> Result<ParsedProposal> {
    let cleaned = strip_code_fences(raw);
    let obj_str = first_json_object(&cleaned)
        .ok_or_else(|| anyhow!("AI 返回的内容无法解析（原始返回：{raw}）"))?;
    let parsed: Value = serde_json::from_str(obj_str)
        .map_err(|_| anyhow!("AI 返回的内容无法解析（原始返回：{raw}）"))?;
    let obj = parsed
        .as_object()
        .ok_or_else(|| anyhow!("AI 返回的内容无法解析（原始返回：{raw}）"))?;

    let mut warnings: Vec<String> = Vec::new();

    let explanation: Vec<String> = obj
        .get("explanation")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let confidence = match obj.get("confidence").and_then(|v| v.as_str()) {
        Some(c @ ("low" | "medium" | "high")) => c.to_string(),
        Some(other) => {
            warnings.push(format!("confidence 取值无效（{other}），已按 low 处理"));
            "low".to_string()
        }
        None => "low".to_string(),
    };

    let mut merged = current.clone();
    let mut changes: Vec<AdvisorChange> = Vec::new();

    if let Some(settings) = obj.get("settings") {
        let Some(sobj) = settings.as_object() else {
            return Err(anyhow!("AI 返回的内容无法解析（原始返回：{raw}）"));
        };
        for (name, val) in sobj {
            let Some(spec) = spec_for(name) else {
                warnings.push(format!("AI 返回了未知参数 {name}，已忽略"));
                continue;
            };
            if spec.stem_only && !has_stems {
                warnings
                    .push(format!("{}需要分轨才能生效，当前没有分轨，已忽略", spec.label));
                continue;
            }
            let clamped: Value = match spec.kind {
                Kind::Flag => match val.as_bool() {
                    Some(b) => json!(b),
                    None => {
                        warnings.push(format!("{}的值类型无效，已忽略", spec.label));
                        continue;
                    }
                },
                _ => {
                    let Some(num) = val.as_f64() else {
                        warnings.push(format!("{}的值类型无效，已忽略", spec.label));
                        continue;
                    };
                    let (c, lo, hi) = match spec.kind {
                        Kind::Strength => (num.clamp(0.5, 1.5), 0.5, 1.5),
                        Kind::Amount => (num.clamp(0.0, 1.5), 0.0, 1.5),
                        Kind::Db => (num.clamp(-3.0, 3.0), -3.0, 3.0),
                        Kind::Lufs => (num.clamp(-16.0, -9.0), -16.0, -9.0),
                        Kind::DrumAmount => (snap_drum_amount(num), 0.3, 0.8),
                        Kind::Flag => unreachable!(),
                    };
                    if (c - num).abs() > 1e-9 {
                        warnings.push(format!(
                            "{}超出范围（{}，允许 {}~{}），已调整为 {}",
                            spec.label,
                            fmt_num(num),
                            fmt_num(lo),
                            fmt_num(hi),
                            fmt_num(c)
                        ));
                    }
                    json!(c)
                }
            };
            let from = field_value(&merged, name).unwrap_or(Value::Null);
            if from != clamped {
                changes.push(AdvisorChange {
                    field: name.clone(),
                    label_zh: spec.label.to_string(),
                    from,
                    to: clamped.clone(),
                });
            }
            set_field(&mut merged, name, &clamped);
        }
    }

    Ok(ParsedProposal {
        settings: merged.clamped(),
        changes,
        explanation,
        confidence,
        warnings,
    })
}

pub async fn advise_restoration(
    config: &LlmRelayConfig,
    input: &AdvisorInput,
) -> Result<AdvisorResult> {
    if config.base_url.trim().is_empty() || config.api_key.trim().is_empty() {
        return Err(anyhow!("请先在设置中填写第三方中转平台的 Base URL 和 API Key"));
    }
    let user_msg = build_user_message(input)?.to_string();
    // Text only — audio_b64 is always None regardless of protocol.
    let raw = send_multimodal_request(config, SYSTEM_PROMPT, &user_msg, None).await?;
    let parsed = parse_proposal(&raw, &input.current, !input.stems.is_empty())?;
    Ok(AdvisorResult {
        settings: parsed.settings,
        changes: parsed.changes,
        explanation: parsed.explanation,
        confidence: parsed.confidence,
        warnings: parsed.warnings,
        raw,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::RelayProtocol;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn base_settings() -> RestoreSettings {
        RestoreSettings::default()
    }

    #[test]
    fn parses_fenced_json() {
        let raw = "```json\n{\"settings\":{\"vocal_presence_db\":1.5},\"explanation\":[\"人声偏闷\"],\"confidence\":\"high\"}\n```";
        let p = parse_proposal(raw, &base_settings(), true).unwrap();
        assert_eq!(p.settings.vocal_presence_db, 1.5);
        assert_eq!(p.explanation, vec!["人声偏闷".to_string()]);
        assert_eq!(p.confidence, "high");
        assert_eq!(p.changes.len(), 1);
        assert_eq!(p.changes[0].field, "vocal_presence_db");
    }

    #[test]
    fn parses_json_surrounded_by_prose() {
        let raw = "好的，这是我的建议：{\"settings\":{\"glue\":0.8},\"explanation\":[\"少一点粘合\"],\"confidence\":\"medium\"} 希望对你有帮助";
        let p = parse_proposal(raw, &base_settings(), true).unwrap();
        assert!((p.settings.modules.glue - 0.8).abs() < 1e-6);
        assert_eq!(p.confidence, "medium");
    }

    #[test]
    fn clamps_out_of_range_values() {
        let raw = "{\"settings\":{\"strength\":2.0,\"vocal_level_db\":9,\"target_lufs\":-20,\"drum_replace_amount\":0.7}}";
        let p = parse_proposal(raw, &base_settings(), true).unwrap();
        assert_eq!(p.settings.strength, 1.5);
        assert_eq!(p.settings.vocal_level_db, 3.0);
        assert_eq!(p.settings.target_lufs, -16.0);
        assert!((p.settings.drum_replace_amount - 0.8).abs() < 1e-6);
        assert!(p.warnings.len() >= 4, "warnings: {:?}", p.warnings);
    }

    #[test]
    fn drops_unknown_fields() {
        let raw = "{\"settings\":{\"reverb\":2,\"glue\":0.9}}";
        let p = parse_proposal(raw, &base_settings(), true).unwrap();
        assert!((p.settings.modules.glue - 0.9).abs() < 1e-6);
        assert!(p.warnings.iter().any(|w| w.contains("reverb")));
        assert_eq!(p.changes.len(), 1);
    }

    #[test]
    fn ignores_stem_fields_in_mix_only() {
        let raw = "{\"settings\":{\"vocal_presence_db\":2,\"drum_replace\":true,\"shimmer\":1.2,\"low_shelf_db\":-1,\"glue\":0.9}}";
        let p = parse_proposal(raw, &base_settings(), false).unwrap();
        assert_eq!(p.settings.vocal_presence_db, 0.0);
        assert!(!p.settings.modules.drum_replace);
        assert!((p.settings.modules.shimmer - 1.0).abs() < 1e-6);
        assert_eq!(p.settings.low_shelf_db, -1.0);
        assert!((p.settings.modules.glue - 0.9).abs() < 1e-6);
        assert!(p.warnings.iter().any(|w| w.contains("人声清晰度")));
        assert_eq!(p.changes.len(), 2);
    }

    #[test]
    fn garbage_is_a_parse_error() {
        let err = parse_proposal("今天天气不错，没有 JSON", &base_settings(), true)
            .unwrap_err();
        assert!(err.to_string().contains("AI 返回的内容无法解析"));
        let err = parse_proposal("{\"settings\": not json", &base_settings(), true)
            .unwrap_err();
        assert!(err.to_string().contains("AI 返回的内容无法解析"));
    }

    #[test]
    fn merges_only_proposed_fields() {
        let mut cur = base_settings();
        cur.vocal_level_db = 1.0;
        cur.low_shelf_db = -2.0;
        let raw = "{\"settings\":{\"high_shelf_db\":1.0}}";
        let p = parse_proposal(raw, &cur, true).unwrap();
        assert_eq!(p.settings.vocal_level_db, 1.0);
        assert_eq!(p.settings.low_shelf_db, -2.0);
        assert_eq!(p.settings.high_shelf_db, 1.0);
    }

    /// One-shot HTTP stub: capture the request body, reply with `resp_body`.
    async fn stub_server(resp_body: String) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}");
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            // Read until the body is complete per Content-Length.
            let body = loop {
                let n = sock.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf);
                if let Some(hdr_end) = text.find("\r\n\r\n") {
                    let headers = &text[..hdr_end];
                    let len: usize = headers
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse().ok())
                        })
                        .unwrap_or(0);
                    let have = text.len() - (hdr_end + 4);
                    if have >= len {
                        break text[hdr_end + 4..hdr_end + 4 + len].to_string();
                    }
                }
            };
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                resp_body.len(),
                resp_body
            );
            sock.write_all(resp.as_bytes()).await.unwrap();
            body
        });
        (url, handle)
    }

    fn fake_input() -> AdvisorInput {
        let report = QualityReport {
            sample_rate: 48000,
            channels: 2,
            bit_depth: Some(24),
            duration_sec: 100.0,
            integrated_lufs: -16.0,
            lra_lu: 4.0,
            true_peak_dbtp: -1.0,
            sample_peak_dbfs: -1.2,
            cutoff_hz: Some(16000.0),
            low_mid_excess_db: 2.0,
            low_mid_center_hz: 300.0,
            harsh_peaks: vec![],
            stereo_correlation: 0.9,
            side_mid_ratio_db: -10.0,
            low_band_correlation: 0.98,
            clipped_runs: 0,
            dc_offset: [0.0, 0.0],
            ltas: vec![crate::audio::quality::spectrum::BandLevel { hz: 1000.0, db: -20.0 }],
            issues: vec![],
        };
        AdvisorInput {
            report,
            stems: vec!["lead_vocals".into(), "drums".into()],
            current: base_settings(),
            last_result: None,
            user_request: "人声再亮一点".into(),
        }
    }

    #[tokio::test]
    async fn openai_wiring_text_only() {
        let resp = json!({
            "choices": [{
                "message": {"content": "{\"settings\":{\"vocal_presence_db\":1.5},\"explanation\":[\"提升人声清晰度\"],\"confidence\":\"medium\"}"}
            }]
        })
        .to_string();
        let (url, handle) = stub_server(resp).await;
        let config = LlmRelayConfig {
            base_url: url,
            api_key: "test-key".into(),
            model: "gpt-test".into(),
            protocol: RelayProtocol::OpenaiInputAudio, // audio protocol — must still send text only
        };
        let result = advise_restoration(&config, &fake_input()).await.unwrap();
        let body = handle.await.unwrap();
        assert!(!body.contains("input_audio"), "audio attached: {body}");
        assert!(!body.contains("audio_url"), "audio attached: {body}");
        assert!(body.contains("资深的混音与母带工程师"), "prompt missing");
        assert!(body.contains("integrated_lufs"), "report missing");
        assert!(body.contains("lead_vocals"), "stems missing");
        assert!(body.contains("人声再亮一点"), "user_request missing");
        assert!(!body.contains("ltas"), "ltas leaked into request");
        assert_eq!(result.settings.vocal_presence_db, 1.5);
        assert_eq!(result.confidence, "medium");
        assert_eq!(result.changes[0].label_zh, "人声清晰度");
    }

    #[tokio::test]
    async fn gemini_wiring_text_only() {
        let resp = json!({
            "candidates": [{
                "content": {"parts": [{"text": "{\"settings\":{\"low_shelf_db\":-1.5},\"explanation\":[\"减少低频轰感\"],\"confidence\":\"low\"}"}]}
            }]
        })
        .to_string();
        let (url, handle) = stub_server(resp).await;
        let config = LlmRelayConfig {
            base_url: url,
            api_key: "test-key".into(),
            model: "gemini-test".into(),
            protocol: RelayProtocol::GeminiCompatible,
        };
        let result = advise_restoration(&config, &fake_input()).await.unwrap();
        let body = handle.await.unwrap();
        assert!(!body.contains("inline_data"), "audio attached: {body}");
        assert!(body.contains("system_instruction"), "system prompt missing");
        assert!(body.contains("资深的混音与母带工程师"));
        assert!(body.contains("current"), "current settings missing");
        assert_eq!(result.settings.low_shelf_db, -1.5);
    }
}
