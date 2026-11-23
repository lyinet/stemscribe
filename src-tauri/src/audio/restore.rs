//! AI-song restoration render. Architecture: delta remix — process each stem
//! through its chain, sum the deltas, add to the pristine full-rate source,
//! then a master bus + true-peak limiter + loudness matching.

use super::dsp::biquad::{butter4_highpass, Biquad};
use super::dsp::dynamics::{Compressor, DynamicEqBand};
use super::dsp::limiter::limit_stereo;
use super::dsp::exciter::exciter_band;
use super::dsp::saturation::Saturator;
use super::dsp::spectral::SpectralSuppressor;
use super::dsp::stereo::{mono_below, widen_band};
use super::dsp::transient::TransientShaper;
use super::drum_hits;
use super::quality::spectrum::BandLevel;
use super::quality::{analyze_quality, loudness, QualityReport};
use super::resample::resample_hq_stereo;
use super::{decode_audio_file, write_stereo_wav_i24};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Instant;

#[derive(Debug, Clone, Deserialize)]
pub struct StemIn {
    pub name: String,
    pub file_path: String,
    /// Explicit role from the stems-import dialog: "lead" | "backing" |
    /// "drums" | "perc" | "bass" | "other"; empty = derive from `name`.
    #[serde(default)]
    pub role: String,
}

/// Stem roles the engine dispatches on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StemRole {
    Lead,
    Backing,
    Drums,
    Perc,
    Bass,
    Other,
}

fn name_has(n: &str, kws: &[&str]) -> bool {
    kws.iter().any(|k| n.contains(k))
}

/// Role for the stems-import dialog and file classification. Returns "mix"
/// for files that look like a full mix (no stem keyword, or mix/master/full
/// in the name). File name only (extension stripped), case-insensitive.
pub fn guess_stem_role(file_name: &str) -> &'static str {
    let stem = Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| file_name.to_lowercase());
    let n = stem.as_str();
    if name_has(n, &["mix", "master", "full"]) {
        return "mix";
    }
    if name_has(n, &["backing", "bgv", "chorus", "和声"]) {
        return "backing";
    }
    if name_has(n, &["perc", "打击"]) {
        return "perc";
    }
    if name_has(n, &["drum", "鼓"]) {
        return "drums";
    }
    if name_has(n, &["vocal", "vox", "人声", "主唱"]) {
        return "lead";
    }
    if name_has(n, &["bass", "贝斯"]) {
        return "bass";
    }
    if name_has(
        n,
        &[
            "guitar", "keys", "piano", "synth", "strings", "brass", "fx",
            "instrumental", "accomp", "other", "pad", "organ", "melody",
            "吉他", "键盘", "钢琴", "合成", "弦乐", "铜管", "管乐", "音效",
            "伴奏", "其他",
        ],
    ) {
        return "other";
    }
    "mix"
}

pub fn role_label_zh(role: &str) -> &'static str {
    match role {
        "lead" | "lead_vocal" | "vocal" | "vocals" => "主唱",
        "backing" | "backing_vocal" | "bgv" => "和声",
        "drums" | "drum" => "鼓",
        "perc" | "percussion" => "打击乐",
        "bass" => "贝斯",
        _ => "其他",
    }
}

/// Engine-side role: explicit `role` wins; otherwise derive from the stem
/// name, defaulting to Other (a stem is never a "mix").
pub(crate) fn stem_role(st: &StemIn) -> StemRole {
    match st.role.as_str() {
        "lead" | "lead_vocal" | "vocal" | "vocals" => StemRole::Lead,
        "backing" | "backing_vocal" | "bgv" => StemRole::Backing,
        "drums" | "drum" => StemRole::Drums,
        "perc" | "percussion" => StemRole::Perc,
        "bass" => StemRole::Bass,
        "other" => StemRole::Other,
        _ => match guess_stem_role(&st.name) {
            "lead" => StemRole::Lead,
            "backing" => StemRole::Backing,
            "drums" => StemRole::Drums,
            "perc" => StemRole::Perc,
            "bass" => StemRole::Bass,
            _ => StemRole::Other,
        },
    }
}

