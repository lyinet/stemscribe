//! AI-song restoration render. Architecture: delta remix — process each stem
//! through its chain, sum the deltas, add to the pristine full-rate source,
//! then a master bus + true-peak limiter + loudness matching.

use super::dsp::biquad::{butter4_highpass, Biquad};
use super::dsp::dynamics::{Compressor, DynamicEqBand};
use super::dsp::exciter::exciter_band;
use super::dsp::limiter::limit_stereo;
use super::dsp::saturation::Saturator;
use super::dsp::spectral::SpectralSuppressor;
use super::dsp::stereo::{mono_below, widen_band};
use super::dsp::transient::TransientShaper;
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RestoreModules {
    pub vocal_cleanup: bool,
    pub shimmer: bool,
    pub drum_punch: bool,
    pub low_end: bool,
    pub width: bool,
    pub vocal_space: bool,
    pub hf_restore: bool,
    pub glue: bool,
    pub loudness: bool,
}

impl Default for RestoreModules {
    fn default() -> Self {
        Self {
            vocal_cleanup: true,
            shimmer: true,
            drum_punch: true,
            low_end: true,
            width: true,
            vocal_space: true,
            hf_restore: true,
            glue: true,
            loudness: true,
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
}

impl Default for RestoreSettings {
    fn default() -> Self {
        Self {
            strength: 1.0,
            modules: RestoreModules::default(),
            target_lufs: -14.0,
            ceiling_dbtp: -1.0,
            bit_depth: 24,
        }
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

// ---------- per-stem chains (at 44.1 kHz) ----------

const STEM_SR: f64 = 44_100.0;

fn chain_vocals(
    l: &[f32],
    r: &[f32],
    s: f64,
    m: &RestoreModules,
    dyn_scale: f64,
) -> (Vec<f32>, Vec<f32>) {
    if s <= 0.0 || !m.vocal_cleanup {
        return (l.to_vec(), r.to_vec());
    }
    let dyn_s = dyn_scale;
    let mut bl = Biquad::high_pass(STEM_SR, 90.0, std::f64::consts::FRAC_1_SQRT_2);
    let mut br = Biquad::high_pass(STEM_SR, 90.0, std::f64::consts::FRAC_1_SQRT_2);
    let mut l = bl.process(l);
    let mut r = br.process(r);
    // Spectral cleanup 2.5-9 kHz
    {
        let mut sup_l = SpectralSuppressor::new(STEM_SR, 2500.0, 9000.0, 4.0, 0.6 * s, 6.0 * s, 5.0, 60.0);
        let mut sup_r = SpectralSuppressor::new(STEM_SR, 2500.0, 9000.0, 4.0, 0.6 * s, 6.0 * s, 5.0, 60.0);
        l = sup_l.process(&l);
        r = sup_r.process(&r);
    }
    // De-esser (linked, detector = own 5-11 kHz band)
    {
        let thr = detector_percentile(&l, &r, STEM_SR, (5000.0, 11000.0), 60.0, 0.85);
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
        let g = 10f64.powf((st.gr_median_db + 1.0 * s) / 20.0) as f32;
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
    if m.drum_punch {
        let mut t = TransientShaper::new(STEM_SR, 0.35 * s);
        let (a, b) = t.process(&l, &r);
        l = a;
        r = b;
    }
    if m.shimmer {
        let mut a = SpectralSuppressor::new(STEM_SR, 7000.0, 16000.0, 3.0, 0.5 * s, 5.0 * s, 3.0, 40.0);
        let mut b = SpectralSuppressor::new(STEM_SR, 7000.0, 16000.0, 3.0, 0.5 * s, 5.0 * s, 3.0, 40.0);
        l = a.process(&l);
        r = b.process(&r);
    }
    if m.low_end && diag.low_mid_excess_db >= 2.0 && diag.low_mid_center_hz > 0.0 {
        let cut = -0.5 * (diag.low_mid_excess_db.min(3.0) as f64) * s;
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
    if s <= 0.0 || !m.low_end {
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
    if m.low_end && diag.low_mid_excess_db >= 2.0 && diag.low_mid_center_hz > 0.0 {
        let cut = -(diag.low_mid_excess_db.min(4.0) as f64) * s;
        let (a, b) = peaking_stereo(&l, &r, STEM_SR, diag.low_mid_center_hz as f64, 0.9, cut);
        l = a;
        r = b;
    }
    if m.vocal_cleanup {
        let mut a = SpectralSuppressor::new(STEM_SR, 2500.0, 9000.0, 4.0, 0.5 * s, 5.0 * s, 5.0, 60.0);
        let mut b = SpectralSuppressor::new(STEM_SR, 2500.0, 9000.0, 4.0, 0.5 * s, 5.0 * s, 5.0, 60.0);
        l = a.process(&l);
        r = b.process(&r);
    }
    if m.shimmer {
        let mut a = SpectralSuppressor::new(STEM_SR, 9000.0, 16000.0, 3.0, 0.4 * s, 4.0 * s, 3.0, 40.0);
        let mut b = SpectralSuppressor::new(STEM_SR, 9000.0, 16000.0, 3.0, 0.4 * s, 4.0 * s, 3.0, 40.0);
        l = a.process(&l);
        r = b.process(&r);
    }
    if m.width {
        let mut w = 1.0 + 0.15 * s;
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
    if m.vocal_space {
        if vocals_weak || vocals.is_none() {
            if m.vocal_space {
                notes.push("人声过弱或缺失，已跳过人声空间避让".to_string());
            }
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
            let mut de = DynamicEqBand::new(STEM_SR, 2500.0, 0.5, (1000.0, 5000.0), thr, 2.0, 2.0 * s, 10.0, 150.0);
            let (ol, or_) = de.process(&l, &r, Some(&sc));
            l = ol;
            r = or_;
        }
    }
    (l, r)
}

// ---------- master bus ----------

#[allow(clippy::too_many_arguments)]
fn master_bus(
    y_l: &[f32],
    y_r: &[f32],
    work_sr: f64,
    s: f64,
    m: &RestoreModules,
    diag: &QualityReport,
    stem_mode: bool,
    dyn_scale: f64,
) -> (Vec<f32>, Vec<f32>) {
    let mut l = y_l.to_vec();
    let mut r = y_r.to_vec();
    if s <= 0.0 {
        return (l, r);
    }
    let any_master = m.low_end || m.glue || m.hf_restore || m.loudness || m.vocal_cleanup;
    if !any_master {
        return (l, r);
    }
    // HPF 28 Hz, 4th-order Butterworth (fixed cleanup)
    {
        let mut hl = butter4_highpass(work_sr, 28.0);
        let mut hr = butter4_highpass(work_sr, 28.0);
        l = hl.iter_mut().fold(l, |x, b| b.process(&x));
        r = hr.iter_mut().fold(r, |x, b| b.process(&x));
    }
    if m.low_end && diag.low_mid_excess_db >= 2.0 && diag.low_mid_center_hz > 0.0 {
        let k = if stem_mode { 0.5 } else { 1.0 };
        let cut = -k * (diag.low_mid_excess_db.min(3.0) as f64) * s;
        let (a, b) = peaking_stereo(&l, &r, work_sr, diag.low_mid_center_hz as f64, 0.9, cut);
        l = a;
        r = b;
    }
    // Master-bus dynamic EQ per diagnosed harsh peak (<= 4).
    if m.vocal_cleanup {
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
                (pk.excess_db as f64).min(4.0) * s,
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
        if m.low_end {
            for (hz, resid) in super::quality::diagnose::low_mid_residuals(&ltas) {
                if resid >= 1.5 {
                    let cut = -0.7 * (resid.min(3.0) as f64) * s;
                    let (a, b) = peaking_stereo(&l, &r, work_sr, hz as f64, 0.9, cut);
                    l = a;
                    r = b;
                    applied = true;
                }
            }
        }
        if m.vocal_cleanup {
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
                        -0.7 * pk.excess_db as f64 * s,
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
    if m.glue {
        // Glue compressor: level-relative threshold = 3 s slow RMS envelope
        // + 2 dB — shapes micro-dynamics without flattening sections.
        let (mut comp, mut env) =
            Compressor::new_tracking(work_sr, 2.0, 1.5, 6.0, 20.0, 150.0, 2.0 * s * dyn_scale);
        let (ol, or_, _st) = comp.process(&mut env, &l, &r, None);
        l = ol;
        r = or_;
        let mut sat = Saturator::new(1.5, (0.15 * s * dyn_scale).min(1.0));
        let (a, b) = sat.process_stereo(&l, &r);
        l = a;
        r = b;
    }
    if m.low_end {
        let (a, b) = mono_below(&l, &r, work_sr, 120.0);
        l = a;
        r = b;
    }
    if m.hf_restore {
        if let Some(cut) = diag.cutoff_hz {
            if cut < 19000.0 {
                let fc = cut as f64;
                let rel = if s <= 1.0 { -10.0 + 8.0 * (s - 0.5) } else { -6.0 + 6.0 * (s - 1.0) };
                let n = l.len();
                let add_l = exciter_band(&l, work_sr as u32, fc, rel);
                let add_r = exciter_band(&r, work_sr as u32, fc, rel);
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
pub fn run_restore(
    req: &RestoreRequest,
    mut emit: impl FnMut(&str, f32),
) -> Result<RestoreResult> {
    let t0 = Instant::now();
    let s = req.settings.strength as f64;
    let m = &req.settings.modules;
    let mut notes: Vec<String> = Vec::new();

    emit("analyze", 0.0);
    let before = analyze_quality(&req.source_path)?;

    // Decode source at full quality -> stereo at work rate.
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
    emit("stems", 5.0);

    // Stem RMS pass (weak-vocal detection) — decode once, keep only scalars
    // so stems never sit in memory together.
    let mut loudest = 0.0f64;
    let mut vocals_rms = 0.0f64;
    if stem_mode {
        for st in &req.stems {
            let d = decode_audio_file(&st.file_path)
                .map_err(|e| anyhow!("读取分轨 {} 失败: {e}", st.file_path))?;
            let (sl, sr_) = d.to_stereo_planar();
            let (sl44, sr44) = resample_hq_stereo(&sl, &sr_, d.sample_rate, 44_100);
            let lv = rms_lin(&sl44, &sr44);
            loudest = loudest.max(lv);
            if st.name.contains("vocal") || st.name.contains("人声") {
                vocals_rms = lv;
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

    // One full render (stems -> delta remix -> master -> loudness/limiter).
    // Returns (out_l, out_r, limiter_avg_gr, render notes). The LRA guard
    // below may retry with dynamics scaled down.
    let render = |dyn_scale: f64,
                      emit: &mut dyn FnMut(&str, f32)|
     -> Result<(Vec<f32>, Vec<f32>, f64, Vec<String>)> {
        let mut rnotes: Vec<String> = Vec::new();
        emit("stems", 5.0);
        // --- Stem chains at 44.1k -> delta; sequential so peak memory stays
        // bounded (each stem decoded, processed, dropped in turn).
        let mut d44_l: Vec<f32> = Vec::new();
        let mut d44_r: Vec<f32> = Vec::new();
        if stem_mode {
            // Vocal stems first: `other` ducking needs the raw vocal stem
            // as its sidechain reference no matter the input order.
            let mut order: Vec<usize> = (0..req.stems.len()).collect();
            order.sort_by_key(|&i| {
                let n = &req.stems[i].name;
                usize::from(!(n.contains("vocal") || n.contains("人声")))
            });
            let mut vocals_pair: Option<(Vec<f32>, Vec<f32>)> = None;
            for (seq, &idx) in order.iter().enumerate() {
                let st = &req.stems[idx];
                let d = decode_audio_file(&st.file_path)
                    .map_err(|e| anyhow!("读取分轨 {} 失败: {e}", st.file_path))?;
                let (sl, sr_) = d.to_stereo_planar();
                let (sl44, sr44) = resample_hq_stereo(&sl, &sr_, d.sample_rate, 44_100);
                drop(d);
                let is_vocal = st.name.contains("vocal") || st.name.contains("人声");
                let is_drum = st.name.contains("drum") || st.name.contains("鼓");
                let is_bass = st.name.contains("bass") || st.name.contains("贝斯");
                if is_vocal {
                    // Sidechain = unprocessed stem (true vocal energy).
                    vocals_pair = Some((sl44.clone(), sr44.clone()));
                }
                let vref = vocals_pair.as_ref().map(|(a, b)| (a.as_slice(), b.as_slice()));
                let (pl, pr) = if is_vocal {
                    chain_vocals(&sl44, &sr44, s, m, dyn_scale)
                } else if is_drum {
                    chain_drums(&sl44, &sr44, s, m, &before)
                } else if is_bass {
                    chain_bass(&sl44, &sr44, s, m, dyn_scale)
                } else {
                    chain_other(&sl44, &sr44, s, m, &before, vref, vocals_weak, &mut rnotes)
                };
                let len = sl44.len().min(sr44.len());
                if d44_l.len() < len {
                    d44_l.resize(len, 0.0);
                    d44_r.resize(len, 0.0);
                }
                for i in 0..len {
                    d44_l[i] += pl[i] - sl44[i];
                    d44_r[i] += pr[i] - sr44[i];
                }
                emit(
                    "stems",
                    5.0 + 35.0 * (seq + 1) as f32 / req.stems.len().max(1) as f32,
                );
            }
            drop(vocals_pair);
        }
        emit("stems", 45.0);

        // Resample delta to work rate, y = x + D.
        let (dw_l, dw_r) = if d44_l.is_empty() {
            (Vec::new(), Vec::new())
        } else {
            resample_hq_stereo(&d44_l, &d44_r, 44_100, work_rate)
        };
        drop((d44_l, d44_r));
        let mut y_l = xw_l[..n].to_vec();
        let mut y_r = xw_r[..n].to_vec();
        for i in 0..n.min(dw_l.len().min(dw_r.len())) {
            y_l[i] += dw_l[i];
            y_r[i] += dw_r[i];
        }
        drop((dw_l, dw_r));
        emit("master", 50.0);

        // `yb` = master-bus output, pre-limiter.
        let (yb_l, yb_r) =
            master_bus(&y_l, &y_r, work_rate as f64, s, m, &before, stem_mode, dyn_scale);
        drop((y_l, y_r));

        // --- Loudness matching + limiter ---
        emit("limit", 75.0);
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
        let i_pre = loudness::integrated_lufs(&[yb_l.clone(), yb_r.clone()], work_rate);
        let mut pre_gain_db = if i_pre.is_finite() {
            (req.settings.target_lufs - i_pre).min(12.0)
        } else {
            0.0
        };
        let mut last_gr = 0.0;
        let mut ol = yb_l.clone();
        let mut or_ = yb_r.clone();
        for _iter in 0..3 {
            let (a, b, st) = limit_once(pre_gain_db, &yb_l, &yb_r);
            let i_post = loudness::integrated_lufs(&[a.clone(), b.clone()], work_rate);
            ol = a;
            or_ = b;
            last_gr = st.avg_gr_db;
            if !i_post.is_finite() || (req.settings.target_lufs - i_post).abs() <= 0.2 {
                break;
            }
            pre_gain_db = (pre_gain_db + req.settings.target_lufs - i_post).min(12.0);
        }
        // If reaching target costs > 3 dB average GR, stop at the loudness
        // achievable with ~3 dB and note it. GR is not linear in pre-gain,
        // so iterate the back-off a few times.
        if last_gr > 3.0 {
            // Predict the GR-vs-gain curve on one 4x peak profile (cheap),
            // pick the highest gain at predicted ~2.9 dB, verify for real.
            let profile = super::dsp::limiter::peak_profile_4x(&yb_l, &yb_r);
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
    };

    // LRA guard: if the render flattened macro-dynamics beyond 1 LU,
    // re-render with compressor GR caps and saturation mixes halved
    // (max 2 retries).
    let mut dyn_scale = 1.0f64;
    let mut attempts = 0usize;
    let (y_l, y_r, limiter_avg_gr) = loop {
        let (a, b, gr, rnotes) = render(dyn_scale, &mut emit)?;
        let lra_out = loudness::loudness_range_lu(&[a.clone(), b.clone()], work_rate);
        if attempts < 2
            && before.lra_lu.is_finite()
            && lra_out.is_finite()
            && lra_out < before.lra_lu - 1.0
        {
            dyn_scale *= 0.5;
            attempts += 1;
            notes.extend(rnotes);
            notes.push(format!(
                "检测到响度范围压缩过度（LRA {:.1}→{:.1} LU），已降低压缩/饱和强度重渲染",
                before.lra_lu, lra_out
            ));
            continue;
        }
        notes.extend(rnotes);
        break (a, b, gr);
    };

    // --- Write output ---
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
            let tag = if s <= 0.75 { "light" } else if s >= 1.25 { "strong" } else { "standard" };
            dir.join(format!("{stem_name}_restored_{tag}.wav"))
                .to_string_lossy()
                .to_string()
        }
    };
    let bit_depth = if req.settings.bit_depth == 16 { 16 } else { 24 };
    if bit_depth == 24 {
        write_stereo_wav_i24(Path::new(&out_path), &y_l, &y_r, work_rate)?;
    } else {
        write_stereo_wav_i16_tpdf(Path::new(&out_path), &y_l, &y_r, work_rate)?;
    }
    emit("report", 97.0);
    let after = analyze_quality(&out_path)?;
    let loudness_match = if before.integrated_lufs.is_finite() && after.integrated_lufs.is_finite() {
        before.integrated_lufs - after.integrated_lufs
    } else {
        0.0
    };
    emit("report", 100.0);
    // De-duplicate notes (per-stem chains can emit the same message).
    let mut seen = std::collections::HashSet::new();
    notes.retain(|n| seen.insert(n.clone()));
    Ok(RestoreResult {
        output_path: out_path,
        sample_rate: work_rate,
        bit_depth,
        before,
        after,
        loudness_match_db: loudness_match,
        limiter_avg_gr_db: limiter_avg_gr,
        notes,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

fn renders_dir() -> Result<std::path::PathBuf> {
    let home = std::env::var("HOME").map_err(|_| anyhow!("无法定位 HOME"))?;
    Ok(Path::new(&home)
        .join("Library/Application Support/StemScribe/renders"))
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
            vocal_cleanup: false,
            shimmer: false,
            drum_punch: false,
            low_end: false,
            width: false,
            vocal_space: false,
            hf_restore: false,
            glue: false,
            loudness: false,
        };
        let req = RestoreRequest {
            source_path: src.to_string_lossy().to_string(),
            stems: vec![],
            settings,
            output_path: Some(out.to_string_lossy().to_string()),
        };
        let res = run_restore(&req, |_, _| {}).unwrap();
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
            chain_vocals(&l, &r, 0.0, &m, 1.0),
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
        let res = run_restore(&req, |_, _| {}).unwrap();
        let d = decode_audio_file(&res.output_path).unwrap();
        let (ol, or_) = d.to_stereo_planar();
        assert_eq!(ol.len(), n, "output length must equal source length");
        let c = n / 2 - 48000;
        assert_eq!(xcorr_lag(&l, &ol, c, 48000), 0, "restore lag L");
        assert_eq!(xcorr_lag(&r, &or_, c, 48000), 0, "restore lag R");
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
                    vocal_cleanup: false,
                    shimmer: false,
                    drum_punch: false,
                    low_end: false,
                    width: false,
                    vocal_space,
                    hf_restore: false,
                    glue: false,
                    loudness: false,
                },
                ..RestoreSettings::default()
            },
            output_path: Some(out.to_string_lossy().to_string()),
        };
        let a = run_restore(&mk(true, &dir.join("vs_on.wav")), |_, _| {}).unwrap();
        assert!(
            !a.notes.iter().any(|n| n.contains("人声过弱")),
            "vocal_space must not be skipped: {:?}",
            a.notes
        );
        let b = run_restore(&mk(false, &dir.join("vs_off.wav")), |_, _| {}).unwrap();
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
}


