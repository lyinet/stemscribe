//! 多轮自动修复（实验性）：LLM 参谋出方案 → 渲染 → 规则评分 + 安全门控，
//! 循环最多 N 轮，保留评分最低的合格结果。

use super::quality::diagnose::QualityReport;
use super::quality::objective;
use super::restore::{self, RestoreRequest, RestoreResult};
use crate::llm::advisor::{self, AdvisorChange, AdvisorInput, AdvisorLastResult};
use crate::llm::LlmRelayConfig;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

static AGENT_CANCEL: AtomicBool = AtomicBool::new(false);

/// Cooperative cancel: the loop finishes the current step, then stops and
/// keeps the best result so far.
pub fn cancel_agent() {
    AGENT_CANCEL.store(true, Ordering::SeqCst);
}

fn cancelled() -> bool {
    AGENT_CANCEL.load(Ordering::SeqCst)
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentProgress {
    pub round: usize,
    /// "prepare" | "advise" | "render" | "score"
    pub stage: String,
    pub percent: f32,
}

/// A previous RestoreResult the frontend can pass so round 0 doesn't
/// re-render (RestoreResult itself is Serialize-only).
#[derive(Debug, Clone, Deserialize)]
pub struct AgentBaseline {
    pub output_path: String,
    /// The result's `after` report.
    pub report: QualityReport,
    pub score: f64,
    #[serde(default)]
    pub terms: Vec<AgentTerm>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTerm {
    pub name: String,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentRoundRecord {
    pub round: usize,
    #[serde(default)]
    pub changes: Vec<AdvisorChange>,
    #[serde(default)]
    pub explanation: Vec<String>,
    #[serde(default)]
    pub confidence: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub terms: Option<Value>,
    pub accepted: bool,
    #[serde(default)]
    pub reject_reason: Option<String>,
    #[serde(default)]
    pub output_path: Option<String>,
    #[serde(default)]
    pub elapsed_ms: u64,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentResult {
    pub best: RestoreResult,
    pub best_round: usize,
    pub history: Vec<AgentRoundRecord>,
    pub stop_reason: String,
}

fn severity_rank(s: &str) -> u8 {
    match s {
        "bad" => 2,
        "warn" => 1,
        _ => 0,
    }
}

/// Acceptance guards for one round's render. Returns the rejection reasons
/// (empty = accepted).
/// - no issue may become worse than it was in the input report
///   (`lra_flat` exempt only when already present in the input);
/// - LRA_out >= LRA_in − 1.0;
/// - true peak <= ceiling;
/// - PQ_out >= PQ_in − 0.3 (only when the critic scored both).
pub(crate) fn guard_reasons(
    before: &QualityReport,
    after: &QualityReport,
    ceiling_dbtp: f64,
    pq_in: Option<f64>,
    pq_out: Option<f64>,
) -> Vec<String> {
    let mut reasons = Vec::new();
    let mut bmap = std::collections::HashMap::new();
    for i in &before.issues {
        bmap.insert(i.id.as_str(), severity_rank(&i.severity));
    }
    for i in &after.issues {
        let ar = severity_rank(&i.severity);
        if ar == 0 {
            continue;
        }
        let br = *bmap.get(i.id.as_str()).unwrap_or(&0);
        if ar > br {
            if i.id == "lra_flat" && br > 0 {
                continue;
            }
            let bname = match br {
                2 => "bad",
                1 => "warn",
                _ => "ok",
            };
            reasons.push(format!("问题加重：{}（{bname} → {}）", i.title, i.severity));
        }
    }
    if before.lra_lu.is_finite()
        && after.lra_lu.is_finite()
        && after.lra_lu < before.lra_lu - 1.0
    {
        reasons.push(format!(
            "动态被压平（LRA {:.1} → {:.1} LU）",
            before.lra_lu, after.lra_lu
        ));
    }
    if after.true_peak_dbtp > ceiling_dbtp {
        reasons.push(format!(
            "真峰值超限（{:.2} dBTP > {:.2}）",
            after.true_peak_dbtp, ceiling_dbtp
        ));
    }
    if let (Some(pin), Some(pout)) = (pq_in, pq_out) {
        if pout < pin - 0.3 {
            reasons.push(format!("AI 音质评分下降过多（PQ {pin:.2} → {pout:.2}）"));
        }
    }
    reasons
}

type GuardFn = dyn Fn(&QualityReport, &QualityReport, f64, Option<f64>, Option<f64>) -> Vec<String>
    + Send
    + Sync;

fn advisor_roles(req: &RestoreRequest) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    for st in &req.stems {
        let r = match restore::stem_role(st) {
            restore::StemRole::Lead => "lead_vocals",
            restore::StemRole::Backing => "backing_vocals",
            restore::StemRole::Drums => "drums",
            restore::StemRole::Perc => "percussion",
            restore::StemRole::Bass => "bass",
            restore::StemRole::Other => "other",
        }
        .to_string();
        if !v.contains(&r) {
            v.push(r);
        }
    }
    v
}

fn agent_out_path(source: &str, round: usize) -> String {
    let dir = restore::renders_dir().unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    let stem = Path::new(source)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("audio");
    // Same-named sources in different folders (and parallel agent runs)
    // must not share render files.
    let mut h = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(source, &mut h);
    let src_hash = std::hash::Hasher::finish(&h) as u32;
    dir.join(format!(
        "{stem}_agent_r{round}_{}_{src_hash:08x}.wav",
        std::process::id()
    ))
    .to_string_lossy()
    .to_string()
}

fn result_from_baseline(
    ctx: &restore::RestoreCtx,
    b: &AgentBaseline,
) -> RestoreResult {
    RestoreResult {
        output_path: b.output_path.clone(),
        sample_rate: b.report.sample_rate,
        bit_depth: b.report.bit_depth.unwrap_or(24),
        before: ctx.before.clone(),
        after: b.report.clone(),
        loudness_match_db: ctx.before.integrated_lufs - b.report.integrated_lufs,
        limiter_avg_gr_db: 0.0,
        notes: vec![],
        elapsed_ms: 0,
        reference: None,
        objective: Some(objective::ObjectiveScore {
            score: b.score,
            terms: b
                .terms
                .iter()
                .map(|t| objective::ObjectiveTerm {
                    name: t.name.clone(),
                    value: t.value,
                })
                .collect(),
        }),
        critic: None,
        critic_before: None,
        guard_rung: None,
    }
}

pub async fn run_restore_agent<E>(
    config: &LlmRelayConfig,
    req: &RestoreRequest,
    user_request: &str,
    baseline: Option<AgentBaseline>,
    max_rounds: usize,
    emit: E,
) -> Result<AgentResult>
where
    E: FnMut(AgentProgress) + Send + 'static,
{
    run_agent_inner(
        config,
        req,
        user_request,
        baseline,
        max_rounds.clamp(1, 8),
        emit,
        &guard_reasons,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_agent_inner<E>(
    config: &LlmRelayConfig,
    req: &RestoreRequest,
    user_request: &str,
    baseline: Option<AgentBaseline>,
    max_rounds: usize,
    emit: E,
    guard: &GuardFn,
) -> Result<AgentResult>
where
    E: FnMut(AgentProgress) + Send + 'static,
{
    AGENT_CANCEL.store(false, Ordering::SeqCst);
    let emit = Arc::new(Mutex::new(emit));
    let total = (max_rounds + 1) as f32;
    let prog = |round: usize, stage: &str, frac: f32| {
        let pct = ((round as f32 + frac) / total * 100.0).min(99.0);
        if let Ok(mut e) = emit.lock() {
            e(AgentProgress {
                round,
                stage: stage.to_string(),
                percent: pct,
            });
        }
    };

    // ---- shared prepare: source decode + diagnosis + stem PCM cache ----
    prog(0, "prepare", 0.0);
    let mut prep_req = req.clone();
    // Load the drum kit once so any round may enable drum_replace.
    prep_req.settings.modules.drum_replace = true;
    let e2 = emit.clone();
    let ctx = tokio::task::spawn_blocking(move || {
        let mut inner = move |stage: &str, pct: f32| {
            if let Ok(mut e) = e2.lock() {
                e(AgentProgress {
                    round: 0,
                    stage: stage.to_string(),
                    percent: pct * 0.05,
                });
            }
        };
        restore::prepare_restore(&prep_req, &mut inner, true)
    })
    .await
    .map_err(|e| anyhow::anyhow!("prepare task failed: {e}"))??;
    let ctx = Arc::new(ctx);
    let before = ctx.before.clone();
    let input_pq = restore::critic_score_opt(&req.source_path).map(|c| c.pq as f64);
    let roles = advisor_roles(req);

    let render = |round: usize, rreq: RestoreRequest| {
        let ctx2 = ctx.clone();
        let e3 = emit.clone();
        tokio::task::spawn_blocking(move || {
            let t0 = Instant::now();
            let mut stage_emit = |stage: &str, pct: f32| {
                if let Ok(mut e) = e3.lock() {
                    e(AgentProgress {
                        round,
                        stage: stage.to_string(),
                        percent: ((round as f32 + pct / 100.0) / total * 100.0).min(99.0),
                    });
                }
            };
            let pq_in = || input_pq;
            restore::render_with_pq_guard(
                &ctx2,
                &rreq,
                &mut stage_emit,
                ctx2.notes.clone(),
                t0,
                &pq_in,
                &restore::critic_score_opt,
                true,
            )
        })
    };

    let mut history: Vec<AgentRoundRecord> = Vec::new();

    // ---- round 0: baseline ----
    let (mut best, mut best_score, mut last_report, mut last_score, mut last_terms) =
        if let Some(b) = &baseline {
            let res = result_from_baseline(&ctx, b);
            history.push(AgentRoundRecord {
                round: 0,
                changes: vec![],
                explanation: vec!["基线：使用当前结果".into()],
                confidence: None,
                score: Some(b.score),
                terms: Some(serde_json::to_value(&b.terms).unwrap_or_default()),
                accepted: true,
                reject_reason: None,
                output_path: Some(b.output_path.clone()),
                elapsed_ms: 0,
                error: None,
            });
            (
                res,
                b.score,
                b.report.clone(),
                b.score,
                serde_json::to_value(&b.terms).unwrap_or_default(),
            )
        } else {
            prog(0, "render", 0.02);
            let mut req0 = req.clone();
            req0.output_path = Some(agent_out_path(&req.source_path, 0));
            let res = render(0, req0)
                .await
                .map_err(|e| anyhow::anyhow!("render task failed: {e}"))??;
            let s0 = res
                .objective
                .as_ref()
                .map(|o| o.score)
                .unwrap_or(f64::MAX);
            let t0 = res
                .objective
                .as_ref()
                .map(|o| serde_json::to_value(&o.terms).unwrap_or_default())
                .unwrap_or_default();
            history.push(AgentRoundRecord {
                round: 0,
                changes: vec![],
                explanation: vec!["基线：当前参数渲染".into()],
                confidence: None,
                score: Some(s0),
                terms: Some(t0.clone()),
                accepted: true,
                reject_reason: None,
                output_path: Some(res.output_path.clone()),
                elapsed_ms: res.elapsed_ms,
                error: None,
            });
            (res.clone(), s0, res.after.clone(), s0, t0)
        };

    let mut best_round = 0usize;
    let mut best_settings = req.settings.clone();
    let mut stop_reason = "max_rounds".to_string();
    let mut no_improve = 0usize;

    for k in 1..=max_rounds {
        if cancelled() {
            stop_reason = "cancelled".to_string();
            break;
        }
        if best_score <= 0.5 {
            stop_reason = "target_reached".to_string();
            break;
        }
        prog(k, "advise", 0.02);
        let input = AdvisorInput {
            report: before.clone(),
            stems: roles.clone(),
            current: best_settings.clone(),
            last_result: Some(AdvisorLastResult {
                report: last_report.clone(),
                score: last_score,
                terms: last_terms.clone(),
            }),
            user_request: user_request.to_string(),
        };
        let proposal = match advisor::advise_restoration(config, &input).await {
            Ok(p) => p,
            Err(e) => {
                history.push(AgentRoundRecord {
                    round: k,
                    changes: vec![],
                    explanation: vec![],
                    confidence: None,
                    score: None,
                    terms: None,
                    accepted: false,
                    reject_reason: None,
                    output_path: None,
                    elapsed_ms: 0,
                    error: Some(format!("AI 参谋调用失败：{e}")),
                });
                stop_reason = "advisor_error".to_string();
                break;
            }
        };
        if proposal.changes.is_empty() {
            history.push(AgentRoundRecord {
                round: k,
                changes: vec![],
                explanation: proposal.explanation.clone(),
                confidence: Some(proposal.confidence.clone()),
                score: None,
                terms: None,
                accepted: false,
                reject_reason: Some("AI 未给出参数变更".to_string()),
                output_path: None,
                elapsed_ms: 0,
                error: None,
            });
            stop_reason = "no_changes".to_string();
            break;
        }
        if cancelled() {
            stop_reason = "cancelled".to_string();
            break;
        }
        let mut req_k = req.clone();
        req_k.settings = proposal.settings.clone();
        req_k.output_path = Some(agent_out_path(&req.source_path, k));
        prog(k, "render", 0.05);
        let res = match render(k, req_k).await {
            Ok(joined) => match joined {
                Ok(r) => r,
                Err(e) => {
                    history.push(AgentRoundRecord {
                        round: k,
                        changes: proposal.changes.clone(),
                        explanation: proposal.explanation.clone(),
                        confidence: Some(proposal.confidence.clone()),
                        score: None,
                        terms: None,
                        accepted: false,
                        reject_reason: None,
                        output_path: None,
                        elapsed_ms: 0,
                        error: Some(format!("渲染失败：{e}")),
                    });
                    stop_reason = "render_error".to_string();
                    break;
                }
            },
            Err(e) => {
                stop_reason = "render_error".to_string();
                history.push(AgentRoundRecord {
                    round: k,
                    changes: proposal.changes.clone(),
                    explanation: proposal.explanation.clone(),
                    confidence: Some(proposal.confidence.clone()),
                    score: None,
                    terms: None,
                    accepted: false,
                    reject_reason: None,
                    output_path: None,
                    elapsed_ms: 0,
                    error: Some(format!("渲染任务异常：{e}")),
                });
                break;
            }
        };
        prog(k, "score", 0.95);
        let score = res
            .objective
            .as_ref()
            .map(|o| o.score)
            .unwrap_or(f64::MAX);
        let terms = res
            .objective
            .as_ref()
            .map(|o| serde_json::to_value(&o.terms).unwrap_or_default())
            .unwrap_or_default();
        let pq_out = res.critic.as_ref().map(|c| c.pq as f64);
        let reasons = guard(
            &before,
            &res.after,
            req.settings.ceiling_dbtp as f64,
            input_pq,
            pq_out,
        );
        let accepted = reasons.is_empty();
        history.push(AgentRoundRecord {
            round: k,
            changes: proposal.changes.clone(),
            explanation: proposal.explanation.clone(),
            confidence: Some(proposal.confidence.clone()),
            score: Some(score),
            terms: Some(terms.clone()),
            accepted,
            reject_reason: if accepted {
                None
            } else {
                Some(reasons.join("；"))
            },
            output_path: Some(res.output_path.clone()),
            elapsed_ms: res.elapsed_ms,
            error: None,
        });
        last_report = res.after.clone();
        last_score = score;
        last_terms = terms;

        if accepted && score < best_score {
            let improvement = best_score - score;
            best = res.clone();
            best_score = score;
            best_round = k;
            best_settings = proposal.settings.clone();
            no_improve = if improvement >= 0.1 { 0 } else { no_improve + 1 };
        } else {
            no_improve += 1;
        }
        if best_score <= 0.5 {
            stop_reason = "target_reached".to_string();
            break;
        }
        if no_improve >= 2 {
            stop_reason = "no_improvement".to_string();
            break;
        }
    }

    // Delete non-best render files (baseline round-0 output is always kept).
    for rec in &history {
        if rec.round == 0 {
            continue;
        }
        if let Some(p) = &rec.output_path {
            if p != &best.output_path {
                let _ = std::fs::remove_file(p);
            }
        }
    }
    if let Ok(mut e) = emit.lock() {
        e(AgentProgress {
            round: best_round,
            stage: "done".to_string(),
            percent: 100.0,
        });
    }

    Ok(AgentResult {
        best,
        best_round,
        history,
        stop_reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::quality::diagnose::{Issue, QualityReport};
    use crate::llm::RelayProtocol;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn issue(id: &str, sev: &str) -> Issue {
        Issue {
            id: id.into(),
            severity: sev.into(),
            title: id.into(),
            detail: String::new(),
        }
    }

    fn rep(lra: f64, tp: f64, issues: Vec<Issue>) -> QualityReport {
        QualityReport {
            sample_rate: 44100,
            channels: 2,
            bit_depth: Some(24),
            duration_sec: 2.0,
            integrated_lufs: -14.0,
            lra_lu: lra,
            true_peak_dbtp: tp,
            sample_peak_dbfs: tp,
            cutoff_hz: None,
            low_mid_excess_db: 0.0,
            low_mid_center_hz: 0.0,
            harsh_peaks: vec![],
            stereo_correlation: 0.9,
            side_mid_ratio_db: -10.0,
            low_band_correlation: 0.9,
            clipped_runs: 0,
            dc_offset: [0.0, 0.0],
            ltas: vec![],
            issues,
        }
    }

    #[test]
    fn guard_rejects_worsening_issue() {
        let before = rep(5.0, -3.0, vec![issue("harsh_peaks", "warn")]);
        let after = rep(5.0, -3.0, vec![issue("harsh_peaks", "bad")]);
        let r = guard_reasons(&before, &after, -1.0, None, None);
        assert_eq!(r.len(), 1);
        // Same severity is fine.
        let after2 = rep(5.0, -3.0, vec![issue("harsh_peaks", "warn")]);
        assert!(guard_reasons(&before, &after2, -1.0, None, None).is_empty());
        // A brand-new warn counts (input severity was ok).
        let after3 = rep(5.0, -3.0, vec![issue("harsh_peaks", "warn"), issue("dc", "warn")]);
        assert_eq!(guard_reasons(&before, &after3, -1.0, None, None).len(), 1);
    }

    #[test]
    fn guard_lra_flat_exempt_only_if_in_input() {
        let before = rep(3.0, -3.0, vec![issue("lra_flat", "warn")]);
        let after = rep(3.0, -3.0, vec![issue("lra_flat", "bad")]);
        assert!(guard_reasons(&before, &after, -1.0, None, None).is_empty());
        // New lra_flat is NOT exempt.
        let before2 = rep(6.0, -3.0, vec![]);
        let after2 = rep(3.0, -3.0, vec![issue("lra_flat", "warn")]);
        let r = guard_reasons(&before2, &after2, -1.0, None, None);
        assert!(r.iter().any(|s| s.contains("问题加重")));
    }

    #[test]
    fn guard_lra_tp_pq_rules() {
        let before = rep(5.0, -3.0, vec![]);
        // LRA drop > 1.0
        let r = guard_reasons(&before, &rep(3.9, -3.0, vec![]), -1.0, None, None);
        assert!(r.iter().any(|s| s.contains("动态被压平")));
        // TP over ceiling
        let r = guard_reasons(&before, &rep(5.0, -0.5, vec![]), -1.0, None, None);
        assert!(r.iter().any(|s| s.contains("真峰值")));
        // PQ drop > 0.3
        let r = guard_reasons(&before, &rep(5.0, -3.0, vec![]), -1.0, Some(8.0), Some(7.5));
        assert!(r.iter().any(|s| s.contains("PQ")));
        // Small PQ drop is fine
        let r = guard_reasons(&before, &rep(5.0, -3.0, vec![]), -1.0, Some(8.0), Some(7.8));
        assert!(r.is_empty());
    }

    /// Sequential one-shot stub: serves `responses[i]` on the i-th request.
    async fn stub_server(responses: Vec<String>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for resp_body in responses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 65536];
                let mut req = Vec::new();
                // Read headers + full body per Content-Length.
                loop {
                    let n = sock.read(&mut buf).await.unwrap();
                    req.extend_from_slice(&buf[..n]);
                    let t = String::from_utf8_lossy(&req);
                    if let Some(h) = t.find("\r\n\r\n") {
                        let len: usize = t[..h]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse().ok())
                            })
                            .unwrap_or(0);
                        if t.len() - (h + 4) >= len {
                            break;
                        }
                    }
                }
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    resp_body.len(),
                    resp_body
                );
                sock.write_all(resp.as_bytes()).await.unwrap();
            }
        });
        format!("http://{addr}")
    }

    fn openai_wrap(inner_json: &str) -> String {
        json!({
            "choices": [{"message": {"content": inner_json}}]
        })
        .to_string()
    }

    fn mk_config(url: &str) -> LlmRelayConfig {
        LlmRelayConfig {
            base_url: url.into(),
            api_key: "k".into(),
            model: "m".into(),
            protocol: RelayProtocol::OpenaiInputAudio,
        }
    }

    /// Constant-amplitude sine: gives a real (non-NaN) report; its flat LRA
    /// shows up as `lra_flat` in both before and after, so renders stay
    /// accepted with S >= 1 (never early-stops on target_reached).
    fn write_sine(path: &Path, dur_s: f64, sr: u32) {
        let n = (dur_s * sr as f64) as usize;
        let w = 2.0 * std::f32::consts::PI * 440.0 / sr as f32;
        let s: Vec<f32> = (0..n).map(|i| (i as f32 * w).sin() * 0.2).collect();
        crate::audio::write_stereo_wav_f32(path, &s, &s, sr).unwrap();
    }

    /// Baseline with a fabricated high score so round-1 renders beat it.
    fn fake_baseline(score: f64) -> AgentBaseline {
        AgentBaseline {
            output_path: "/tmp/ss_agent_baseline_prev.wav".into(),
            report: rep(4.0, -2.0, vec![issue("harsh_peaks", "warn")]),
            score,
            terms: vec![],
        }
    }

    fn events_sink() -> (Arc<Mutex<Vec<AgentProgress>>>, impl FnMut(AgentProgress) + Send + 'static) {
        let v = Arc::new(Mutex::new(Vec::<AgentProgress>::new()));
        let v2 = v.clone();
        (v, move |p| v2.lock().unwrap().push(p))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn improves_then_no_changes_stops() {
        let dir = std::env::temp_dir().join(format!("ss_agent_a_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.wav");
        write_sine(&src, 2.0, 44100);
        let url = stub_server(vec![
            openai_wrap("{\"settings\":{\"low_shelf_db\":1},\"explanation\":[\"补低频\"],\"confidence\":\"medium\"}"),
            openai_wrap("{\"settings\":{},\"explanation\":[\"已经很好\"],\"confidence\":\"high\"}"),
        ])
        .await;
        let req = RestoreRequest {
            source_path: src.to_string_lossy().to_string(),
            stems: vec![],
            settings: Default::default(),
            output_path: None,
        };
        let (_ev, emit) = events_sink();
        let res = run_restore_agent(
            &mk_config(&url),
            &req,
            "测试",
            Some(fake_baseline(100.0)),
            3,
            emit,
        )
        .await
        .unwrap();
        assert_eq!(res.stop_reason, "no_changes");
        assert_eq!(res.best_round, 1);
        assert_eq!(res.history.len(), 3); // r0 + r1 + no-change r2
        assert!(res.history[2].reject_reason.is_some());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn guard_rejected_round_keeps_baseline() {
        let dir = std::env::temp_dir().join(format!("ss_agent_b_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.wav");
        write_sine(&src, 2.0, 44100);
        let url = stub_server(vec![
            openai_wrap("{\"settings\":{\"high_shelf_db\":3},\"explanation\":[\"增亮\"],\"confidence\":\"low\"}"),
            openai_wrap("{\"settings\":{},\"explanation\":[],\"confidence\":\"low\"}"),
        ])
        .await;
        let req = RestoreRequest {
            source_path: src.to_string_lossy().to_string(),
            stems: vec![],
            settings: Default::default(),
            output_path: None,
        };
        let (_ev, emit) = events_sink();
        // Test hook: every rendered round fails the guard.
        let guard = |_b: &QualityReport, _a: &QualityReport, _c: f64, _i: Option<f64>, _o: Option<f64>| {
            vec!["测试注入：门控失败".to_string()]
        };
        let res = run_agent_inner(&mk_config(&url), &req, "测试", None, 2, emit, &guard)
            .await
            .unwrap();
        assert_eq!(res.best_round, 0, "rejected round must not become best");
        assert_eq!(
            res.history[1].reject_reason.as_deref(),
            Some("测试注入：门控失败")
        );
        assert!(!res.history[1].accepted);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn advisor_error_keeps_best() {
        let dir = std::env::temp_dir().join(format!("ss_agent_c_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.wav");
        write_sine(&src, 2.0, 44100);
        let url = stub_server(vec![
            openai_wrap("{\"settings\":{\"low_shelf_db\":1},\"explanation\":[\"补低频\"],\"confidence\":\"medium\"}"),
            openai_wrap("这不是 JSON 完全是废话"),
        ])
        .await;
        let req = RestoreRequest {
            source_path: src.to_string_lossy().to_string(),
            stems: vec![],
            settings: Default::default(),
            output_path: None,
        };
        let (_ev, emit) = events_sink();
        let res = run_restore_agent(
            &mk_config(&url),
            &req,
            "测试",
            Some(fake_baseline(100.0)),
            3,
            emit,
        )
        .await
        .unwrap();
        assert_eq!(res.stop_reason, "advisor_error");
        assert_eq!(res.best_round, 1, "best stays the last accepted round");
        assert!(res.history.last().unwrap().error.is_some());
    }
}