/// Deserialize a module amount (0–1.5) that also accepts the legacy
/// boolean form: `true` → 1.0, `false` → 0.0 (older project files stored
/// the modules as on/off switches).
fn bool_or_amount<'de, D>(d: D) -> Result<f32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    match serde_json::Value::deserialize(d)? {
        serde_json::Value::Bool(b) => Ok(if b { 1.0 } else { 0.0 }),
        serde_json::Value::Number(n) => n
            .as_f64()
            .map(|v| v as f32)
            .ok_or_else(|| Error::custom("invalid module amount")),
        _ => Err(Error::custom("module amount must be a number or bool")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RestoreModules {
    /// Per-module processing amount 0–1.5 (effective = strength × amount;
    /// 0 = bypass). Legacy project files stored these as booleans.
    #[serde(deserialize_with = "bool_or_amount")]
    pub vocal_cleanup: f32,
    #[serde(deserialize_with = "bool_or_amount")]
    pub shimmer: f32,
    #[serde(deserialize_with = "bool_or_amount")]
    pub drum_punch: f32,
    #[serde(deserialize_with = "bool_or_amount")]
    pub low_end: f32,
    #[serde(deserialize_with = "bool_or_amount")]
    pub width: f32,
    #[serde(deserialize_with = "bool_or_amount")]
    pub vocal_space: f32,
    #[serde(deserialize_with = "bool_or_amount")]
    pub hf_restore: f32,
    #[serde(deserialize_with = "bool_or_amount")]
    pub glue: f32,
    pub loudness: bool,
    /// Reference-track spectral matching (active when reference_path set).
    pub reference_match: bool,
    /// Acoustic drum reinforcement on the drums stem.
    pub drum_replace: bool,
}

impl Default for RestoreModules {
    fn default() -> Self {
        Self {
            vocal_cleanup: 1.0,
            shimmer: 1.0,
            drum_punch: 1.0,
            low_end: 1.0,
            width: 1.0,
            vocal_space: 1.0,
            hf_restore: 1.0,
            glue: 1.0,
            loudness: true,
            reference_match: true,
            drum_replace: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RestoreSettings {
    /// 0.5 light / 1.0 standard / 1.5 strong.
    pub strength: f32,
    pub modules: RestoreModules,
    pub target_lufs: f64,
    pub ceiling_dbtp: f64,
    /// 24 or 16.
    pub bit_depth: u16,
    /// Optional reference track for spectral matching.
    pub reference_path: Option<String>,
    /// 0..1 blend of the reference correction (scaled by strength).
    pub match_amount: f32,
    /// Take the loudness target from the reference instead of target_lufs.
    pub follow_reference_loudness: bool,
    /// 0.3 / 0.5 / 0.8 — reinforced-drum mix (not scaled by strength).
    pub drum_replace_amount: f32,
    /// −3..+3 dB gain on lead-vocal stems (inside the stem delta).
    pub vocal_level_db: f32,
    /// −3..+3 dB peaking 3.5 kHz Q 1.0 on lead-vocal stems.
    pub vocal_presence_db: f32,
    /// −3..+3 dB high-shelf 10 kHz Q 0.707 on lead-vocal stems.
    pub vocal_air_db: f32,
    /// −3..+3 dB master low-shelf 100 Hz (before glue).
    pub low_shelf_db: f32,
    /// −3..+3 dB master high-shelf 10 kHz (before glue).
    pub high_shelf_db: f32,
}

impl Default for RestoreSettings {
    fn default() -> Self {
        Self {
            strength: 1.0,
            modules: RestoreModules::default(),
            target_lufs: -14.0,
            ceiling_dbtp: -1.0,
            bit_depth: 24,
            reference_path: None,
            match_amount: 0.7,
            follow_reference_loudness: false,
            drum_replace_amount: 0.5,
            vocal_level_db: 0.0,
            vocal_presence_db: 0.0,
            vocal_air_db: 0.0,
            low_shelf_db: 0.0,
            high_shelf_db: 0.0,
        }
    }
}

impl RestoreSettings {
    /// Clamp every adjustable field to the ranges the AI-advisor prompt
    /// documents (strength 0.5–1.5, module amounts 0–1.5, tone dBs ±3,
    /// target −16…−9 LUFS, drum amount snapped to 0.3/0.5/0.8).
    pub fn clamped(&self) -> Self {
        let mut c = self.clone();
        c.strength = c.strength.clamp(0.5, 1.5);
        let m = &mut c.modules;
        for v in [
            &mut m.vocal_cleanup,
            &mut m.shimmer,
            &mut m.drum_punch,
            &mut m.low_end,
            &mut m.width,
            &mut m.vocal_space,
            &mut m.hf_restore,
            &mut m.glue,
        ] {
            *v = v.clamp(0.0, 1.5);
        }
        for v in [
            &mut c.vocal_level_db,
            &mut c.vocal_presence_db,
            &mut c.vocal_air_db,
            &mut c.low_shelf_db,
            &mut c.high_shelf_db,
        ] {
            *v = v.clamp(-3.0, 3.0);
        }
        c.target_lufs = c.target_lufs.clamp(-16.0, -9.0);
        let steps = [0.3f32, 0.5, 0.8];
        c.drum_replace_amount = steps
            .iter()
            .copied()
            .min_by(|a, b| {
                (*a - c.drum_replace_amount)
                    .abs()
                    .partial_cmp(&(*b - c.drum_replace_amount).abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .unwrap_or(0.5);
        c
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RestoreRequest {
    pub source_path: String,
    #[serde(default)]
    pub stems: Vec<StemIn>,
    #[serde(default)]
    pub settings: RestoreSettings,
    #[serde(default)]
    pub output_path: Option<String>,
}

/// Reference-match summary attached to RestoreResult when a reference
/// track was used.
#[derive(Debug, Clone, Serialize)]
pub struct ReferenceInfo {
    pub path: String,
    /// Full quality report of the reference (ltas = mid bands).
    pub report: QualityReport,
    /// Normalized-LTAS RMS distance 60 Hz-12 kHz: source vs reference.
    pub distance_before_db: f64,
    /// Same metric for the rendered output.
    pub distance_after_db: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreResult {
    pub output_path: String,
    pub sample_rate: u32,
    pub bit_depth: u16,
    pub before: QualityReport,
    pub after: QualityReport,
    pub loudness_match_db: f64,
    pub limiter_avg_gr_db: f64,
    pub notes: Vec<String>,
    pub elapsed_ms: u64,
    #[serde(default)]
    pub reference: Option<ReferenceInfo>,
    /// Rule-based objective score (lower = better) vs the input report.
    #[serde(default)]
    pub objective: Option<super::quality::objective::ObjectiveScore>,
    /// Audiobox Aesthetics score of the output (None when model absent).
    #[serde(default)]
    pub critic: Option<super::quality::critic::CriticScore>,
    /// Audiobox Aesthetics score of the input (None when model absent).
    #[serde(default)]
    pub critic_before: Option<super::quality::critic::CriticScore>,
    /// Which PQ-guard rung produced this output: "full" | "half" | "minimal".
    #[serde(default)]
    pub guard_rung: Option<String>,
}

// ---------- helpers ----------

/// Detector envelope percentile: band-pass [lo,hi] -> |x| env (1 ms attack /
/// given release) -> percentile of env_db over samples where env > -60 dBFS.
fn detector_percentile(
    l: &[f32],
    r: &[f32],
    sr: f64,
    band: (f64, f64),
    release_ms: f64,
    pct: f64,
) -> f64 {
    let n = l.len().min(r.len());
    let mut hp = Biquad::high_pass(sr, band.0, std::f64::consts::FRAC_1_SQRT_2);
    let mut lp = Biquad::low_pass(sr, band.1, std::f64::consts::FRAC_1_SQRT_2);
    let rel = (-1.0 / (release_ms * sr / 1000.0)).exp();
    let mut env = 0.0f64;
    let mut vals: Vec<f64> = Vec::with_capacity(n / 8);
    for i in 0..n {
        let mut d = (l[i] as f64 + r[i] as f64) * 0.5;
        d = lp.tick(hp.tick(d));
        // peak-hold envelope: instant attack, `release_ms` decay
        env *= rel;
        if d.abs() > env {
            env = d.abs();
        }
        if i % 8 == 0 && env > 1e-3 {
            vals.push(20.0 * env.log10());
        }
    }
    if vals.is_empty() {
        return -60.0;
    }
    vals.sort_by(|a, b| a.total_cmp(b));
    vals[((vals.len() - 1) as f64 * pct).round() as usize]
}


fn correlate(l: &[f32], r: &[f32]) -> f64 {
    let n = l.len().min(r.len());
    let (mut sab, mut sa2, mut sb2) = (0.0f64, 0.0f64, 0.0f64);
    for i in 0..n {
        sab += l[i] as f64 * r[i] as f64;
        sa2 += (l[i] as f64) * (l[i] as f64);
        sb2 += (r[i] as f64) * (r[i] as f64);
    }
    if sa2 * sb2 <= 1e-18 {
        1.0
    } else {
        sab / (sa2 * sb2).sqrt()
    }
}

fn rms_lin(l: &[f32], r: &[f32]) -> f64 {
    let n = l.len().min(r.len()).max(1);
    let mut e = 0.0f64;
    for i in 0..l.len().min(r.len()) {
        e += (l[i] as f64) * (l[i] as f64) + (r[i] as f64) * (r[i] as f64);
    }
    (e / (2.0 * n as f64)).sqrt()
}

fn peaking_stereo(l: &[f32], r: &[f32], sr: f64, freq: f64, q: f64, gain_db: f64) -> (Vec<f32>, Vec<f32>) {
    if gain_db.abs() < 1e-6 {
        return (l.to_vec(), r.to_vec());
    }
    let mut bl = Biquad::peaking(sr, freq, q, gain_db);
    let mut br = Biquad::peaking(sr, freq, q, gain_db);
    (bl.process(l), br.process(r))
}

/// Vocal tone params applied to lead-vocal stems (inside the delta):
/// 3.5 kHz presence peaking, 10 kHz air shelf, then overall level gain.
/// All-0 is an exact bypass. Called on 44.1 kHz stem audio.
fn apply_vocal_tone(l: &mut Vec<f32>, r: &mut Vec<f32>, rs: &RestoreSettings) {
    if rs.vocal_presence_db.abs() > 1e-6 {
        let (a, b) = peaking_stereo(l, r, STEM_SR, 3500.0, 1.0, rs.vocal_presence_db as f64);
        *l = a;
        *r = b;
    }
    if rs.vocal_air_db.abs() > 1e-6 {
        let mut bl = Biquad::high_shelf(STEM_SR, 10_000.0, std::f64::consts::FRAC_1_SQRT_2, rs.vocal_air_db as f64);
        let mut br = Biquad::high_shelf(STEM_SR, 10_000.0, std::f64::consts::FRAC_1_SQRT_2, rs.vocal_air_db as f64);
        *l = bl.process(l);
        *r = br.process(r);
    }
    if rs.vocal_level_db.abs() > 1e-6 {
        let g = 10f64.powf(rs.vocal_level_db as f64 / 20.0) as f32;
        for v in l.iter_mut() {
            *v *= g;
        }
        for v in r.iter_mut() {
            *v *= g;
        }
    }
}

// ---------- per-stem chains (at 44.1 kHz) ----------

const STEM_SR: f64 = 44_100.0;

/// Test/ablation-only kill switches: SS_NO_VOCAL_SUPPRESS, SS_NO_VOCAL_DEESS,
/// SS_NO_OTHER_SUPPRESS, SS_NO_HARSH_DYN, SS_NO_HARSH_STATIC (=1 disables).
fn stage_off(name: &str) -> bool {
    matches!(std::env::var(name).ok().as_deref(), Some("1") | Some("true"))
}

fn chain_vocals(
    l: &[f32],
    r: &[f32],
    s: f64,
    m: &RestoreModules,
    dyn_scale: f64,
    lift: bool,
) -> (Vec<f32>, Vec<f32>) {
    let s = s * m.vocal_cleanup as f64;
    if s <= 0.0 {
        return (l.to_vec(), r.to_vec());
    }
    let dyn_s = dyn_scale;
    let mut bl = Biquad::high_pass(STEM_SR, 90.0, std::f64::consts::FRAC_1_SQRT_2);
    let mut br = Biquad::high_pass(STEM_SR, 90.0, std::f64::consts::FRAC_1_SQRT_2);
    let mut l = bl.process(l);
    let mut r = br.process(r);
    // Spectral cleanup 2.5-9 kHz
    if !stage_off("SS_NO_VOCAL_SUPPRESS") {
        let mut sup_l = SpectralSuppressor::new(STEM_SR, 2500.0, 9000.0, 6.0, 0.4 * s, 4.0 * s, 5.0, 60.0);
        let mut sup_r = SpectralSuppressor::new(STEM_SR, 2500.0, 9000.0, 6.0, 0.4 * s, 4.0 * s, 5.0, 60.0);
        l = sup_l.process(&l);
        r = sup_r.process(&r);
    }
    // De-esser (linked, detector = own 5-11 kHz band). Threshold =
    // max(p85, p50 + 6 dB) so it only engages on genuine sibilance
    // spikes instead of always acting on the top 15 % of the song.
    if !stage_off("SS_NO_VOCAL_DEESS") {
        let thr = detector_percentile(&l, &r, STEM_SR, (5000.0, 11000.0), 60.0, 0.85)
            .max(detector_percentile(&l, &r, STEM_SR, (5000.0, 11000.0), 60.0, 0.50) + 6.0);
        let mut de = DynamicEqBand::new(STEM_SR, 7500.0, 0.8, (5000.0, 11000.0), thr, 4.0, 6.0 * s, 1.0, 60.0);
        let (a, b) = de.process(&l, &r, None);
        l = a;
        r = b;
    }
    // Vocal compressor (linked): level-relative threshold = 3 s slow RMS
    // envelope + 3 dB, so loud sections are not flattened more than quiet
    // ones; + makeup.
    {
        let (mut comp, mut env) =
            Compressor::new_tracking(STEM_SR, 3.0, 3.0, 6.0, 8.0, 120.0, 6.0 * s * dyn_s);
        let (a, b, st) = comp.process(&mut env, &l, &r, None);
        let lift_db = if lift { 1.0 * s } else { 0.0 };
        let g = 10f64.powf((st.gr_median_db + lift_db) / 20.0) as f32;
        l = a.iter().map(|&v| v * g).collect();
        r = b.iter().map(|&v| v * g).collect();
    }
    (l, r)
}

fn chain_drums(
    l: &[f32],
    r: &[f32],
    s: f64,
    m: &RestoreModules,
    diag: &QualityReport,
) -> (Vec<f32>, Vec<f32>) {
    let mut l = l.to_vec();
    let mut r = r.to_vec();
    if s <= 0.0 {
        return (l, r);
    }
    if m.drum_punch > 0.0 {
        let mut t = TransientShaper::new(STEM_SR, 0.35 * s * m.drum_punch as f64);
        let (a, b) = t.process(&l, &r);
        l = a;
        r = b;
    }
    if m.shimmer > 0.0 {
        let sh = s * m.shimmer as f64;
        let mut a = SpectralSuppressor::new(STEM_SR, 7000.0, 16000.0, 3.0, 0.5 * sh, 5.0 * sh, 3.0, 40.0);
        let mut b = SpectralSuppressor::new(STEM_SR, 7000.0, 16000.0, 3.0, 0.5 * sh, 5.0 * sh, 3.0, 40.0);
        l = a.process(&l);
        r = b.process(&r);
    }
    if m.low_end > 0.0 && diag.low_mid_excess_db >= 2.0 && diag.low_mid_center_hz > 0.0 {
        let cut = -0.5 * (diag.low_mid_excess_db.min(3.0) as f64) * s * m.low_end as f64;
        let (a, b) = peaking_stereo(&l, &r, STEM_SR, diag.low_mid_center_hz as f64, 1.0, cut);
        l = a;
        r = b;
    }
    (l, r)
}

fn chain_bass(
    l: &[f32],
    r: &[f32],
    s: f64,
    m: &RestoreModules,
    dyn_scale: f64,
) -> (Vec<f32>, Vec<f32>) {
    let s = s * m.low_end as f64;
    if s <= 0.0 {
        return (l.to_vec(), r.to_vec());
    }
    let (mut l, mut r) = mono_below(l, r, STEM_SR, 200.0);
    {
        let mut sat = Saturator::new(2.0, (0.20 * s * dyn_scale).min(1.0));
        let (a, b) = sat.process_stereo(&l, &r);
        l = a;
        r = b;
    }
    {
        let (mut comp, mut env) =
            Compressor::new_tracking(STEM_SR, 2.0, 3.0, 0.0, 20.0, 150.0, 4.0 * s * dyn_scale);
        let (a, b, st) = comp.process(&mut env, &l, &r, None);
        let g = 10f64.powf(st.gr_median_db / 20.0) as f32;
        l = a.iter().map(|&v| v * g).collect();
        r = b.iter().map(|&v| v * g).collect();
    }
    (l, r)
}

fn chain_other(
    l: &[f32],
    r: &[f32],
    s: f64,
    m: &RestoreModules,
    diag: &QualityReport,
    vocals: Option<(&[f32], &[f32])>,
    vocals_weak: bool,
    notes: &mut Vec<String>,
) -> (Vec<f32>, Vec<f32>) {
    let mut l = l.to_vec();
    let mut r = r.to_vec();
    if s <= 0.0 {
        return (l, r);
    }
    if m.low_end > 0.0 && diag.low_mid_excess_db >= 2.0 && diag.low_mid_center_hz > 0.0 {
        let cut = -(diag.low_mid_excess_db.min(4.0) as f64) * s * m.low_end as f64;
        let (a, b) = peaking_stereo(&l, &r, STEM_SR, diag.low_mid_center_hz as f64, 0.9, cut);
        l = a;
        r = b;
    }
    if m.vocal_cleanup > 0.0 && !stage_off("SS_NO_OTHER_SUPPRESS") {
        let vc = s * m.vocal_cleanup as f64;
        let mut a = SpectralSuppressor::new(STEM_SR, 2500.0, 9000.0, 6.0, 0.35 * vc, 3.0 * vc, 5.0, 60.0);
        let mut b = SpectralSuppressor::new(STEM_SR, 2500.0, 9000.0, 6.0, 0.35 * vc, 3.0 * vc, 5.0, 60.0);
        l = a.process(&l);
        r = b.process(&r);
    }
    if m.shimmer > 0.0 {
        let sh = s * m.shimmer as f64;
        let mut a = SpectralSuppressor::new(STEM_SR, 9000.0, 16000.0, 3.0, 0.4 * sh, 4.0 * sh, 3.0, 40.0);
        let mut b = SpectralSuppressor::new(STEM_SR, 9000.0, 16000.0, 3.0, 0.4 * sh, 4.0 * sh, 3.0, 40.0);
        l = a.process(&l);
        r = b.process(&r);
    }
    if m.width > 0.0 {
        let mut w = 1.0 + 0.15 * s * m.width as f64;
        let (mut a, mut b) = widen_band(&l, &r, STEM_SR, 300.0, w);
        // Back off until L/R correlation of the widened output >= 0.2.
        let mut corr = correlate(&a, &b);
        while corr < 0.2 && w > 1.001 {
            w = 1.0 + (w - 1.0) * 0.5;
            let (a2, b2) = widen_band(&l, &r, STEM_SR, 300.0, w);
            a = a2;
            b = b2;
            corr = correlate(&a, &b);
        }
        if corr < 0.2 {
            notes.push(format!("声场加宽已回退：处理后相关性 {corr:.2} 仍低于 0.2"));
        }
        l = a;
        r = b;
    }
    if m.vocal_space > 0.0 {
        if vocals_weak || vocals.is_none() {
            notes.push("人声过弱或缺失，已跳过人声空间避让".to_string());
        } else if let Some((vl, vr)) = vocals {
            // sidechain = vocals band-passed 1-5 kHz (mono)
            let n = vl.len().min(vr.len());
            let mut hp = Biquad::high_pass(STEM_SR, 1000.0, std::f64::consts::FRAC_1_SQRT_2);
            let mut lp = Biquad::low_pass(STEM_SR, 5000.0, std::f64::consts::FRAC_1_SQRT_2);
            let sc: Vec<f32> = (0..n)
                .map(|i| {
                    let m_ = (vl[i] as f64 + vr[i] as f64) * 0.5;
                    lp.tick(hp.tick(m_)) as f32
                })
                .collect();
            let thr = detector_percentile(&sc, &sc, STEM_SR, (1000.0, 5000.0), 150.0, 0.50);
            let mut de = DynamicEqBand::new(STEM_SR, 2500.0, 0.5, (1000.0, 5000.0), thr, 2.0, 2.0 * s * m.vocal_space as f64, 10.0, 150.0);
            let (ol, or_) = de.process(&l, &r, Some(&sc));
            l = ol;
            r = or_;
        }
    }
    (l, r)
}

// ---------- master bus ----------

#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
/// Env-gated (SS_TIMING=1) per-stage wall-clock probe for perf audits.
pub(crate) fn timing_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("SS_TIMING").is_some())
}

/// Logs `<name>: <secs>` on drop when SS_TIMING is set.
pub(crate) struct StageTimer {
    name: String,
    t: Instant,
}

impl StageTimer {
    pub(crate) fn new(name: impl Into<String>) -> Self {
        StageTimer {
            name: name.into(),
            t: Instant::now(),
        }
    }
}

impl Drop for StageTimer {
    fn drop(&mut self) {
        if timing_enabled() {
            eprintln!("[timing] {} {:.2}s", self.name, self.t.elapsed().as_secs_f64());
        }
    }
}

fn master_bus(
    y_l: &[f32],
    y_r: &[f32],
    work_sr: f64,
    s: f64,
    rs: &RestoreSettings,
    diag: &QualityReport,
    stem_mode: bool,
    dyn_scale: f64,
    ref_bands: Option<(&[BandLevel], &[BandLevel])>,
    ref_amount: f64,
) -> (Vec<f32>, Vec<f32>) {
    let m = &rs.modules;
    let mut l = y_l.to_vec();
    let mut r = y_r.to_vec();
    if s <= 0.0 {
        return (l, r);
    }
    let any_master = m.low_end > 0.0
        || m.glue > 0.0
        || m.hf_restore > 0.0
        || m.loudness
        || m.vocal_cleanup > 0.0
        || rs.low_shelf_db.abs() > 1e-6
        || rs.high_shelf_db.abs() > 1e-6
        || ref_bands.is_some();
    if !any_master {
        return (l, r);
    }
    // HPF 28 Hz, 4th-order Butterworth (fixed cleanup)
    {
        let _t = StageTimer::new("mb_hpf");
        let mut hl = butter4_highpass(work_sr, 28.0);
        let mut hr = butter4_highpass(work_sr, 28.0);
        l = hl.iter_mut().fold(l, |x, b| b.process(&x));
        r = hr.iter_mut().fold(r, |x, b| b.process(&x));
    }
    if m.low_end > 0.0 && diag.low_mid_excess_db >= 2.0 && diag.low_mid_center_hz > 0.0 {
        let k = if stem_mode { 0.5 } else { 1.0 };
        let cut = -k * (diag.low_mid_excess_db.min(3.0) as f64) * s * m.low_end as f64;
        let (a, b) = peaking_stereo(&l, &r, work_sr, diag.low_mid_center_hz as f64, 0.9, cut);
        l = a;
        r = b;
    }
    // Master-bus dynamic EQ per diagnosed harsh peak (<= 4).
    if m.vocal_cleanup > 0.0 && !stage_off("SS_NO_HARSH_DYN") {
        let _t = StageTimer::new("mb_harsh_dyn");
        for pk in diag.harsh_peaks.iter().take(4) {
            let hz = pk.hz as f64;
            let lo = hz * 2f64.powf(-1.0 / 8.0);
            let hi = hz * 2f64.powf(1.0 / 8.0);
            let thr = detector_percentile(&l, &r, work_sr, (lo, hi), 60.0, 0.50);
            let mut de = DynamicEqBand::new(
                work_sr,
                hz,
                4.0,
                (lo, hi),
                thr,
                3.0,
                (pk.excess_db as f64).min(4.0) * s * m.vocal_cleanup as f64,
                5.0,
                80.0,
            );
            let (a, b) = de.process(&l, &r, None);
            l = a;
            r = b;
        }
    }
    // Closed loop: re-run low-mid + harsh heuristics on y (same Welch LTAS
    // code path as diagnose.rs) and correct any residual. Spec allows one
    // extra iteration, so the measure->correct pass may repeat once more.
    for _pass in 0..2 {
        let _t = StageTimer::new(format!("mb_closed_loop_{_pass}"));
        let mut applied = false;
        let n = l.len().min(r.len());
        let mid: Vec<f32> = (0..n).map(|i| (l[i] + r[i]) * 0.5).collect();
        let ltas = super::quality::spectrum::sixth_octave_bands(
            &super::quality::spectrum::welch_psd(&mid, work_sr as u32),
            work_sr as u32,
        );
        let (_excess, _center, peaks) = super::quality::diagnose::band_heuristics(&ltas);
        // A low-mid "excess" is usually several adjacent bumps; cutting only
        // the max band leaves the neighbours elevated. Cut every 200-500 Hz
        // band whose residual is >= 1.5 dB (still one correction pass).
        if m.low_end > 0.0 {
            for (hz, resid) in super::quality::diagnose::low_mid_residuals(&ltas) {
                if resid >= 1.5 {
                    let cut = -0.7 * (resid.min(3.0) as f64) * s * m.low_end as f64;
                    let (a, b) = peaking_stereo(&l, &r, work_sr, hz as f64, 0.9, cut);
                    l = a;
                    r = b;
                    applied = true;
                }
            }
        }
        if m.vocal_cleanup > 0.0 && !stage_off("SS_NO_HARSH_STATIC") {
            for pk in peaks.iter().take(4) {
                if pk.excess_db >= 2.5 {
                    // The peak band also feeds the 1-octave reference mean,
                    // so a cut of d dB lowers the measured excess by ~0.83d;
                    // -0.7 lands a hair under spec's -0.5 intent.
                    let (a, b) = peaking_stereo(
                        &l,
                        &r,
                        work_sr,
                        pk.hz as f64,
                        4.0,
                        -0.7 * pk.excess_db as f64 * s * m.vocal_cleanup as f64,
                    );
                    l = a;
                    r = b;
                    applied = true;
                }
            }
        }
        if !applied {
            break;
        }
    }
    // Reference spectral matching: linear-phase FIR on M and S, between
    // the residual EQ corrections and the glue stage.
    if let Some((rm, rs)) = ref_bands {
        let (a, b) = super::refmatch::match_apply(
            &l,
            &r,
            work_sr,
            rm,
            rs,
            ref_amount,
            diag.cutoff_hz.map(|c| c as f64),
        );
        l = a;
        r = b;
    }
    // User tone shelves: after residual corrections / reference match,
    // before glue. dB values are applied as-is (not scaled by strength).
    if rs.low_shelf_db.abs() > 1e-6 {
        let mut bl = Biquad::low_shelf(work_sr, 100.0, std::f64::consts::FRAC_1_SQRT_2, rs.low_shelf_db as f64);
        let mut br = Biquad::low_shelf(work_sr, 100.0, std::f64::consts::FRAC_1_SQRT_2, rs.low_shelf_db as f64);
        l = bl.process(&l);
        r = br.process(&r);
    }
    if rs.high_shelf_db.abs() > 1e-6 {
        let mut bl = Biquad::high_shelf(work_sr, 10000.0, std::f64::consts::FRAC_1_SQRT_2, rs.high_shelf_db as f64);
        let mut br = Biquad::high_shelf(work_sr, 10000.0, std::f64::consts::FRAC_1_SQRT_2, rs.high_shelf_db as f64);
        l = bl.process(&l);
        r = br.process(&r);
    }
    if m.glue > 0.0 {
        let _t = StageTimer::new("mb_glue");
        // Glue compressor: level-relative threshold = 3 s slow RMS envelope
        // + 2 dB — shapes micro-dynamics without flattening sections.
        let gl = s * m.glue as f64;
        let (mut comp, mut env) =
            Compressor::new_tracking(work_sr, 2.0, 1.5, 6.0, 20.0, 150.0, 2.0 * gl * dyn_scale);
        let (ol, or_, _st) = comp.process(&mut env, &l, &r, None);
        l = ol;
        r = or_;
        let mut sat = Saturator::new(1.5, (0.15 * gl * dyn_scale).min(1.0));
        let (a, b) = sat.process_stereo(&l, &r);
        l = a;
        r = b;
    }
    if m.low_end > 0.0 {
        let (a, b) = mono_below(&l, &r, work_sr, 120.0);
        l = a;
        r = b;
    }
    if m.hf_restore > 0.0 {
        if let Some(cut) = diag.cutoff_hz {
            if cut < 19000.0 {
                let fc = cut as f64;
                let hf = s * m.hf_restore as f64;
                let rel = if hf <= 1.0 { -10.0 + 8.0 * (hf - 0.5) } else { -6.0 + 6.0 * (hf - 1.0) };
                let n = l.len();
                let (add_l, add_r) = std::thread::scope(|sc| {
                    let hl = sc.spawn(|| exciter_band(&l, work_sr as u32, fc, rel));
                    let hr = sc.spawn(|| exciter_band(&r, work_sr as u32, fc, rel));
                    (hl.join().unwrap(), hr.join().unwrap())
                });
                for i in 0..n {
                    l[i] += add_l[i];
                    r[i] += add_r[i];
                }
            }
        }
    }
    (l, r)
}

// ---------- top level ----------

/// Core render used by the Tauri command and the example binary.
/// `emit(stage, percent)`.
/// Core render used by the Tauri command and the example binary.
/// `emit(stage, percent)`.
pub fn run_restore(
    req: &RestoreRequest,
    emit: impl FnMut(&str, f32) + Send,
) -> Result<RestoreResult> {
    run_restore_inner(req, emit, &critic_score_opt)
}

/// Lazily-joined critic score of one path: the scorer runs on a scoped
/// thread so it overlaps other work; the result is fetched once.
fn lazy_score<'a>(
    scope: &'a std::thread::Scope<'a, '_>,
    critic: CriticFn<'a>,
    path: &'a str,
) -> impl Fn() -> Option<super::quality::critic::CriticScore> + 'a {
    let handle = std::sync::Mutex::new(Some(scope.spawn(move || {
        let _t = StageTimer::new("critic_in");
        critic(path)
    })));
    let cell = std::sync::OnceLock::new();
    move || {
        cell.get_or_init(|| {
            handle
                .lock()
                .unwrap()
                .take()
                .map(|h| h.join().ok().flatten())
                .unwrap_or(None)
        })
        .clone()
    }
}

pub(crate) fn run_restore_inner(
    req: &RestoreRequest,
    mut emit: impl FnMut(&str, f32) + Send,
    critic: CriticFn<'_>,
) -> Result<RestoreResult> {
    let t0 = Instant::now();
    let mut owned;
    let req = {
        owned = req.clone();
        owned.settings = owned.settings.clamped();
        &owned
    };
    // cache_stems=true: decode each stem once instead of twice.
    let ctx = prepare_restore(req, &mut emit, true)?;
    std::thread::scope(|scope| {
        // The input PQ is only needed after the F render finishes —
        // score it concurrently with that render.
        let get_in = lazy_score(scope, critic, &req.source_path);
        let pq_in = || get_in().map(|c| c.pq as f64);
        let mut res = render_with_pq_guard(
            &ctx,
            req,
            &mut emit,
            ctx.notes.clone(),
            t0,
            &pq_in,
            critic,
            true,
        )?;
        res.critic_before = get_in();
        Ok(res)
    })
}

/// Everything decoded/analyzed once for one or more renders of the same
/// source + stems: source PCM at work rate, before-report, optional
/// reference, drum kit, per-stem 44.1k PCM cache (compare mode), notes.
pub(crate) struct RestoreCtx {
    pub(crate) before: QualityReport,
    xw_l: Vec<f32>,
    xw_r: Vec<f32>,
    n: usize,
    work_rate: u32,
    pub(crate) stem_mode: bool,
    vocals_weak: bool,
    ref_ctx: Option<(QualityReport, Vec<BandLevel>, Vec<BandLevel>, f64)>,
    drum_kit: Option<drum_hits::DrumKit>,
    stem_pcm: Option<Vec<(Vec<f32>, Vec<f32>)>>,
    pub(crate) notes: Vec<String>,
}

/// Cap on the compare-mode stem PCM cache (44.1k f32 stereo per stem).
const STEM_CACHE_MAX_BYTES: usize = 512 * 1024 * 1024;

pub(crate) fn prepare_restore(
    req: &RestoreRequest,
    emit: &mut (dyn FnMut(&str, f32) + Send),
    cache_stems: bool,
) -> Result<RestoreCtx> {
    let m = &req.settings.modules;
    let mut notes: Vec<String> = Vec::new();

    emit("analyze", 0.0);
    let _t = StageTimer::new("analyze_input");
    let before = analyze_quality(&req.source_path)?;
    drop(_t);

    // Decode source at full quality -> stereo at work rate.
    let _t = StageTimer::new("decode_source");
    let decoded = decode_audio_file(&req.source_path)?;
    let (xl, xr) = decoded.to_stereo_planar();
    let work_rate = if decoded.sample_rate >= 44_100 {
        decoded.sample_rate
    } else {
        48_000
    };

    let (xw_l, xw_r) = resample_hq_stereo(&xl, &xr, decoded.sample_rate, work_rate);
    let n = xw_l.len().min(xw_r.len());
    let stem_mode = !req.stems.is_empty();
    if decoded.channels == 1 {
        notes.push("源文件为单声道，已复制为立体声处理".to_string());
    }
    drop(decoded);
    drop(xl);
    drop(xr);

    // Reference track (optional): decode at full quality -> work rate ->
    // mid+side LTAS + integrated loudness.
    let ref_ctx: Option<(QualityReport, Vec<BandLevel>, Vec<BandLevel>, f64)> =
        if (m.reference_match || req.settings.follow_reference_loudness)
            && req.settings.reference_path.as_deref().is_some_and(|p| !p.is_empty())
        {
            let p = req.settings.reference_path.as_deref().unwrap();
            let rep =
                analyze_quality(p).map_err(|e| anyhow!("参考曲分析失败: {e}"))?;
            let d = decode_audio_file(p).map_err(|e| anyhow!("参考曲读取失败: {e}"))?;
            let d_sr = d.sample_rate;
            let (rl, rr) = d.to_stereo_planar();
            drop(d);
            let (rlw, rrw) = resample_hq_stereo(&rl, &rr, d_sr, work_rate);
            drop(rl);
            drop(rr);
            let (rm, rs) = super::quality::spectrum::ms_ltas(&rlw, &rrw, work_rate);
            let ri = loudness::integrated_lufs(&[rlw, rrw], work_rate);
            Some((rep, rm, rs, ri))
        } else {
            None
        };
    emit("stems", 5.0);

    // Stem pass: RMS for weak-vocal detection; optionally keep the 44.1k
    // PCM so multi-candidate compares decode each stem only once.
    let mut loudest = 0.0f64;
    let mut vocals_rms = 0.0f64;
    let mut stem_pcm: Option<Vec<(Vec<f32>, Vec<f32>)>> =
        if cache_stems && stem_mode { Some(Vec::new()) } else { None };
    let mut pcm_bytes = 0usize;
    if stem_mode {
        let _t = StageTimer::new("prepare_stem_pass");
        for st in &req.stems {
            let d = decode_audio_file(&st.file_path)
                .map_err(|e| anyhow!("读取分轨 {} 失败: {e}", st.file_path))?;
            let (sl, sr_) = d.to_stereo_planar();
            let (sl44, sr44) = resample_hq_stereo(&sl, &sr_, d.sample_rate, 44_100);
            drop(d);
            let lv = rms_lin(&sl44, &sr44);
            loudest = loudest.max(lv);
            if matches!(stem_role(st), StemRole::Lead) {
                vocals_rms += lv;
            }
            if stem_pcm.is_some() {
                pcm_bytes += (sl44.len() + sr44.len()) * 4;
                if pcm_bytes <= STEM_CACHE_MAX_BYTES {
                    stem_pcm.as_mut().unwrap().push((sl44, sr44));
                } else {
                    stem_pcm = None;
                }
            }
        }
    }
    let vocals_weak = vocals_rms < 0.15 * loudest;
    if stem_mode && vocals_weak {
        notes.push(format!("人声轨能量仅为主轨 {:.0}%，判定为弱人声", vocals_rms / loudest.max(1e-9) * 100.0));
    }
    if !stem_mode {
        notes.push("未提供分轨，执行纯母带处理模式".to_string());
    }

    // Bundled drum kit (loaded once when reinforcement is on).
    let drum_kit = if m.drum_replace && stem_mode {
        match drum_hits::DrumKit::load(&drum_hits::kit_dir(), 44_100) {
            Ok(k) => Some(k),
            Err(e) => {
                notes.push(format!("鼓件加载失败，已跳过鼓替换: {e}"));
                None
            }
        }
    } else {
        None
    };

    Ok(RestoreCtx {
        before,
        xw_l,
        xw_r,
        n,
        work_rate,
        stem_mode,
        vocals_weak,
        ref_ctx,
        drum_kit,
        stem_pcm,
        notes,
    })
}

/// One full render (stems -> delta remix -> master -> loudness/limiter).
/// Returns (out_l, out_r, limiter_avg_gr, render notes).
fn render_stems(
    ctx: &RestoreCtx,
    req: &RestoreRequest,
    dyn_scale: f64,
    emit: &mut (dyn FnMut(&str, f32) + Send),
    parallel_stems: bool,
) -> Result<(Vec<f32>, Vec<f32>, f64, Vec<String>)> {
    let _t_all = StageTimer::new("render_stems_total");
    let s = req.settings.strength as f64;
    let m = &req.settings.modules;
    let n = ctx.n;
    let work_rate = ctx.work_rate;
    let mut rnotes: Vec<String> = Vec::new();
    emit("stems", 5.0);
    if !ctx.stem_mode
        && (req.settings.vocal_level_db.abs() > 1e-6
            || req.settings.vocal_presence_db.abs() > 1e-6
            || req.settings.vocal_air_db.abs() > 1e-6)
    {
        rnotes.push("纯母带模式下人声相关参数不生效，已忽略".to_string());
    }
    // --- Stem chains at 44.1k -> delta; sequential so peak memory stays
    // bounded (each stem decoded, processed, dropped in turn).
    let mut d44_l: Vec<f32> = Vec::new();
    let mut d44_r: Vec<f32> = Vec::new();
    if ctx.stem_mode {
        let n_stems = req.stems.len();
        // Resolve every stem's 44.1k PCM once: from the prepare cache when
        // available, otherwise decode+resample all stems in parallel.
        let owned: Vec<(Vec<f32>, Vec<f32>)>;
        let pcm: &[(Vec<f32>, Vec<f32>)] = match &ctx.stem_pcm {
            Some(v) => v.as_slice(),
            None => {
                let _t = StageTimer::new("stem_decode");
                owned = std::thread::scope(|scope| -> Result<Vec<_>> {
                    let hs: Vec<_> = req
                        .stems
                        .iter()
                        .map(|st| {
                            scope.spawn(move || {
                                let d = decode_audio_file(&st.file_path)
                                    .map_err(|e| {
                                        anyhow!(
                                            "读取分轨 {} 失败: {e}",
                                            st.file_path
                                        )
                                    })?;
                                let sr_in = d.sample_rate;
                                let (sl, sr_) = d.to_stereo_planar();
                                drop(d);
                                Ok(resample_hq_stereo(&sl, &sr_, sr_in, 44_100))
                            })
                        })
                        .collect();
                    hs.into_iter()
                        .map(|h| {
                            h.join()
                                .map_err(|_| anyhow!("分轨解码线程异常终止"))
                                .and_then(|r| r)
                        })
                        .collect()
                })?;
                &owned
            }
        };
        // Sidechain for `other` ducking = summed unprocessed lead-vocal
        // stems (independent of the processed chain output).
        let mut lead_sum: Option<(Vec<f32>, Vec<f32>)> = None;
        for (i, st) in req.stems.iter().enumerate() {
            if matches!(stem_role(st), StemRole::Lead) {
                let (sl44, sr44) = (pcm[i].0.as_slice(), pcm[i].1.as_slice());
                match &mut lead_sum {
                    Some((a, b)) => {
                        let len = a.len().min(sl44.len());
                        for i in 0..len {
                            a[i] += sl44[i];
                            b[i] += sr44[i];
                        }
                    }
                    None => lead_sum = Some((sl44.to_vec(), sr44.to_vec())),
                }
            }
        }
        let lead_ref = &lead_sum;
        // One chain per stem -> (processed L, R, notes). Chains are
        // independent pure DSP, so they parallelize; `other` only reads
        // the raw lead sidechain computed above.
        let process = |idx: usize| -> (Vec<f32>, Vec<f32>, Vec<String>) {
            let st = &req.stems[idx];
            let _t = StageTimer::new(format!("chain_{:?}", stem_role(st)));
            let (sl44, sr44) = (pcm[idx].0.as_slice(), pcm[idx].1.as_slice());
            let mut n: Vec<String> = Vec::new();
            let vref = lead_ref
                .as_ref()
                .map(|(a, b)| (a.as_slice(), b.as_slice()));
            let (pl, pr) = match stem_role(st) {
                StemRole::Lead => {
                    let (mut pl, mut pr) =
                        chain_vocals(sl44, sr44, s, m, dyn_scale, true);
                    apply_vocal_tone(&mut pl, &mut pr, &req.settings);
                    (pl, pr)
                }
                StemRole::Backing => {
                    // Backing vocals: gentler vocal chain, no +1 dB lift.
                    chain_vocals(sl44, sr44, s * 0.6, m, dyn_scale, false)
                }
                StemRole::Drums => {
                    let (mut pl, mut pr) = chain_drums(sl44, sr44, s, m, &ctx.before);
                    // Drum reinforcement: add real-kit hits on top of the
                    // processed stem (part of the delta). Not scaled by
                    // the global strength.
                    if m.drum_replace {
                        if let Some(kit) = ctx.drum_kit.as_ref() {
                            let hits =
                                drum_hits::detect_hits(sl44, sr44, 44_100.0);
                            let g = drum_hits::gate_hits(
                                &hits, sl44, sr44, 44_100.0,
                            );
                            if g.disabled {
                                n.push(
                                    "鼓点不够规整，已跳过鼓替换".to_string()
                                );
                            } else {
                                let mut hits = g.hits;
                                drum_hits::assign_polarity(
                                    &mut hits, kit, sl44, sr44, 44_100.0,
                                );
                                let (mut nk, mut ns) = (0usize, 0usize);
                                for h in &hits {
                                    match h.class {
                                        drum_hits::DrumClass::Kick => nk += 1,
                                        drum_hits::DrumClass::Snare => ns += 1,
                                        drum_hits::DrumClass::Hihat => {}
                                    }
                                }
                                let rbuf = drum_hits::render_reinforcement(
                                    &hits, kit, sl44, sr44, 44_100.0,
                                );
                                let amount = req.settings.drum_replace_amount as f32;
                                let len = pl.len().min(rbuf.len());
                                for i in 0..len {
                                    pl[i] += amount * rbuf[i];
                                    pr[i] += amount * rbuf[i];
                                }
                                n.push(format!(
                                    "叠加真实鼓：底鼓 {nk}/{}、军鼓 {ns}/{}",
                                    g.raw[0], g.raw[1]
                                ));
                            }
                        } else {
                            n.push(
                                "鼓替换已开启但鼓件加载失败，已跳过".to_string()
                            );
                        }
                    }
                    (pl, pr)
                }
                // Percussion gets the drums chain but no hit reinforcement.
                StemRole::Perc => chain_drums(sl44, sr44, s, m, &ctx.before),
                StemRole::Bass => chain_bass(sl44, sr44, s, m, dyn_scale),
                StemRole::Other => {
                    chain_other(sl44, sr44, s, m, &ctx.before, vref, ctx.vocals_weak, &mut n)
                }
            };
            (pl, pr, n)
        };
        let results: Vec<(Vec<f32>, Vec<f32>, Vec<String>)> = if parallel_stems
        {
            let emit_m = std::sync::Mutex::new(&mut *emit);
            let done = std::sync::atomic::AtomicUsize::new(0);
            std::thread::scope(|scope| {
                let process = &process;
                let done = &done;
                let emit_m = &emit_m;
                let hs: Vec<_> = (0..n_stems)
                    .map(|i| {
                        scope.spawn(move || {
                            let r = process(i);
                            let c = done
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                                + 1;
                            if let Ok(mut e) = emit_m.lock() {
                                e(
                                    "stems",
                                    5.0 + 35.0 * c as f32 / n_stems.max(1) as f32,
                                );
                            }
                            r
                        })
                    })
                    .collect();
                hs.into_iter()
                    .map(|h| h.join().expect("分轨处理线程异常终止"))
                    .collect()
            })
        } else {
            (0..n_stems)
                .enumerate()
                .map(|(seq, i)| {
                    let r = process(i);
                    emit(
                        "stems",
                        5.0 + 35.0 * (seq + 1) as f32 / n_stems.max(1) as f32,
                    );
                    r
                })
                .collect()
        };
        // Sum deltas in stem-index order so the output is identical no
        // matter the completion order.
        for (i, (pl, pr, n2)) in results.into_iter().enumerate() {
            rnotes.extend(n2);
            let (sl44, sr44) = (pcm[i].0.as_slice(), pcm[i].1.as_slice());
            let len = sl44.len().min(sr44.len());
            if d44_l.len() < len {
                d44_l.resize(len, 0.0);
                d44_r.resize(len, 0.0);
            }
            for i in 0..len {
                d44_l[i] += pl[i] - sl44[i];
                d44_r[i] += pr[i] - sr44[i];
            }
        }
    }
    emit("stems", 45.0);

    // Resample delta to work rate, y = x + D.
    let (dw_l, dw_r) = if d44_l.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        {
            let _t = StageTimer::new("delta_resample");
            resample_hq_stereo(&d44_l, &d44_r, 44_100, work_rate)
        }
    };
    drop((d44_l, d44_r));
    let mut y_l = ctx.xw_l[..n].to_vec();
    let mut y_r = ctx.xw_r[..n].to_vec();
    for i in 0..n.min(dw_l.len().min(dw_r.len())) {
        y_l[i] += dw_l[i];
        y_r[i] += dw_r[i];
    }
    drop((dw_l, dw_r));
    emit("master", 50.0);

    // `yb` = master-bus output, pre-limiter.
    let _t_master = StageTimer::new("master_bus");
    let (yb_l, yb_r) = master_bus(
        &y_l,
        &y_r,
        work_rate as f64,
        s,
        &req.settings,
        &ctx.before,
        ctx.stem_mode,
        dyn_scale,
        if m.reference_match {
            ctx.ref_ctx
                .as_ref()
                .map(|(_, rm, rs, _)| (rm.as_slice(), rs.as_slice()))
        } else {
            None
        },
        (req.settings.match_amount as f64 * s).min(1.0),
    );
    drop((y_l, y_r));
    drop(_t_master);

    // --- Loudness matching + limiter ---
    let _t_limit = StageTimer::new("loudness_limit");
    emit("limit", 75.0);
    // follow_reference_loudness overrides the user target.
    let target_lufs = if req.settings.follow_reference_loudness {
        ctx.ref_ctx
            .as_ref()
            .map(|(_, _, _, ri)| ri.clamp(-16.0, -9.0))
            .unwrap_or(req.settings.target_lufs)
    } else {
        req.settings.target_lufs
    };
    let limit_once = |gain_db: f64,
                      l: &[f32],
                      r: &[f32]|
     -> (Vec<f32>, Vec<f32>, super::dsp::limiter::LimiterStats) {
        let g = 10f64.powf(gain_db / 20.0) as f32;
        let gl: Vec<f32> = l.iter().map(|&v| v * g).collect();
        let gr: Vec<f32> = r.iter().map(|&v| v * g).collect();
        // 0.03 dB margin so the BS.1770 TP meter never reads a hair
        // above the ceiling (the diagnose warn threshold is TP > -1.0).
        limit_stereo(&gl, &gr, work_rate as f64, req.settings.ceiling_dbtp - 0.03)
    };
    let (y_l, y_r, limiter_avg_gr);
    if m.loudness {
        let _t = StageTimer::new("lufs_pre");
        let i_pre = loudness::integrated_lufs(&[yb_l.clone(), yb_r.clone()], work_rate);
        drop(_t);
        let mut pre_gain_db = if i_pre.is_finite() {
            (target_lufs - i_pre).min(12.0)
        } else {
            0.0
        };
        let mut last_gr = 0.0;
        let mut ol = yb_l.clone();
        let mut or_ = yb_r.clone();
        for _iter in 0..3 {
            let _t = StageTimer::new(format!("limit_iter_{_iter}"));
            let (a, b, st) = limit_once(pre_gain_db, &yb_l, &yb_r);
            let i_post = loudness::integrated_lufs(&[a.clone(), b.clone()], work_rate);
            ol = a;
            or_ = b;
            last_gr = st.avg_gr_db;
            if !i_post.is_finite() || (target_lufs - i_post).abs() <= 0.02 {
                break;
            }
            pre_gain_db = (pre_gain_db + target_lufs - i_post).min(12.0);
        }
        // If reaching target costs > 3 dB average GR, stop at the loudness
        // achievable with ~3 dB and note it. GR is not linear in pre-gain,
        // so iterate the back-off a few times.
        if last_gr > 3.0 {
            // Predict the GR-vs-gain curve on one 4x peak profile (cheap),
            // pick the highest gain at predicted ~2.9 dB, verify for real.
            let _t = StageTimer::new("peak_profile_4x");
            let profile = super::dsp::limiter::peak_profile_4x(&yb_l, &yb_r);
            drop(_t);
            let mut lo = pre_gain_db - 20.0;
            let mut hi = pre_gain_db;
            for _ in 0..24 {
                if hi - lo < 0.05 {
                    break;
                }
                let g = (lo + hi) / 2.0;
                let gr = super::dsp::limiter::predict_avg_gr_db(
                    &profile, work_rate as f64 * 4.0, g, 10f64.powf((req.settings.ceiling_dbtp - 0.03) / 20.0),
                );
                if gr > 2.9 {
                    hi = g;
                } else {
                    lo = g;
                }
            }
            let mut g_try = lo;
            for _ in 0..3 {
                let (a, b, st) = limit_once(g_try, &yb_l, &yb_r);
                ol = a;
                or_ = b;
                last_gr = st.avg_gr_db;
                if last_gr <= 3.3 {
                    break;
                }
                g_try -= (last_gr - 3.0).max(0.2);
            }
            let reached = loudness::integrated_lufs(&[ol.clone(), or_.clone()], work_rate);
            rnotes.push(format!("为保护动态，响度停在 {reached:.1} LUFS"));
        }
        y_l = ol;
        y_r = or_;
        limiter_avg_gr = last_gr;
    } else {
        let (a, b, st) = limit_once(0.0, &yb_l, &yb_r);
        y_l = a;
        y_r = b;
        limiter_avg_gr = st.avg_gr_db;
    }
    Ok((y_l, y_r, limiter_avg_gr, rnotes))
}

/// LRA guard: if the render flattened macro-dynamics beyond 1 LU,
/// re-render with dynamics scaled down (max 2 retries).
pub(crate) fn render_lra_guarded(
    ctx: &RestoreCtx,
    req: &RestoreRequest,
    emit: &mut (dyn FnMut(&str, f32) + Send),
    notes: &mut Vec<String>,
    parallel_stems: bool,
) -> Result<(Vec<f32>, Vec<f32>, f64)> {
    let mut dyn_scale = 1.0f64;
    let mut attempts = 0usize;
    loop {
        let (a, b, gr, rnotes) =
            render_stems(ctx, req, dyn_scale, emit, parallel_stems)?;
        let _t = StageTimer::new("lra_measure");
        let lra_out = loudness::loudness_range_lu(&[a.clone(), b.clone()], ctx.work_rate);
        drop(_t);
        if attempts < 2
            && ctx.before.lra_lu.is_finite()
            && lra_out.is_finite()
            && lra_out < ctx.before.lra_lu - 1.0
        {
            dyn_scale *= 0.5;
            attempts += 1;
            notes.extend(rnotes);
            notes.push(format!(
                "检测到响度范围压缩过度（LRA {:.1}→{:.1} LU），已降低压缩/饱和强度重渲染",
                ctx.before.lra_lu, lra_out
            ));
            continue;
        }
        notes.extend(rnotes);
        return Ok((a, b, gr));
    }
}

/// Write the render, re-analyze, assemble notes/reference/objective/critic.
pub(crate) fn finish_render(
    ctx: &RestoreCtx,
    req: &RestoreRequest,
    y_l: Vec<f32>,
    y_r: Vec<f32>,
    limiter_avg_gr: f64,
    mut notes: Vec<String>,
    emit: &mut (dyn FnMut(&str, f32) + Send),
    t0: Instant,
    critic: CriticFn<'_>,
) -> Result<RestoreResult> {
    emit("write", 92.0);
    let out_path = match &req.output_path {
        Some(p) => p.clone(),
        None => {
            let dir = renders_dir()?;
            std::fs::create_dir_all(&dir)?;
            let stem_name = Path::new(&req.source_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("audio");
            let s = req.settings.strength as f64;
            let tag = if s <= 0.75 { "light" } else if s >= 1.25 { "strong" } else { "standard" };
            dir.join(format!("{stem_name}_restored_{tag}.wav"))
                .to_string_lossy()
                .to_string()
        }
    };
    let bit_depth = if req.settings.bit_depth == 16 { 16 } else { 24 };
    let _t = StageTimer::new("write_wav");
    if bit_depth == 24 {
        write_stereo_wav_i24(Path::new(&out_path), &y_l, &y_r, ctx.work_rate)?;
    } else {
        write_stereo_wav_i16_tpdf(Path::new(&out_path), &y_l, &y_r, ctx.work_rate)?;
    }
    drop(_t);
    emit("report", 97.0);
    // Output critic runs concurrently with the report analysis — both
    // only need the written file.
    let (after, critic) = std::thread::scope(|scope| {
        let critic = scope.spawn(|| {
            let _t = StageTimer::new("critic_out");
            critic(&out_path)
        });
        let _t = StageTimer::new("analyze_output");
        (analyze_quality(&out_path), critic.join().ok().flatten())
    });
    let after = after?;
    let critic = critic;
    let loudness_match = if ctx.before.integrated_lufs.is_finite() && after.integrated_lufs.is_finite() {
        ctx.before.integrated_lufs - after.integrated_lufs
    } else {
        0.0
    };
    emit("report", 100.0);
    // De-duplicate notes (per-stem chains can emit the same message).
    let mut seen = std::collections::HashSet::new();
    notes.retain(|n| seen.insert(n.clone()));
    // Reference spectral distance: source-vs-ref and output-vs-ref on the
    // normalized mid LTAS, 1/3-oct bands 60 Hz-12 kHz.
    let reference = ctx.ref_ctx.as_ref().map(|(rep, rm, _rs, _ri)| {
        let d_before = super::refmatch::spectral_distance(&ctx.before.ltas, rm);
        let d_after = super::refmatch::spectral_distance(&after.ltas, rm);
        ReferenceInfo {
            path: req.settings.reference_path.clone().unwrap_or_default(),
            report: rep.clone(),
            distance_before_db: d_before,
            distance_after_db: d_after,
        }
    });
    // Rule-based objective score vs the effective loudness target used.
    let effective_target = if req.settings.follow_reference_loudness {
        ctx.ref_ctx
            .as_ref()
            .map(|(_, _, _, ri)| ri.clamp(-16.0, -9.0))
            .unwrap_or(req.settings.target_lufs)
    } else {
        req.settings.target_lufs
    };
    let objective = Some(super::quality::objective::score(
        &after,
        &ctx.before,
        effective_target,
        req.settings.ceiling_dbtp,
    ));

    Ok(RestoreResult {
        output_path: out_path,
        sample_rate: ctx.work_rate,
        bit_depth,
        before: ctx.before.clone(),
        after,
        loudness_match_db: loudness_match,
        limiter_avg_gr_db: limiter_avg_gr,
        notes,
        elapsed_ms: t0.elapsed().as_millis() as u64,
        reference,
        objective,
        critic,
        critic_before: None,
        guard_rung: None,
    })
}

/// Audiobox Aesthetics score when the model is installed; silently None.
pub(crate) fn critic_score_opt(path: &str) -> Option<super::quality::critic::CriticScore> {
    match crate::ml::audiobox_aes_model_path() {
        Ok(p) if p.exists() => super::quality::critic::score_audio(path).ok(),
        _ => None,
    }
}

/// Critic scorer injected into the render path so tests can fake the
/// model without global state.
type CriticFn<'a> = &'a (dyn Fn(&str) -> Option<super::quality::critic::CriticScore> + Sync);

/// PQ drop vs input that triggers a lighter guard rung.
const PQ_GUARD_TOLERANCE: f64 = 0.10;

/// The request for a PQ-guard rung. rung 0 = the request as given;
/// rung 1 ("half") halves the perceptually risky modules; rung 2
/// ("minimal") disables all eight module amounts plus the optional
/// bool/tone processors, leaving only loudness + true-peak handling.
fn ladder_request(req: &RestoreRequest, rung: usize) -> RestoreRequest {
    let mut r = req.clone();
    match rung {
        1 => {
            let m = &mut r.settings.modules;
            m.vocal_cleanup *= 0.5;
            m.shimmer *= 0.5;
            m.glue *= 0.5;
            m.vocal_space *= 0.5;
        }
        _ => {
            let m = &mut r.settings.modules;
            m.vocal_cleanup = 0.0;
            m.shimmer = 0.0;
            m.drum_punch = 0.0;
            m.low_end = 0.0;
            m.width = 0.0;
            m.vocal_space = 0.0;
            m.hf_restore = 0.0;
            m.glue = 0.0;
            m.loudness = true;
            m.reference_match = false;
            m.drum_replace = false;
            r.settings.vocal_level_db = 0.0;
            r.settings.vocal_presence_db = 0.0;
            r.settings.vocal_air_db = 0.0;
            r.settings.low_shelf_db = 0.0;
            r.settings.high_shelf_db = 0.0;
        }
    }
    r
}

const RUNG_NAMES: [&str; 3] = ["full", "half", "minimal"];

/// Render + analyze one candidate, guarded by the critic: when the output
/// drops PQ by more than 0.10 vs the input, walk a ladder of lighter
/// settings (F full → H half → M minimal) and keep the most-processed
/// rung that stays within tolerance; if none does, keep the highest-PQ
/// candidate. Without the critic the requested render is returned as-is.
/// Compare/agent apply their own acceptance rules on top.
pub(crate) fn render_with_pq_guard(
    ctx: &RestoreCtx,
    req: &RestoreRequest,
    emit: &mut (dyn FnMut(&str, f32) + Send),
    mut notes: Vec<String>,
    t0: Instant,
    pq_in: &dyn Fn() -> Option<f64>,
    critic: CriticFn<'_>,
    parallel_stems: bool,
) -> Result<RestoreResult> {
    let (y_l, y_r, gr) =
        render_lra_guarded(ctx, req, emit, &mut notes, parallel_stems)?;
    let res = finish_render(ctx, req, y_l, y_r, gr, notes, emit, t0, critic)?;
    // Resolved after the F render, so an overlapped input-critic thread
    // has long finished.
    let Some(pq_in) = pq_in() else {
        return Ok(res);
    };
    let pq_of = |r: &RestoreResult| {
        r.critic
            .as_ref()
            .map(|c| c.pq as f64)
            .unwrap_or(f64::NEG_INFINITY)
    };
    let out_final = res.output_path.clone();
    let mut cands: Vec<(usize, RestoreResult)> = vec![(0, res)];
    if pq_of(&cands[0].1) < pq_in - PQ_GUARD_TOLERANCE {
        for rung in [1usize, 2usize] {
            let mut rreq = ladder_request(req, rung);
            rreq.output_path = Some(format!("{out_final}.pq{rung}.wav"));
            let mut n = ctx.notes.clone();
            let (a, b, g) =
                render_lra_guarded(ctx, &rreq, emit, &mut n, parallel_stems)?;
            let r = finish_render(ctx, &rreq, a, b, g, n, emit, t0, critic)?;
            let qualifies = pq_of(&r) >= pq_in - PQ_GUARD_TOLERANCE;
            cands.push((rung, r));
            if qualifies {
                break;
            }
        }
    }
    // Lowest rung within tolerance wins; otherwise the highest PQ.
    let pick = cands
        .iter()
        .position(|(_, r)| pq_of(r) >= pq_in - PQ_GUARD_TOLERANCE)
        .unwrap_or_else(|| {
            cands
                .iter()
                .enumerate()
                .max_by(|a, b| pq_of(&a.1 .1).partial_cmp(&pq_of(&b.1 .1)).unwrap())
                .map(|(i, _)| i)
                .unwrap_or(0)
        });
    let mut winner = None;
    for (i, (rung, mut r)) in cands.into_iter().enumerate() {
        if i == pick {
            r.guard_rung = Some(RUNG_NAMES[rung].to_string());
            match rung {
                1 => r
                    .notes
                    .push("AI 评分提示处理过度，已减轻处理".to_string()),
                2 => r.notes.push(
                    "这首歌原本质量不错，进一步处理反而扣分，只做了响度与峰值".to_string(),
                ),
                _ => {}
            }
            if r.output_path != out_final {
                let _ = std::fs::remove_file(&out_final);
                std::fs::rename(&r.output_path, &out_final)?;
                r.output_path = out_final.clone();
            }
            winner = Some(r);
        } else if rung > 0 {
            let _ = std::fs::remove_file(&r.output_path);
        }
    }
    Ok(winner.expect("at least the full rung exists"))
}

/// One candidate of the three-strength comparison.
#[derive(Debug, Clone, Serialize)]
pub struct CompareCandidate {
    pub strength: f32,
    pub strength_label: String,
    pub output_path: String,
    pub after: QualityReport,
    pub objective: super::quality::objective::ObjectiveScore,
    pub critic: Option<super::quality::critic::CriticScore>,
    pub notes: Vec<String>,
    #[serde(default)]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CompareResult {
    pub before: QualityReport,
    pub candidates: Vec<CompareCandidate>,
    /// Index into `candidates`.
    pub recommended: usize,
    pub reason: String,
    pub critic_before: Option<super::quality::critic::CriticScore>,
    pub elapsed_ms: u64,
}

/// Render light/standard/strong candidates sharing the decode + analysis
/// preamble and (within a memory cap) the decoded stems; pick a
/// recommendation from the rule-based objective score. PQ is display +
/// catastrophe guard only — a candidate whose PQ drops > 0.3 vs the input
/// is warned and never recommended.
pub fn run_restore_compare(
    req: &RestoreRequest,
    mut emit: impl FnMut(&str, f32) + Send,
) -> Result<CompareResult> {
    let t0 = Instant::now();
    let mut owned;
    let req = {
        owned = req.clone();
        owned.settings = owned.settings.clamped();
        &owned
    };
    // Score the input concurrently with decode+analysis; only needed
    // once candidates start finishing.
    let critic_before = std::thread::scope(|scope| {
        let get_in = lazy_score(scope, &critic_score_opt, &req.source_path);
        let ctx = prepare_restore(req, &mut emit, true)?;
        Ok::<_, anyhow::Error>((ctx, get_in()))
    }).map(|(c, b)| (c, b));
    let (ctx, critic_before) = critic_before?;
    let stem_name = Path::new(&req.source_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("audio")
        .to_string();
    std::fs::create_dir_all(renders_dir()?)?;
    let stages = [
        (0.5f32, "轻", "compare_light", "light"),
        (1.0, "标准", "compare_standard", "standard"),
        (1.5, "重", "compare_strong", "strong"),
    ];
    // Render the three candidates in parallel — the DSP is CPU-bound and
    // mostly single-threaded, so wall time stays close to 2x one render.
    let pcts = std::sync::Mutex::new([0.0f32; 3]);
    let emit_m = std::sync::Mutex::new(&mut emit);
    let results: Vec<Result<RestoreResult>> = std::thread::scope(|scope| {
        let handles: Vec<_> = stages
            .iter()
            .enumerate()
            .map(|(i, (strength, _label, stage, tag))| {
                let pcts = &pcts;
                let emit_m = &emit_m;
                let ctx = &ctx;
                let stem_name = &stem_name;
                let critic_before = &critic_before;
                scope.spawn(move || -> Result<RestoreResult> {
                    let mut creq = req.clone();
                    creq.settings.strength = *strength;
                    creq.output_path = Some(
                        renders_dir()?
                            .join(format!("{stem_name}_restored_{tag}.wav"))
                            .to_string_lossy()
                            .to_string(),
                    );
                    let mut scaled = |_st: &str, p: f32| {
                        {
                            let mut arr = pcts.lock().unwrap();
                            arr[i] = p.clamp(0.0, 100.0);
                        }
                        let arr = pcts.lock().unwrap();
                        let mean = arr.iter().sum::<f32>() / 3.0;
                        drop(arr);
                        if let Ok(mut e) = emit_m.lock() {
                            (*e)(stage, mean);
                        }
                    };
                    let pq_in = || critic_before.as_ref().map(|c| c.pq as f64);
                    render_with_pq_guard(
                        ctx,
                        &creq,
                        &mut scaled,
                        ctx.notes.clone(),
                        t0,
                        &pq_in,
                        &critic_score_opt,
                        false,
                    )
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .map_err(|_| anyhow!("对比渲染线程异常终止"))
                    .and_then(|r| r)
            })
            .collect()
    });
    let mut candidates: Vec<CompareCandidate> = Vec::new();
    for (res, (strength, label, _stage, _tag)) in
        results.into_iter().zip(stages.iter())
    {
        let res = res?;
        let mut warning = None;
        if let (Some(ci), Some(co)) = (&critic_before, &res.critic) {
            if co.pq < ci.pq - 0.3 {
                warning = Some(format!(
                    "AI 评分大幅下降（PQ {:.1} → {:.1}），疑似音质受损，不推荐",
                    ci.pq, co.pq
                ));
            }
        }
        candidates.push(CompareCandidate {
            strength: *strength,
            strength_label: (*label).to_string(),
            output_path: res.output_path,
            after: res.after,
            objective: res
                .objective
                .expect("finish_render always sets objective"),
            critic: res.critic,
            notes: res.notes,
            warning,
        });
    }
    // Recommended = lightest eligible strength whose S <= min(S) + 0.5
    // (能修好就不过度处理); warned candidates are never recommended.
    let min_s = candidates
        .iter()
        .filter(|c| c.warning.is_none())
        .map(|c| c.objective.score)
        .fold(f64::INFINITY, f64::min);
    let recommended = if min_s.is_finite() {
        candidates
            .iter()
            .position(|c| c.warning.is_none() && c.objective.score <= min_s + 0.5)
            .unwrap_or(0)
    } else {
        0
    };
    let best = candidates
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            a.objective
                .score
                .partial_cmp(&b.objective.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(i, _)| i)
        .unwrap_or(0);
    let reason = if recommended == best {
        format!(
            "{}档规则评分最低（S={:.1}），已满足要求",
            candidates[recommended].strength_label,
            candidates[recommended].objective.score
        )
    } else {
        format!(
            "{}档问题最少（S={:.1}）；{}档评分接近（S={:.1}），没有更好只是处理更多，推荐更轻档",
            candidates[best].strength_label,
            candidates[best].objective.score,
            candidates[recommended].strength_label,
            candidates[recommended].objective.score
        )
    };
    emit("report", 100.0);
    Ok(CompareResult {
        before: ctx.before,
        candidates,
        recommended,
        reason,
        critic_before,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

pub(crate) fn renders_dir() -> Result<std::path::PathBuf> {
    let base = dirs::data_dir().ok_or_else(|| anyhow!("无法定位应用数据目录"))?;
    Ok(base.join("StemScribe").join("renders"))
}

/// 16-bit WAV with TPDF dither.
pub fn write_stereo_wav_i16_tpdf(
    path: &Path,
    left: &[f32],
    right: &[f32],
    sample_rate: u32,
) -> Result<()> {
    use hound::{SampleFormat, WavSpec, WavWriter};
    let spec = WavSpec {
        channels: 2,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec)?;
    let len = left.len().min(right.len());
    let mut seed = 0x9E3779B97F4A7C15u64;
    let mut rng = move || -> f64 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as f64 / u32::MAX as f64
    };
    let lsb = 1.0 / 32768.0f64;
    for i in 0..len {
        for v in [left[i], right[i]] {
            let dither = (rng() + rng() - 1.0) * lsb; // TPDF ±1 LSB
            let q = ((v as f64 + dither) * 32768.0).round().clamp(-32768.0, 32767.0) as i16;
            writer.write_sample(q)?;
        }
    }
    writer.finalize()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    /// Tests must never consult the real critic model (installed on dev
    /// machines) — the PQ guard would re-route synthetic renders.
    fn no_critic(_: &str) -> Option<crate::audio::quality::critic::CriticScore> {
        None
    }

    use super::*;
    use crate::audio::write_stereo_wav_f32;

    fn write_test_wav(path: &std::path::Path, dur_s: f64, sr: u32) {
        let n = (dur_s * sr as f64) as usize;
        let l: Vec<f32> = (0..n)
            .map(|i| {
                (0.2 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / sr as f64).sin()) as f32
            })
            .collect();
        let r: Vec<f32> = (0..n)
            .map(|i| {
                (0.2 * (2.0 * std::f64::consts::PI * 554.0 * i as f64 / sr as f64).sin()) as f32
            })
            .collect();
        write_stereo_wav_f32(path, &l, &r, sr).unwrap();
    }

    #[test]
    fn all_modules_off_is_null() {
        let dir = std::env::temp_dir().join("stemscribe_restore_test");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("null_src.wav");
        let out = dir.join("null_out.wav");
        write_test_wav(&src, 2.0, 44100);
        let mut settings = RestoreSettings::default();
        settings.modules = RestoreModules {
            vocal_cleanup: 0.0,
            shimmer: 0.0,
            drum_punch: 0.0,
            low_end: 0.0,
            width: 0.0,
            vocal_space: 0.0,
            hf_restore: 0.0,
            glue: 0.0,
            loudness: false,
            ..Default::default()
        };
        let req = RestoreRequest {
            source_path: src.to_string_lossy().to_string(),
            stems: vec![],
            settings,
            output_path: Some(out.to_string_lossy().to_string()),
        };
        let res = run_restore_inner(&req, |_, _| {}, &no_critic).unwrap();
        let d = decode_audio_file(&res.output_path).unwrap();
        let (ol, or_) = d.to_stereo_planar();
        let d0 = decode_audio_file(&src.to_string_lossy().to_string()).unwrap();
        let (xl, xr) = d0.to_stereo_planar();
        let n = ol.len().min(xl.len());
        assert_eq!(ol.len(), xl.len(), "output length must equal source length");
        let mut e = 0.0f64;
        let mut x_e = 0.0f64;
        for i in 0..n {
            e += ((ol[i] - xl[i]) as f64).powi(2) + ((or_[i] - xr[i]) as f64).powi(2);
            x_e += (xl[i] as f64).powi(2) + (xr[i] as f64).powi(2);
        }
        let err_db = 10.0 * (e / x_e.max(1e-30)).log10();
        assert!(err_db <= -120.0, "null error {err_db:.1} dB");
    }

    /// PQ-guard ladder with a fake critic: staged scores per rung output
    /// file (.wav = full, .pq1. = half, .pq2. = minimal).
    #[test]
    fn pq_guard_ladder_picks_lightest_qualifying_rung() {
        use crate::audio::quality::critic::CriticScore;
        let dir = std::env::temp_dir().join(format!("stemscribe_ladder_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.wav");
        write_test_wav(&src, 1.0, 44100);
        let mk_req = |name: &str| RestoreRequest {
            source_path: src.to_string_lossy().to_string(),
            stems: vec![],
            settings: RestoreSettings::default(),
            output_path: Some(dir.join(name).to_string_lossy().to_string()),
        };
        let run = |name: &str, f: f64, h: f64, m: f64| {
            let critic = move |p: &str| {
                let pq = if p.contains(".pq2.") {
                    m
                } else if p.contains(".pq1.") {
                    h
                } else {
                    f
                };
                Some(CriticScore {
                    ce: 0.0,
                    cu: 0.0,
                    pc: 0.0,
                    pq: pq as f32,
                    duration_sec: 0.0,
                    windows: vec![],
                })
            };
            let req = mk_req(name);
            let mut em = |_: &str, _: f32| {};
            let ctx = prepare_restore(&req, &mut em, false).unwrap();
            render_with_pq_guard(
                &ctx,
                &req,
                &mut em,
                ctx.notes.clone(),
                Instant::now(),
                &|| Some(7.0),
                &critic,
                false,
            )
            .unwrap()
        };

        // F fails, H fails, M passes -> minimal.
        let r = run("a.wav", 5.0, 5.5, 6.95);
        assert_eq!(r.guard_rung.as_deref(), Some("minimal"));
        assert!(r.notes.iter().any(|n| n.contains("只做了响度与峰值")));
        assert_eq!(r.output_path, dir.join("a.wav").to_string_lossy());
        assert!(!dir.join("a.wav.pq1.wav").exists(), "loser files deleted");
        assert!(!dir.join("a.wav.pq2.wav").exists());

        // F fails, H passes -> half, M never rendered.
        let r = run("b.wav", 5.0, 6.95, 9.0);
        assert_eq!(r.guard_rung.as_deref(), Some("half"));
        assert!(r.notes.iter().any(|n| n.contains("已减轻处理")));
        assert_eq!(r.output_path, dir.join("b.wav").to_string_lossy());
        assert!(!dir.join("b.wav.pq2.wav").exists());

        // None qualifies -> highest PQ (H).
        let r = run("c.wav", 4.0, 4.5, 4.2);
        assert_eq!(r.guard_rung.as_deref(), Some("half"));
        assert_eq!(r.output_path, dir.join("c.wav").to_string_lossy());

        // F within tolerance -> full, nothing else rendered.
        let r = run("d.wav", 6.95, 9.0, 9.0);
        assert_eq!(r.guard_rung.as_deref(), Some("full"));
        assert!(!dir.join("d.wav.pq1.wav").exists());
    }

    #[test]
    fn zero_strength_delta_is_zero() {
        // Each chain at s=0 must be an exact bypass -> delta exactly zero.
        let n = 44100;
        let l: Vec<f32> = (0..n).map(|i| (i as f32 * 0.001).sin() * 0.3).collect();
        let r: Vec<f32> = (0..n).map(|i| (i as f32 * 0.0013).cos() * 0.3).collect();
        let m = RestoreModules::default();
        let diag = QualityReport {
            sample_rate: 44100,
            channels: 2,
            bit_depth: Some(32),
            duration_sec: 1.0,
            integrated_lufs: -20.0,
            lra_lu: 5.0,
            true_peak_dbtp: -3.0,
            sample_peak_dbfs: -3.0,
            cutoff_hz: Some(15000.0),
            low_mid_excess_db: 3.0,
            low_mid_center_hz: 300.0,
            harsh_peaks: vec![],
            stereo_correlation: 0.9,
            side_mid_ratio_db: -10.0,
            low_band_correlation: 0.9,
            clipped_runs: 0,
            dc_offset: [0.0, 0.0],
            ltas: vec![],
            issues: vec![],
        };
        let mut notes = vec![];
        for (pl, pr) in [
            chain_vocals(&l, &r, 0.0, &m, 1.0, true),
            chain_drums(&l, &r, 0.0, &m, &diag),
            chain_bass(&l, &r, 0.0, &m, 1.0),
            chain_other(&l, &r, 0.0, &m, &diag, None, false, &mut notes),
        ] {
            for i in 0..n {
                assert_eq!(pl[i] - l[i], 0.0);
                assert_eq!(pr[i] - r[i], 0.0);
            }
        }
    }

    /// Cross-correlation peak lag of `y` relative to `x` over [-64, 64]
    /// samples in a centred window.
    fn xcorr_lag(x: &[f32], y: &[f32], centre: usize, win: usize) -> i64 {
        let mut best_lag = 0i64;
        let mut best = f64::NEG_INFINITY;
        for lag in -64i64..=64 {
            let mut acc = 0.0f64;
            for i in 0..win {
                let xi = centre + i;
                let yi = centre as i64 + i as i64 - lag;
                if yi >= 0 && (yi as usize) < y.len() && xi < x.len() {
                    acc += x[xi] as f64 * y[yi as usize] as f64;
                }
            }
            if acc > best {
                best = acc;
                best_lag = lag;
            }
        }
        best_lag
    }

    #[test]
    fn full_restore_has_zero_lag() {
        // Broadband noise + impulses, all modules on at strength 1 — the
        // rendered output must stay sample-aligned with the source.
        let dir = std::env::temp_dir().join("stemscribe_restore_lag");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("lag_src.wav");
        let out = dir.join("lag_out.wav");
        let sr = 48000u32;
        let n = sr as usize * 4;
        let mut seed = 0xABCDEFu64;
        let mut rng = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as f64 / u32::MAX as f64) * 2.0 - 1.0
        };
        let mut l: Vec<f32> = (0..n).map(|_| (rng() * 0.15) as f32).collect();
        let mut r: Vec<f32> = (0..n).map(|_| (rng() * 0.15) as f32).collect();
        for i in (8000..n - 8000).step_by(48000 / 8) {
            l[i] = 0.9;
            r[i] = -0.9;
        }
        write_stereo_wav_f32(&src, &l, &r, sr).unwrap();
        let mut settings = RestoreSettings::default();
        settings.target_lufs = -20.0; // keep the limiter quiet
        let req = RestoreRequest {
            source_path: src.to_string_lossy().to_string(),
            stems: vec![],
            settings,
            output_path: Some(out.to_string_lossy().to_string()),
        };
        let res = run_restore_inner(&req, |_, _| {}, &no_critic).unwrap();
        let d = decode_audio_file(&res.output_path).unwrap();
        let (ol, or_) = d.to_stereo_planar();
        assert_eq!(ol.len(), n, "output length must equal source length");
        let c = n / 2 - 48000;
        assert_eq!(xcorr_lag(&l, &ol, c, 48000), 0, "restore lag L");
        assert_eq!(xcorr_lag(&r, &or_, c, 48000), 0, "restore lag R");
    }

    #[test]
    fn restore_with_reference_has_zero_lag() {
        // Reference matching enabled: output stays sample-aligned and the
        // spectral distance to the reference shrinks.
        let dir = std::env::temp_dir().join("stemscribe_restore_reflag");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("reflag_src.wav");
        let refp = dir.join("reflag_ref.wav");
        let out = dir.join("reflag_out.wav");
        let sr = 48000u32;
        let n = sr as usize * 4;
        let mut seed = 0xABCDEFu64;
        let mut rng = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as f64 / u32::MAX as f64) * 2.0 - 1.0
        };
        let mut l: Vec<f32> = (0..n).map(|_| (rng() * 0.15) as f32).collect();
        let mut r: Vec<f32> = (0..n).map(|_| (rng() * 0.15) as f32).collect();
        for i in (8000..n - 8000).step_by(48000 / 8) {
            l[i] = 0.9;
            r[i] = -0.9;
        }
        write_stereo_wav_f32(&src, &l, &r, sr).unwrap();
        // Reference = source with a +6 dB high shelf at 2 kHz (and a
        // low-shelf dip) so the match has real work to do.
        let mut hs = Biquad::high_shelf(sr as f64, 2000.0, 0.7, 6.0);
        let mut ls = Biquad::low_shelf(sr as f64, 200.0, 0.7, -3.0);
        let rl: Vec<f32> = l
            .iter()
            .map(|&v| ls.tick(hs.tick(v as f64)) as f32)
            .collect();
        let rr: Vec<f32> = r
            .iter()
            .map(|&v| ls.tick(hs.tick(v as f64)) as f32)
            .collect();
        write_stereo_wav_f32(&refp, &rl, &rr, sr).unwrap();

        let mut settings = RestoreSettings::default();
        settings.target_lufs = -20.0;
        settings.match_amount = 1.0;
        settings.reference_path = Some(refp.to_string_lossy().to_string());
        let req = RestoreRequest {
            source_path: src.to_string_lossy().to_string(),
            stems: vec![],
            settings,
            output_path: Some(out.to_string_lossy().to_string()),
        };
        let res = run_restore_inner(&req, |_, _| {}, &no_critic).unwrap();
        let ri = res.reference.expect("reference info missing");
        assert!(
            ri.distance_after_db < ri.distance_before_db,
            "distance {} -> {}",
            ri.distance_before_db,
            ri.distance_after_db
        );
        let d = decode_audio_file(&res.output_path).unwrap();
        let (ol, or_) = d.to_stereo_planar();
        assert_eq!(ol.len(), n, "output length must equal source length");
        let c = n / 2 - 48000;
        assert_eq!(xcorr_lag(&l, &ol, c, 48000), 0, "restore lag L (ref)");
        assert_eq!(xcorr_lag(&r, &or_, c, 48000), 0, "restore lag R (ref)");
    }

    #[test]
    fn restore_with_drum_replace_has_zero_lag() {
        // Drum reinforcement on a real drums stem: output stays
        // sample-aligned, and turning the module off leaves the delta
        // unchanged.
        let dir = std::env::temp_dir().join("stemscribe_restore_drumlag");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("drumlag_src.wav");
        let stem = dir.join("drumlag_drums.wav");
        let out = dir.join("drumlag_out.wav");
        let sr = 48000u32;
        let n = sr as usize * 3;
        let mut seed = 0x2468ACEu64;
        let mut rng = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as f64 / u32::MAX as f64) * 2.0 - 1.0
        };
        let l: Vec<f32> = (0..n).map(|_| (rng() * 0.1) as f32).collect();
        let r: Vec<f32> = (0..n).map(|_| (rng() * 0.1) as f32).collect();
        write_stereo_wav_f32(&src, &l, &r, sr).unwrap();
        // Drums stem rendered from the bundled kit.
        let kit = drum_hits::DrumKit::load(&drum_hits::kit_dir(), sr).unwrap();
        let mut dl = vec![0.0f32; n];
        let mut dr = vec![0.0f32; n];
        for (i, &t) in [0.4f64, 1.0, 1.6, 2.2].iter().enumerate() {
            let w = &kit.waves[0][3][i % 2];
            let start = (t * sr as f64) as usize;
            for (j, &s) in w.iter().enumerate() {
                if start + j < n {
                    dl[start + j] += s * 0.8;
                    dr[start + j] += s * 0.8;
                }
            }
        }
        write_stereo_wav_f32(&stem, &dl, &dr, sr).unwrap();

        let mk_req = |on: bool, outp: &Path| RestoreRequest {
            source_path: src.to_string_lossy().to_string(),
            stems: vec![StemIn {
                name: "drums".to_string(),
                file_path: stem.to_string_lossy().to_string(),
                role: String::new(),
            }],
            settings: RestoreSettings {
                target_lufs: -20.0,
                drum_replace_amount: 0.5,
                modules: RestoreModules {
                    drum_replace: on,
                    ..Default::default()
                },
                ..Default::default()
            },
            output_path: Some(outp.to_string_lossy().to_string()),
        };
        // No critic in tests: the PQ guard must not re-route this render.
        let res = run_restore_inner(&mk_req(true, &out), |_, _| {}, &no_critic).unwrap();
        assert!(
            res.notes.iter().any(|n| n.contains("叠加真实鼓")),
            "hit-count note missing: {:?}",
            res.notes
        );
        let d = decode_audio_file(&res.output_path).unwrap();
        let (ol, or_) = d.to_stereo_planar();
        assert_eq!(ol.len(), n);
        let c = n / 2 - 24000;
        assert_eq!(xcorr_lag(&l, &ol, c, 24000), 0, "restore lag L (drums)");
        assert_eq!(xcorr_lag(&r, &or_, c, 24000), 0, "restore lag R (drums)");
        // Module off: identical output to a run without the module.
        let off_out = dir.join("drumlag_off.wav");
        let res_off = run_restore_inner(&mk_req(false, &off_out), |_, _| {}, &no_critic).unwrap();
        assert!(
            !res_off.notes.iter().any(|n| n.contains("叠加真实鼓")),
            "off run must not render reinforcement"
        );
    }

    /// Band energy ratio of `x` in [lo, hi] Hz vs its total.
    fn band_energy_ratio(x: &[f32], sr: f64, lo: f64, hi: f64) -> f64 {
        let mut hp = Biquad::high_pass(sr, lo, std::f64::consts::FRAC_1_SQRT_2);
        let mut lp = Biquad::low_pass(sr, hi, std::f64::consts::FRAC_1_SQRT_2);
        let mut e_band = 0.0f64;
        let mut e_all = 0.0f64;
        for &v in x {
            let b = lp.tick(hp.tick(v as f64)) as f32;
            e_band += (b as f64).powi(2);
            e_all += (v as f64).powi(2);
        }
        e_band / e_all.max(1e-30)
    }

    #[test]
    fn vocal_space_runs_with_vocals_last() {
        // Stems in separator order (drums, bass, other, vocals): the
        // vocal-space duck on `other` must still run — vocals are
        // processed first and the sidechain is the raw vocal stem.
        let dir = std::env::temp_dir().join("stemscribe_restore_vspace");
        std::fs::create_dir_all(&dir).unwrap();
        let tau = std::f64::consts::TAU;
        let n = 44100usize * 2;
        let write_stem = |name: &str, f: f64, amp: f64, quiet_tail: bool| -> String {
            let p = dir.join(name);
            let l: Vec<f32> = (0..n)
                .map(|i| {
                    let t = i as f64 / 44100.0;
                    // Loud only for the first 20%: the p50 detector
                    // threshold then sits ~20 dB below the loud level.
                    let g = if quiet_tail && t >= 0.4 { 0.1 } else { 1.0 };
                    (amp * g * (tau * f * t).sin()) as f32
                })
                .collect();
            write_stereo_wav_f32(&p, &l, &l, 44100).unwrap();
            p.to_string_lossy().to_string()
        };
        let stems: Vec<StemIn> = [
            ("drums", write_stem("drums.wav", 150.0, 0.08, false)),
            ("bass", write_stem("bass.wav", 80.0, 0.08, false)),
            ("other", write_stem("other.wav", 2500.0, 0.12, false)),
            ("vocals", write_stem("vocals.wav", 2000.0, 0.30, true)),
        ]
        .iter()
        .map(|(name, file_path)| StemIn {
            name: name.to_string(),
            file_path: file_path.clone(),
            role: String::new(),
        })
        .collect();
        let src = dir.join("vs_src.wav");
        let sl: Vec<f32> = (0..48000 * 2)
            .map(|i| (0.1 * (tau * 700.0 * i as f64 / 48000.0).sin()) as f32)
            .collect();
        write_stereo_wav_f32(&src, &sl, &sl, 48000).unwrap();
        let mk = |vocal_space: bool, out: &std::path::Path| RestoreRequest {
            source_path: src.to_string_lossy().to_string(),
            stems: stems.clone(),
            settings: RestoreSettings {
                strength: 1.0,
                modules: RestoreModules {
                    vocal_cleanup: 0.0,
                    shimmer: 0.0,
                    drum_punch: 0.0,
                    low_end: 0.0,
                    width: 0.0,
                    vocal_space: if vocal_space { 1.0 } else { 0.0 },
                    hf_restore: 0.0,
                    glue: 0.0,
                    loudness: false,
                    ..Default::default()
                },
                ..RestoreSettings::default()
            },
            output_path: Some(out.to_string_lossy().to_string()),
        };
        let a = run_restore_inner(&mk(true, &dir.join("vs_on.wav")), |_, _| {}, &no_critic).unwrap();
        assert!(
            !a.notes.iter().any(|n| n.contains("人声过弱")),
            "vocal_space must not be skipped: {:?}",
            a.notes
        );
        let b = run_restore_inner(&mk(false, &dir.join("vs_off.wav")), |_, _| {}, &no_critic).unwrap();
        let da = decode_audio_file(&a.output_path).unwrap();
        let db = decode_audio_file(&b.output_path).unwrap();
        let (al, _) = da.to_stereo_planar();
        let (bl, _) = db.to_stereo_planar();
        let m = al.len().min(bl.len());
        let diff: Vec<f32> = (0..m).map(|i| al[i] - bl[i]).collect();
        let e: f64 = diff.iter().map(|v| (*v as f64).powi(2)).sum();
        assert!(e > 1e-4, "vocal_space delta must be non-zero (e={e:e})");
        let ratio = band_energy_ratio(&diff, 48000.0, 1000.0, 5000.0);
        assert!(
            ratio > 0.6,
            "duck energy must concentrate in 1-5 kHz (ratio {ratio:.2})"
        );
    }

    #[test]
    fn n_stem_roles_restore_zero_lag() {
        // Suno-style 6-stem set with explicit roles (incl. backing vocal,
        // percussion and two `other` stems): output stays sample-aligned.
        let dir = std::env::temp_dir().join("stemscribe_restore_6stem");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("n6_src.wav");
        let out = dir.join("n6_out.wav");
        let sr = 48000u32;
        let n = sr as usize * 3;
        let tau = std::f64::consts::TAU;
        let mut seed = 0x1357BDFu64;
        let mut rng = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as f64 / u32::MAX as f64) * 2.0 - 1.0
        };
        let l: Vec<f32> = (0..n).map(|_| (rng() * 0.1) as f32).collect();
        let r: Vec<f32> = (0..n).map(|_| (rng() * 0.1) as f32).collect();
        write_stereo_wav_f32(&src, &l, &r, sr).unwrap();
        let mk_stem = |name: &str, f: f64, amp: f64| -> String {
            let p = dir.join(name);
            let sl: Vec<f32> = (0..n)
                .map(|i| (amp * (tau * f * i as f64 / 44100.0).sin()) as f32)
                .collect();
            write_stereo_wav_f32(&p, &sl, &sl, 44100).unwrap();
            p.to_string_lossy().to_string()
        };
        let stems: Vec<StemIn> = [
            ("lead", "vox.wav", 2000.0, 0.20),
            ("backing", "bgv.wav", 2500.0, 0.05),
            ("drums", "dr.wav", 150.0, 0.08),
            ("perc", "perc.wav", 4000.0, 0.03),
            ("bass", "bass.wav", 80.0, 0.08),
            ("other", "gtr.wav", 900.0, 0.06),
            ("other", "pad.wav", 600.0, 0.06),
        ]
        .iter()
        .map(|(role, file, f, amp)| StemIn {
            name: role.to_string(),
            file_path: mk_stem(file, *f, *amp),
            role: role.to_string(),
        })
        .collect();
        let mut settings = RestoreSettings::default();
        settings.target_lufs = -20.0;
        let req = RestoreRequest {
            source_path: src.to_string_lossy().to_string(),
            stems,
            settings,
            output_path: Some(out.to_string_lossy().to_string()),
        };
        let res = run_restore_inner(&req, |_, _| {}, &no_critic).unwrap();
        assert!(res.objective.is_some(), "objective score must be set");
        let d = decode_audio_file(&res.output_path).unwrap();
        let (ol, or_) = d.to_stereo_planar();
        assert_eq!(ol.len(), n);
        let c = n / 2 - 24000;
        assert_eq!(xcorr_lag(&l, &ol, c, 24000), 0, "restore lag L (6 stems)");
        assert_eq!(xcorr_lag(&r, &or_, c, 24000), 0, "restore lag R (6 stems)");
    }

    #[test]
    fn sum_stems_as_mix_all_off_is_bypass() {
        // Σstems-as-mix with every module off: output must equal the
        // summed stems within <= -120 dB error.
        let dir = std::env::temp_dir().join("stemscribe_restore_bypass");
        std::fs::create_dir_all(&dir).unwrap();
        let sr = 48000u32;
        let n = sr as usize * 2;
        let tau = std::f64::consts::TAU;
        let mut sum = vec![0.0f32; n];
        let mut stems: Vec<StemIn> = Vec::new();
        for (i, (role, f, amp)) in [
            ("lead", 1500.0f64, 0.05f64),
            ("backing", 2100.0, 0.02),
            ("drums", 200.0, 0.06),
            ("perc", 5500.0, 0.015),
            ("bass", 90.0, 0.07),
            ("other", 800.0, 0.04),
            ("other", 1300.0, 0.03),
        ]
        .iter()
        .enumerate()
        {
            let p = dir.join(format!("stem{i}.wav"));
            let sl: Vec<f32> = (0..n)
                .map(|j| (amp * (tau * f * j as f64 / sr as f64).sin()) as f32)
                .collect();
            for j in 0..n {
                sum[j] += sl[j];
            }
            write_stereo_wav_f32(&p, &sl, &sl, sr).unwrap();
            stems.push(StemIn {
                name: role.to_string(),
                file_path: p.to_string_lossy().to_string(),
                role: role.to_string(),
            });
        }
        let mix = dir.join("mix.wav");
        write_stereo_wav_f32(&mix, &sum, &sum, sr).unwrap();
        let out = dir.join("bypass_out.wav");
        let mut settings = RestoreSettings::default();
        settings.modules = RestoreModules {
            vocal_cleanup: 0.0,
            drum_punch: 0.0,
            low_end: 0.0,
            shimmer: 0.0,
            width: 0.0,
            vocal_space: 0.0,
            hf_restore: 0.0,
            glue: 0.0,
            loudness: false,
            drum_replace: false,
            reference_match: false,
        };
        let req = RestoreRequest {
            source_path: mix.to_string_lossy().to_string(),
            stems,
            settings,
            output_path: Some(out.to_string_lossy().to_string()),
        };
        let res = run_restore_inner(&req, |_, _| {}, &no_critic).unwrap();
        let d = decode_audio_file(&res.output_path).unwrap();
        let (ol, _or_) = d.to_stereo_planar();
        assert_eq!(ol.len(), n);
        let mut num = 0.0f64;
        let mut den = 0.0f64;
        for j in 0..n {
            num += ((ol[j] - sum[j]) as f64).powi(2);
            den += (sum[j] as f64).powi(2);
        }
        let err_db = 10.0 * (num / den.max(1e-30)).log10();
        assert!(err_db <= -120.0, "bypass error {err_db:.1} dB must be <= -120 dB");
    }

    fn sine_gain_db(input: &[f32], output: &[f32]) -> f64 {
        // RMS ratio over the steady-state second half (skips filter onset).
        let n0 = input.len() / 2;
        let rms = |v: &[f32]| -> f64 {
            (v[n0..].iter().map(|x| (*x as f64).powi(2)).sum::<f64>()
                / (v.len() - n0) as f64)
                .sqrt()
        };
        20.0 * (rms(output) / rms(input).max(1e-30)).log10()
    }

    fn bare_diag() -> QualityReport {
        QualityReport {
            sample_rate: 44100,
            channels: 2,
            bit_depth: Some(32),
            duration_sec: 1.0,
            integrated_lufs: -20.0,
            lra_lu: 5.0,
            true_peak_dbtp: -3.0,
            sample_peak_dbfs: -3.0,
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
            issues: vec![],
        }
    }

    fn all_off_settings() -> RestoreSettings {
        let mut s = RestoreSettings::default();
        s.modules = RestoreModules {
            vocal_cleanup: 0.0,
            shimmer: 0.0,
            drum_punch: 0.0,
            low_end: 0.0,
            width: 0.0,
            vocal_space: 0.0,
            hf_restore: 0.0,
            glue: 0.0,
            loudness: false,
            drum_replace: false,
            reference_match: false,
        };
        s
    }

    #[test]
    fn modules_deserialize_legacy_booleans() {
        // Saved projects from before v0.14 stored module switches as bools.
        let s: RestoreSettings = serde_json::from_str(
            r#"{"modules":{"vocal_cleanup":true,"shimmer":false,"glue":true,"loudness":true}}"#,
        )
        .unwrap();
        assert_eq!(s.modules.vocal_cleanup, 1.0);
        assert_eq!(s.modules.shimmer, 0.0);
        assert_eq!(s.modules.glue, 1.0);
        assert!(s.modules.loudness);
        // Missing fields fall back to defaults.
        assert_eq!(s.modules.low_end, 1.0);
        // Numeric amounts still work.
        let s: RestoreSettings =
            serde_json::from_str(r#"{"modules":{"vocal_cleanup":0.7}}"#).unwrap();
        assert!((s.modules.vocal_cleanup - 0.7).abs() < 1e-6);
    }

    #[test]
    fn zero_module_amount_is_exact_bypass() {
        let n = 44100;
        let l: Vec<f32> = (0..n).map(|i| (i as f32 * 0.001).sin() * 0.3).collect();
        let r: Vec<f32> = (0..n).map(|i| (i as f32 * 0.0013).cos() * 0.3).collect();
        // vocal_cleanup = 0 -> chain_vocals is a sample-exact bypass.
        let m = RestoreModules {
            vocal_cleanup: 0.0,
            ..Default::default()
        };
        let (pl, pr) = chain_vocals(&l, &r, 1.5, &m, 1.0, true);
        assert_eq!(pl, l);
        assert_eq!(pr, r);
        // Everything 0 -> master_bus early-bypasses.
        let rs = all_off_settings();
        let (ml, mr) = master_bus(&l, &r, 44100.0, 1.5, &rs, &bare_diag(), true, 1.0, None, 0.0);
        assert_eq!(ml, l);
        assert_eq!(mr, r);
    }

    #[test]
    fn vocal_presence_db_boosts_3k5() {
        let n = 44100;
        let w = 2.0 * std::f32::consts::PI * 3500.0 / 44100.0;
        let in_l: Vec<f32> = (0..n).map(|i| (i as f32 * w).sin() * 0.3).collect();
        let mut l = in_l.clone();
        let mut r = in_l.clone();
        let mut s = RestoreSettings::default();
        s.vocal_presence_db = 3.0;
        apply_vocal_tone(&mut l, &mut r, &s);
        let g = sine_gain_db(&in_l, &l);
        assert!((g - 3.0).abs() <= 0.3, "presence gain {g:.2} dB");
    }

    #[test]
    fn master_high_shelf_boosts_15k() {
        // Stage-level check before the limiter: +2 dB high shelf at 10 kHz
        // measured on a 15 kHz sine through master_bus.
        let n = 44100;
        let w = 2.0 * std::f32::consts::PI * 15000.0 / 44100.0;
        let l: Vec<f32> = (0..n).map(|i| (i as f32 * w).sin() * 0.3).collect();
        let r = l.clone();
        let mut rs = all_off_settings();
        rs.high_shelf_db = 2.0;
        let (ol, _or_) = master_bus(&l, &r, 44100.0, 1.0, &rs, &bare_diag(), true, 1.0, None, 0.0);
        let g = sine_gain_db(&l, &ol);
        assert!((g - 2.0).abs() <= 0.2, "high shelf gain {g:.2} dB");
    }

    #[test]
    fn mix_only_ignores_vocal_tone_params() {
        let dir = std::env::temp_dir().join(format!("stemscribe_tmix_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("mix_src.wav");
        let out = dir.join("mix_out.wav");
        write_test_wav(&src, 2.0, 44100);
        let mut settings = all_off_settings();
        settings.vocal_level_db = 3.0;
        settings.vocal_presence_db = 3.0;
        settings.vocal_air_db = 3.0;
        let req = RestoreRequest {
            source_path: src.to_string_lossy().to_string(),
            stems: vec![],
            settings,
            output_path: Some(out.to_string_lossy().to_string()),
        };
        let res = run_restore_inner(&req, |_, _| {}, &no_critic).unwrap();
        assert!(
            res.notes.iter().any(|n| n.contains("纯母带模式")),
            "mix-only note missing: {:?}",
            res.notes
        );
        // Vocal params ignored -> still a null render.
        let d = decode_audio_file(&res.output_path).unwrap();
        let (ol, or_) = d.to_stereo_planar();
        let d0 = decode_audio_file(&src.to_string_lossy().to_string()).unwrap();
        let (xl, xr) = d0.to_stereo_planar();
        let n = ol.len().min(xl.len());
        let mut e = 0.0f64;
        let mut x_e = 0.0f64;
        for i in 0..n {
            e += ((ol[i] - xl[i]) as f64).powi(2) + ((or_[i] - xr[i]) as f64).powi(2);
            x_e += (xl[i] as f64).powi(2) + (xr[i] as f64).powi(2);
        }
        let err_db = 10.0 * (e / x_e.max(1e-30)).log10();
        assert!(err_db <= -120.0, "null error {err_db:.1} dB");
    }
}


