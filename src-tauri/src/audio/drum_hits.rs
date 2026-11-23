//! Drum reinforcement: sample-accurate hit detection on the drums stem and
//! rendering of a bundled CC0 acoustic kit (Big Rusty Drums, Karoryfer
//! Samples) aligned to each hit.

use super::dsp::crossover::Lr4;
use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrumClass {
    Kick = 0,
    Snare = 1,
    Hihat = 2,
}

#[derive(Debug, Clone)]
pub struct Hit {
    pub class: DrumClass,
    /// Refined sample position in the stem buffer.
    pub pos: usize,
    /// Class-band peak of the hit, dBFS.
    pub peak_db: f64,
    /// Kit velocity layer 1..=5.
    pub layer: usize,
    /// Invert the kit sample when true.
    pub flip: bool,
}

#[derive(Deserialize)]
struct KitManifest {
    #[allow(dead_code)]
    sample_rate: u32,
    samples: Vec<KitEntry>,
}

#[derive(Deserialize)]
struct KitEntry {
    class: String,
    layer: usize,
    rr: usize,
    file: String,
}

/// The bundled kit: waves[class][layer-1][rr-1] mono samples.
pub struct DrumKit {
    pub sr: u32,
    pub waves: [Vec<Vec<Vec<f32>>>; 3],
}

static KIT_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Point the loader at a resolved resource directory (called by the app
/// setup). Tests / CLI fall back to the source tree.
pub fn set_kit_dir(dir: PathBuf) {
    let _ = KIT_DIR.set(dir);
}

pub fn kit_dir() -> PathBuf {
    if let Some(d) = KIT_DIR.get() {
        return d.clone();
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/drums")
}

fn read_mono_wav(path: &Path) -> Result<(u32, Vec<f32>)> {
    let mut r = hound::WavReader::open(path)
        .map_err(|e| anyhow!("读取鼓采样失败 {}: {e}", path.display()))?;
    let spec = r.spec();
    let sr = spec.sample_rate;
    let ch = spec.channels.max(1) as usize;
    let mut acc: Vec<f64> = Vec::new();
    match spec.sample_format {
        hound::SampleFormat::Int => {
            let scale = (1u64 << (spec.bits_per_sample - 1).min(31)) as f64;
            for s in r.samples::<i32>() {
                acc.push(s.map_err(|e| anyhow!("wav 解码: {e}"))? as f64 / scale);
            }
        }
        hound::SampleFormat::Float => {
            for s in r.samples::<f32>() {
                acc.push(s.map_err(|e| anyhow!("wav 解码: {e}"))? as f64);
            }
        }
    }
    let mut mono = Vec::with_capacity(acc.len() / ch);
    for fr in acc.chunks(ch) {
        mono.push((fr.iter().sum::<f64>() / fr.len() as f64) as f32);
    }
    Ok((sr, mono))
}

impl DrumKit {
    /// Load `kit.json` + WAVs from `dir`, resampling everything to `rate`.
    pub fn load(dir: &Path, rate: u32) -> Result<DrumKit> {
        let manifest: KitManifest = serde_json::from_str(
            &std::fs::read_to_string(dir.join("kit.json"))
                .map_err(|e| anyhow!("读取鼓件清单失败: {e}"))?,
        )
        .map_err(|e| anyhow!("解析鼓件清单失败: {e}"))?;
        let mut waves: [Vec<Vec<Vec<f32>>>; 3] =
            [vec![vec![vec![]; 2]; 5], vec![vec![vec![]; 2]; 5], vec![vec![vec![]; 2]; 5]];
        for e in &manifest.samples {
            let cls = match e.class.as_str() {
                "kick" => 0,
                "snare" => 1,
                "hihat" => 2,
                _ => continue,
            };
            if e.layer == 0 || e.layer > 5 || e.rr == 0 || e.rr > 2 {
                continue;
            }
            let (fsr, w) = read_mono_wav(&dir.join(&e.file))?;
            let w = if fsr == rate {
                w
            } else {
                super::resample::resample_hq(&w, fsr, rate)
            };
            waves[cls][e.layer - 1][e.rr - 1] = w;
        }
        // Every slot must be filled.
        for c in 0..3 {
            for l in 0..5 {
                for rr in 0..2 {
                    if waves[c][l][rr].is_empty() {
                        return Err(anyhow!("鼓件不完整: class={c} layer={} rr={rr}", l + 1));
                    }
                }
            }
        }
        Ok(DrumKit { sr: rate, waves })
    }

    /// First sample where |x| crosses 30 % of the sample's peak.
    fn attack_cross(w: &[f32]) -> usize {
        let peak = w.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        let thr = 0.3 * peak;
        w.iter().position(|v| v.abs() >= thr).unwrap_or(0)
    }
}

pub fn lr4_low(x: &[f32], sr: f64, f: f64) -> Vec<f32> {
    let mut xo = Lr4::new(sr, f);
    xo.split(x).0
}

pub fn lr4_high(x: &[f32], sr: f64, f: f64) -> Vec<f32> {
    let mut xo = Lr4::new(sr, f);
    xo.split(x).1
}

pub fn lr4_band(x: &[f32], sr: f64, lo: f64, hi: f64) -> Vec<f32> {
    lr4_low(&lr4_high(x, sr, lo), sr, hi)
}

/// One-pole envelope (|x|, 5 ms) sampled at 1 ms hops.
fn envelope(x: &[f32], sr: f64) -> (Vec<f32>, usize) {
    let tau = 0.005;
    let a = (-1.0 / (tau * sr)).exp();
    let hop = (sr * 0.001).round() as usize;
    let mut e = 0.0f64;
    let mut env = Vec::with_capacity(x.len() / hop + 1);
    for (i, &v) in x.iter().enumerate() {
        e = (v.abs() as f64) + a * (e - v.abs() as f64);
        if i % hop == 0 {
            env.push(e as f32);
        }
    }
    (env, hop)
}

/// Positive difference of the log envelope. The first ~15 hops are
/// zeroed: the one-pole envelope warms up from 0 and produces a huge
/// log-jump at the file start.
fn onset_fn(env: &[f32]) -> Vec<f32> {
    let mut odf = vec![0.0f32; env.len()];
    for i in 1..env.len() {
        let d = (env[i] as f64 + 1e-8).ln() - (env[i - 1] as f64 + 1e-8).ln();
        if d > 0.0 {
            odf[i] = d as f32;
        }
    }
    for v in odf.iter_mut().take(15) {
        *v = 0.0;
    }
    odf
}

/// Pick peaks of `odf` above a 200 ms moving median + `delta`,
/// enforcing `min_gap` hops between picks.
fn pick_onsets(odf: &[f32], median_win: usize, delta: f32, min_gap: usize) -> Vec<usize> {
    let mut sorted: Vec<f32> = Vec::with_capacity(median_win + 1);
    let mut hits = Vec::new();
    let mut last: Option<usize> = None;
    for (i, &v) in odf.iter().enumerate() {
        // Maintain sliding sorted window of the trailing `median_win` samples.
        if i > median_win {
            let old = odf[i - median_win - 1];
            if let Ok(p) = sorted.binary_search_by(|x| x.partial_cmp(&old).unwrap()) {
                sorted.remove(p);
            }
        }
        let pos = sorted.partition_point(|x| *x < v);
        sorted.insert(pos, v);
        let med = if sorted.is_empty() {
            0.0
        } else {
            sorted[sorted.len() / 2]
        };
        if v > med + delta && v > 0.15 {
            match last {
                Some(l) if i - l < min_gap => {
                    // Keep the stronger of two close onsets.
                    if v > odf[l] {
                        if let Some(h) = hits.last_mut() {
                            if *h == l {
                                *h = i;
                                last = Some(i);
                                continue;
                            }
                        }
                        last = Some(i);
                        continue;
                    }
                    continue;
                }
                _ => {}
            }
            hits.push(i);
            last = Some(i);
        }
    }
    hits
}

/// Mean-square of `x` over [a, b) clamped to the buffer.
pub fn window_energy(x: &[f32], a: usize, b: usize) -> f64 {
    let a = a.min(x.len());
    let b = b.min(x.len());
    if b <= a {
        return 0.0;
    }
    x[a..b].iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / (b - a) as f64
}

/// First index in [a, b) where |x| >= 30 % of the local peak.
fn refine_to_attack(band: &[f32], a: usize, b: usize) -> usize {
    let a = a.min(band.len());
    let b = b.min(band.len());
    if b <= a {
        return a;
    }
    let peak = band[a..b].iter().fold(0.0f32, |m, v| m.max(v.abs()));
    let thr = 0.3 * peak;
    band[a..b]
        .iter()
        .position(|v| v.abs() >= thr)
        .map(|i| a + i)
        .unwrap_or(a)
}

/// Peak of `band` in [pos, pos + win) in dBFS.
fn band_peak_db(band: &[f32], pos: usize, win: usize) -> f64 {
    let b = (pos + win).min(band.len());
    let peak = band[pos.min(b)..b]
        .iter()
        .fold(0.0f32, |m, v| m.max(v.abs()));
    20.0 * (peak as f64 + 1e-9).log10()
}

/// Detect kick/snare/hihat hits on a mono-summed drums stem.
/// Returns hits sorted by time.
pub fn detect_hits(l: &[f32], r: &[f32], sr: f64) -> Vec<Hit> {
    let n = l.len().min(r.len());
    let mono: Vec<f32> = (0..n).map(|i| (l[i] + r[i]) * 0.5).collect();
    let low = lr4_low(&mono, sr, 120.0);
    let mid = lr4_band(&mono, sr, 180.0, 2500.0);
    let high = lr4_high(&mono, sr, 7000.0);
    let noise = lr4_band(&mono, sr, 3000.0, 6000.0);

    let (env_l, hop) = envelope(&low, sr);
    let (env_m, _) = envelope(&mid, sr);
    let (env_h, _) = envelope(&high, sr);
    let odf_l = onset_fn(&env_l);
    let odf_m = onset_fn(&env_m);
    let odf_h = onset_fn(&env_h);
    let med = (0.2 * sr / hop as f64) as usize;
    let min_onset_slow = (0.060 * sr / hop as f64) as usize;
    let min_onset_hat = (0.040 * sr / hop as f64) as usize;

    let kicks = pick_onsets(&odf_l, med, 0.45, min_onset_slow);
    let mid_onsets = pick_onsets(&odf_m, med, 0.35, min_onset_slow);
    let hats = pick_onsets(&odf_h, med, 0.35, min_onset_hat);

    let half_win = (0.012 * sr) as usize;
    let band_stats = |t: usize| -> (f64, f64, f64, f64) {
        let a = t.saturating_sub(half_win);
        let b = t + half_win;
        let e_mid = window_energy(&mid, a, b);
        let e_low = window_energy(&low, a, b);
        let e_noise = window_energy(&noise, a, b);
        let e_high = window_energy(&high, a, b);
        (
            10.0 * (e_mid / e_low.max(1e-20)).log10(), // mid/low dB
            10.0 * (e_mid / e_high.max(1e-20)).log10(), // mid/high dB
            e_noise / e_mid.max(1e-20),               // 3-6k noise ratio
            e_mid,
        )
    };
    let mut hits: Vec<Hit> = Vec::new();
    let mk = |class, pos| Hit {
        class,
        pos,
        peak_db: 0.0,
        layer: 3,
        flip: false,
    };
    // Snare: mid-band onset with mid-dominant spectrum — ml > -6 dB (kick
    // bleed is low-dominant), mh > 6 dB (hats are high-dominant), and a
    // 3-6 kHz noise component (snare wires).
    let mut snare_windows: Vec<(usize, f64, f64)> = Vec::new(); // (pos, ml, mh)
    for j in &mid_onsets {
        let t = j * hop;
        let (ml, mh, nm, _e) = band_stats(t);
        if ml > -6.0 && mh > 6.0 && nm > 0.0005 {
            hits.push(mk(DrumClass::Snare, t));
        }
        snare_windows.push((t, ml, mh));
    }
    // Kick: low-band onset. A coincident (±5 ms) mid-band onset keeps the
    // kick only when the low band actually dominates there — a snare's own
    // LF thump has ml > -6 dB and is dropped as bleed.
    let five_ms = (0.005 * sr) as usize;
    for j in &kicks {
        let t = j * hop;
        let (ml, mh, _, _) = band_stats(t);
        let snare_near = hits
            .iter()
            .any(|h| h.class == DrumClass::Snare && h.pos.abs_diff(t) <= five_ms);
        if snare_near && ml >= -6.0 {
            continue; // snare bleed into the low band
        }
        hits.push(mk(DrumClass::Kick, t));
        // Coincident snare hidden inside the kick's mid-band onset: a very
        // mid-dominant window (mh ≈ a real snare) at a low-band onset means
        // a snare fired together with the kick.
        if mh > 18.0 {
            let already = hits
                .iter()
                .any(|h| h.class == DrumClass::Snare && h.pos.abs_diff(t) <= (0.012 * sr) as usize);
            if !already {
                hits.push(mk(DrumClass::Snare, t + hop * 4));
            }
        }
    }
    for j in &hats {
        hits.push(mk(DrumClass::Hihat, j * hop));
    }
    hits.sort_by_key(|h| h.pos);

    // Suppress hat onsets within ±5 ms of a snare hit (a snare has real
    // >7 kHz energy — it would otherwise double-count), and kick onsets
    // within ±5 ms of a snare hit when the low-band onset is weak relative
    // to the mid-band (the snare's own thump is not a kick).
    let five_ms = (0.005 * sr) as usize;
    let snare_positions: Vec<usize> = hits
        .iter()
        .filter(|h| h.class == DrumClass::Snare)
        .map(|h| h.pos)
        .collect();
    hits.retain(|h| {
        h.class != DrumClass::Hihat
            || !snare_positions
                .iter()
                .any(|&sp| sp.abs_diff(h.pos) <= five_ms && sp != h.pos)
    });

    // Refine positions to the sample (±10 ms window on the class band).
    let refine = (0.010 * sr) as usize;
    let peak_win = (0.015 * sr) as usize;
    for h in &mut hits {
        let band = match h.class {
            DrumClass::Kick => &low,
            DrumClass::Snare => &mid,
            DrumClass::Hihat => &high,
        };
        let a = h.pos.saturating_sub(refine);
        let b = h.pos + refine;
        h.pos = refine_to_attack(band, a, b);
        h.peak_db = band_peak_db(band, h.pos, peak_win);
    }

    // Velocity layer: peak dB relative to the class's 95th-percentile hit.
    for cls in [DrumClass::Kick, DrumClass::Snare, DrumClass::Hihat] {
        let mut peaks: Vec<f64> = hits
            .iter()
            .filter(|h| h.class == cls)
            .map(|h| h.peak_db)
            .collect();
        if peaks.is_empty() {
            continue;
        }
        peaks.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p95 = peaks[((peaks.len() * 95) / 100).min(peaks.len() - 1)];
        for h in hits.iter_mut().filter(|h| h.class == cls) {
            let rel = (h.peak_db - p95).clamp(-24.0, 0.0);
            h.layer = (1.0 + 4.0 * (1.0 + rel / 24.0)).round().clamp(1.0, 5.0) as usize;
        }
    }
    hits
}

/// Offset (ms) of a grid with spacing `s_ms` that maximizes the number
/// of onsets within ±30 ms — plateau-centre rule for ties — returned
/// with that count. Onset times in seconds.
fn grid_phase(times: &[f64], s_ms: f64) -> (f64, usize) {
    if times.is_empty() {
        return (0.0, 0);
    }
    let nb = s_ms.round().max(1.0) as usize;
    let mut circ = vec![0u32; nb];
    for &t in times {
        let base = (t * 1000.0).rem_euclid(s_ms).round() as i64;
        for k in -30i64..=30 {
            circ[(base + k).rem_euclid(nb as i64) as usize] += 1;
        }
    }
    let mv = *circ.iter().max().unwrap_or(&0);
    let plateau: Vec<usize> = (0..nb).filter(|&i| circ[i] == mv).collect();
    let phase = plateau[plateau.len() / 2] as f64;
    let on = times
        .iter()
        .filter(|&&t| {
            let q = (t * 1000.0 - phase).rem_euclid(s_ms);
            q.min(s_ms - q) <= 30.0
        })
        .count();
    (phase, on)
}

/// Outcome of the post-detection gates applied before layering.
pub struct GateResult {
    /// Surviving hits (empty when `disabled`).
    pub hits: Vec<Hit>,
    /// Autocorrelated beat period in seconds (0 when undetermined).
    pub beat_sec: f64,
    /// Gate-1 hits within ±30 ms of the 8th-note grid.
    pub on_grid: usize,
    /// Hits surviving the strength gate (grid-gate denominator).
    pub gate1: usize,
    /// Layering disabled (no strong hits or < 60 % on grid).
    pub disabled: bool,
    /// Raw detections per class [kick, snare, hihat] before gating.
    pub raw: [usize; 3],
}

/// Post-detection gates for the experimental reinforcement: hats are not
/// layered, same-class double-triggers are merged, weak hits are dropped,
/// hits must sit on a locally-refined 8th-note grid of the autocorrelated
/// beat, snares are de-duplicated, and kicks must show
/// bandwidth-normalized low-band dominance.
pub fn gate_hits(raw_hits: &[Hit], l: &[f32], r: &[f32], sr: f64) -> GateResult {
    let mut raw = [0usize; 3];
    for h in raw_hits {
        raw[h.class as usize] += 1;
    }
    // Pre-gate de-dup: same-class hits within 20 ms keep only the
    // strongest — removes the ~1 ms double-triggers a kick's click can
    // produce on the mid band. raw_hits arrive sorted by position.
    let mut deduped: Vec<Hit> = Vec::with_capacity(raw_hits.len());
    for h in raw_hits {
        match deduped.last_mut() {
            Some(p)
                if p.class == h.class && h.pos.abs_diff(p.pos) as f64 / sr <= 0.020 =>
            {
                if h.peak_db > p.peak_db {
                    *p = h.clone();
                }
            }
            _ => deduped.push(h.clone()),
        }
    }
    // Kick + snare only — hats are not layered.
    let mut hits: Vec<Hit> = deduped
        .into_iter()
        .filter(|h| h.class != DrumClass::Hihat)
        .collect();
    // Gate 1 — strength: keep peaks within 9 dB of the class p95.
    for cls in [DrumClass::Kick, DrumClass::Snare] {
        let mut p: Vec<f64> = hits
            .iter()
            .filter(|h| h.class == cls)
            .map(|h| h.peak_db)
            .collect();
        if p.is_empty() {
            continue;
        }
        p.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p95 = p[(p.len() * 95 / 100).min(p.len() - 1)];
        hits.retain(|h| h.class != cls || h.peak_db >= p95 - 9.0);
    }
    let mut res = GateResult {
        hits,
        beat_sec: 0.0,
        on_grid: 0,
        gate1: 0,
        disabled: false,
        raw,
    };
    res.gate1 = res.hits.len();
    if res.gate1 == 0 {
        res.disabled = true;
        return res;
    }
    // Gate 2 — beat grid: onset pair-difference histogram over 0.3–1.0 s.
    let mut times: Vec<f64> = res.hits.iter().map(|h| h.pos as f64 / sr).collect();
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut hist = vec![0u32; 1001];
    for i in 0..times.len() {
        for j in i + 1..times.len() {
            let d = times[j] - times[i];
            if d > 1.0 {
                break;
            }
            if d >= 0.3 {
                hist[(d * 1000.0).round() as usize] += 1;
            }
        }
    }
    let best = *hist.iter().max().unwrap_or(&0) as f64;
    if best <= 0.0 {
        res.disabled = true;
        res.hits.clear();
        return res;
    }
    // Prefer the shortest lag that still captures most of the mass — the
    // full-beat lag rather than two/three-beat multiples.
    let mut lag_ms = 300usize;
    for t in 300..=1000 {
        if hist[t] as f64 >= 0.85 * best {
            lag_ms = t;
            break;
        }
    }
    res.beat_sec = lag_ms as f64 / 1000.0;
    // Gate 2 (local): AI stems are grid-locked only locally — a small
    // period error accumulates tens of ms of drift over a song, so one
    // global grid cannot fit. Windows are 8 s long at 4 s hop; per
    // window the period is refined within ±1 % of the global estimate
    // (41 steps) and the 8th-note phase maximizes gate-1 hits within
    // ±30 ms. Each hit is judged in the window whose centre is nearest
    // to it; windows fit on the hits inside their own ±4 s span.
    let t_max = times.last().copied().unwrap_or(0.0);
    let n_c = (t_max / 4.0).ceil() as usize + 1;
    let mut grid: Vec<Option<(f64, f64)>> = vec![None; n_c]; // (period, phase)
    for (k, cell) in grid.iter_mut().enumerate() {
        let c = k as f64 * 4.0;
        let fit: Vec<f64> = times
            .iter()
            .copied()
            .filter(|&t| (t - c).abs() <= 4.0)
            .collect();
        if fit.is_empty() {
            continue;
        }
        let mut best = (0.0f64, 0.0f64, 0usize);
        for j in 0..=40 {
            let p = res.beat_sec * (0.99 + 0.0005 * j as f64);
            let (ph, sc) = grid_phase(&fit, p * 500.0);
            if sc > best.2 {
                best = (p, ph, sc);
            }
        }
        *cell = Some((best.0, best.1));
    }
    let grid_dist = |t: f64| -> f64 {
        let k = (t / 4.0).round().min((n_c - 1) as f64) as usize;
        match grid[k] {
            Some((p, ph)) => {
                let s = p * 500.0;
                let q = (t * 1000.0 - ph).rem_euclid(s);
                q.min(s - q)
            }
            None => f64::MAX,
        }
    };
    res.on_grid = times.iter().filter(|&&t| grid_dist(t) <= 30.0).count();
    if (res.on_grid as f64) < 0.6 * res.gate1 as f64 {
        res.disabled = true;
        res.hits.clear();
        return res;
    }
    res.hits
        .retain(|h| grid_dist(h.pos as f64 / sr) <= 30.0);
    // Gate 3 — snare de-dup: within 150 ms keep only the strongest.
    let mut snares: Vec<Hit> = Vec::new();
    for h in res.hits.iter().filter(|h| h.class == DrumClass::Snare) {
        match snares.last_mut() {
            Some(p) if h.pos.abs_diff(p.pos) as f64 / sr <= 0.150 => {
                if h.peak_db > p.peak_db {
                    *p = h.clone();
                }
            }
            _ => snares.push(h.clone()),
        }
    }
    res.hits.retain(|h| h.class != DrumClass::Snare);
    res.hits.extend(snares);
    res.hits.sort_by_key(|h| h.pos);
    // Gate 4 — kick plausibility: bandwidth-normalized energies
    // (low 0–120 Hz vs mid 180–2500 Hz), low must be within 3 dB of mid.
    if !l.is_empty() && res.hits.iter().any(|h| h.class == DrumClass::Kick) {
        let n = l.len().min(r.len());
        let mono: Vec<f32> = (0..n).map(|i| (l[i] + r[i]) * 0.5).collect();
        let low = lr4_low(&mono, sr, 120.0);
        let mid = lr4_band(&mono, sr, 180.0, 2500.0);
        let half_win = (0.012 * sr) as usize;
        res.hits.retain(|h| {
            if h.class != DrumClass::Kick {
                return true;
            }
            let a = h.pos.saturating_sub(half_win);
            let b = h.pos + half_win;
            let el = window_energy(&low, a, b) / 120.0;
            let em = window_energy(&mid, a, b) / 2320.0;
            10.0 * (el / em.max(1e-20)).log10() >= -3.0
        });
    }
    res
}

/// Assign polarity: correlate the first 5 ms of the chosen kit sample with
/// the band-limited stem segment at the hit; flip on negative correlation.
pub fn assign_polarity(hits: &mut [Hit], kit: &DrumKit, l: &[f32], r: &[f32], sr: f64) {
    let n = l.len().min(r.len());
    let mono: Vec<f32> = (0..n).map(|i| (l[i] + r[i]) * 0.5).collect();
    let low = lr4_low(&mono, sr, 120.0);
    let mid = lr4_band(&mono, sr, 180.0, 2500.0);
    let high = lr4_high(&mono, sr, 7000.0);
    let win = (0.005 * sr) as usize;
    let mut rr_counters = [0usize; 3];
    for h in hits.iter_mut() {
        let band = match h.class {
            DrumClass::Kick => &low,
            DrumClass::Snare => &mid,
            DrumClass::Hihat => &high,
        };
        let w = &kit.waves[h.class as usize][h.layer - 1][rr_counters[h.class as usize] % 2];
        let a = DrumKit::attack_cross(w);
        let len = win.min(w.len() - a.min(w.len()));
        // The refined position has ~1 ms residual offset vs the sample's
        // own attack crossing — scan ±3 ms and take the sign of the
        // strongest correlation.
        let scan = (0.003 * sr) as i64;
        let mut best_pos = 0.0f64;
        let mut best_neg = 0.0f64;
        let mut e = 0.0f64;
        for lag in -scan..=scan {
            let mut corr = 0.0f64;
            for i in 0..len {
                let si = h.pos as i64 + i as i64 + lag;
                if si < 0 || si as usize >= band.len() {
                    break;
                }
                corr += w[a + i] as f64 * band[si as usize] as f64;
            }
            if corr > best_pos {
                best_pos = corr;
            }
            if corr < best_neg {
                best_neg = corr;
            }
        }
        for i in 0..len {
            e += w[a + i] as f64 * w[a + i] as f64;
        }
        h.flip = e > 0.0 && best_neg.abs() > best_pos;
        rr_counters[h.class as usize] += 1;
    }
}

/// Sum kit samples at hit positions with round-robin, polarity and the
/// per-hit velocity gain; `class_gain[c]` scales each class.
fn render_raw(hits: &[Hit], kit: &DrumKit, n: usize, class_gain: &[f64; 3]) -> Vec<f32> {
    let mut out = vec![0.0f32; n];
    let mut p95 = [0.0f64; 3];
    for (c, p) in p95.iter_mut().enumerate() {
        let mut peaks: Vec<f64> = hits
            .iter()
            .filter(|x| x.class as usize == c)
            .map(|x| x.peak_db)
            .collect();
        peaks.sort_by(|a, b| a.partial_cmp(b).unwrap());
        *p = if peaks.is_empty() {
            0.0
        } else {
            peaks[((peaks.len() * 95) / 100).min(peaks.len() - 1)]
        };
    }
    let mut rr_counters = [0usize; 3];
    for h in hits {
        let rel = (h.peak_db - p95[h.class as usize]).clamp(-24.0, 0.0);
        let gain = (10f64.powf(rel / 20.0) * class_gain[h.class as usize]) as f32;
        let rr = rr_counters[h.class as usize] % 2;
        rr_counters[h.class as usize] += 1;
        let w = &kit.waves[h.class as usize][h.layer - 1][rr];
        let cross = DrumKit::attack_cross(w);
        let sign = if h.flip { -1.0f32 } else { 1.0f32 };
        let start = h.pos as i64 - cross as i64;
        for (i, &s) in w.iter().enumerate() {
            let idx = start + i as i64;
            if idx < 0 {
                continue;
            }
            let idx = idx as usize;
            if idx >= n {
                break;
            }
            out[idx] += s * gain * sign;
        }
    }
    out
}

/// Render the reinforcement track `R` (mono at `sr`): kit samples aligned
/// to hits, round-robin alternating, per-hit gain from hit peak, per-class
/// static gain so each class-band RMS of R over the hit windows equals the
/// stem's class-band RMS.
pub fn render_reinforcement(
    hits: &[Hit],
    kit: &DrumKit,
    l: &[f32],
    r: &[f32],
    sr: f64,
) -> Vec<f32> {
    let n = l.len().min(r.len());
    let out = render_raw(hits, kit, n, &[1.0, 1.0, 1.0]);
    let mono: Vec<f32> = (0..n).map(|i| (l[i] + r[i]) * 0.5).collect();
    let low = lr4_low(&mono, sr, 120.0);
    let mid = lr4_band(&mono, sr, 180.0, 2500.0);
    let high = lr4_high(&mono, sr, 7000.0);

    // Per-class static gain so class-band RMS of R equals the stem's.
    let r_low = lr4_low(&out, sr, 120.0);
    let r_mid = lr4_band(&out, sr, 180.0, 2500.0);
    let r_high = lr4_high(&out, sr, 7000.0);
    let mut gains = [1.0f64; 3];
    let win = (0.3 * sr) as usize;
    for cls in [DrumClass::Kick, DrumClass::Snare, DrumClass::Hihat] {
        let (sb, rb) = match cls {
            DrumClass::Kick => (&low, &r_low),
            DrumClass::Snare => (&mid, &r_mid),
            DrumClass::Hihat => (&high, &r_high),
        };
        let mut es = 0.0;
        let mut er = 0.0;
        for h in hits {
            if h.class != cls {
                continue;
            }
            es += window_energy(sb, h.pos, h.pos + win);
            er += window_energy(rb, h.pos, h.pos + win);
        }
        if er > 1e-12 && es > 1e-12 {
            gains[cls as usize] = (es / er).sqrt();
        }
    }
    render_raw(hits, kit, n, &gains)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 44_100.0;

    fn kit() -> DrumKit {
        DrumKit::load(&kit_dir(), SR as u32).expect("kit must load")
    }

    /// Render a synthetic drums stem from the kit: hits at known sample
    /// times plus white noise at -30 dB. Returns (l, r, true hits as
    /// (class, attack-time)).
    fn synth_stem() -> (Vec<f32>, Vec<f32>, Vec<(DrumClass, usize)>) {
        let k = kit();
        let n = (SR * 8.0) as usize;
        let mut x = vec![0.0f32; n];
        let mut truth: Vec<(DrumClass, usize)> = Vec::new();
        let mut place =
            |cls: DrumClass, layer: usize, rr: usize, t: f64, gain: f32, flip: bool| {
                let w = &k.waves[cls as usize][layer - 1][rr];
                let cross = DrumKit::attack_cross(w);
                let start = (t * SR) as i64 - cross as i64;
                let sign = if flip { -1.0 } else { 1.0 };
                for (i, &s) in w.iter().enumerate() {
                    let idx = start + i as i64;
                    if idx >= 0 && (idx as usize) < n {
                        x[idx as usize] += s * gain * sign;
                    }
                }
                truth.push((cls, (t * SR) as usize));
            };
        // Kicks every 1.5 s starting at 0.5 s, varying velocity.
        for (i, g) in [0.9f32, 0.5, 0.7, 0.35, 0.8].iter().enumerate() {
            place(DrumClass::Kick, 4, 0, 0.5 + i as f64 * 1.5, *g, false);
        }
        // Snares, incl. one 4 ms after a kick.
        for (i, g) in [0.8f32, 0.45, 0.65, 0.9].iter().enumerate() {
            place(DrumClass::Snare, 4, 0, 1.0 + i as f64 * 1.5, *g, false);
        }
        place(DrumClass::Snare, 4, 0, 0.504, 0.6, false); // coincides w/ kick @0.5
        // One inverted snare for the polarity test.
        place(DrumClass::Snare, 4, 0, 7.0, 0.7, true);
        // Hats every 0.5 s.
        for i in 0..12 {
            place(DrumClass::Hihat, 4, i % 2, 0.25 + i as f64 * 0.5, 0.4, false);
        }
        // Noise floor at -30 dBFS.
        let mut seed = 0x13579BDFu64;
        let amp = 10f64.powf(-30.0 / 20.0) as f32;
        for v in &mut x {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            *v += ((((seed >> 33) as f64 / u32::MAX as f64) * 2.0 - 1.0) * 0.5) as f32 * amp;
        }
        truth.sort_by_key(|t| t.1);
        (x.clone(), x, truth)
    }

    #[test]
    fn detects_synthetic_stem() {
        let k = kit();
        let (l, r, truth) = synth_stem();
        let mut hits = detect_hits(&l, &r, SR);
        assign_polarity(&mut hits, &k, &l, &r, SR);
        let tol = (0.020 * SR) as usize; // match window for evaluation
        let mut matched_true = vec![false; truth.len()];
        let mut tp = 0usize;
        let mut class_ok = 0usize;
        let mut timing_err = 0f64;
        for h in &hits {
            let mut best: Option<(usize, usize)> = None;
            for (i, &(_c, t)) in truth.iter().enumerate() {
                if matched_true[i] {
                    continue;
                }
                let d = h.pos.abs_diff(t);
                if d <= tol && best.map(|(_, bd)| d < bd).unwrap_or(true) {
                    best = Some((i, d));
                }
            }
            if let Some((i, d)) = best {
                matched_true[i] = true;
                tp += 1;
                timing_err += d as f64;
                if h.class == truth[i].0 {
                    class_ok += 1;
                }
            }
        }
        let recall = tp as f64 / truth.len() as f64;
        let precision = tp as f64 / hits.len().max(1) as f64;
        let mean_err_ms = if tp > 0 {
            timing_err / tp as f64 / SR * 1000.0
        } else {
            99.0
        };
        let acc = class_ok as f64 / tp.max(1) as f64;
        assert!(recall >= 0.95, "recall {recall:.3}");
        assert!(precision >= 0.95, "precision {precision:.3}");
        assert!(mean_err_ms <= 1.0, "timing err {mean_err_ms:.2} ms");
        assert!(acc >= 0.90, "class accuracy {acc:.3}");
        // Polarity: the inverted snare at 7.0 s must be flagged.
        let inv = hits
            .iter()
            .find(|h| h.class == DrumClass::Snare && (h.pos as f64 / SR - 7.0).abs() < 0.02)
            .expect("inverted snare not detected");
        assert!(inv.flip, "inverted snare should be flagged flip=true");
        // A normal snare must not be flagged.
        let norm = hits
            .iter()
            .find(|h| h.class == DrumClass::Snare && (h.pos as f64 / SR - 1.0).abs() < 0.02)
            .expect("normal snare not detected");
        assert!(!norm.flip);
        // Level calibration: class-band RMS of R over hit windows within
        // ±1 dB of the stem's.
        let rbuf = render_reinforcement(&hits, &k, &l, &r, SR);
        let mono: Vec<f32> = (0..l.len()).map(|i| (l[i] + r[i]) * 0.5).collect();
        let win = (0.3 * SR) as usize;
        for cls in [DrumClass::Kick, DrumClass::Snare, DrumClass::Hihat] {
            let (sb, rb) = match cls {
                DrumClass::Kick => (lr4_low(&mono, SR, 120.0), lr4_low(&rbuf, SR, 120.0)),
                DrumClass::Snare => (
                    lr4_band(&mono, SR, 180.0, 2500.0),
                    lr4_band(&rbuf, SR, 180.0, 2500.0),
                ),
                DrumClass::Hihat => (lr4_high(&mono, SR, 7000.0), lr4_high(&rbuf, SR, 7000.0)),
            };
            let (mut es, mut er) = (0.0, 0.0);
            for h in hits.iter().filter(|h| h.class == cls) {
                es += window_energy(&sb, h.pos, h.pos + win);
                er += window_energy(&rb, h.pos, h.pos + win);
            }
            let db = 10.0 * (er / es.max(1e-20)).log10();
            assert!(db.abs() <= 1.0, "{cls:?} calibration {db:.2} dB");
        }
    }

    /// A pattern on an 8th-note grid whose tempo drifts +0.3 % over
    /// 200 s: one global period cannot hold it (error accumulates past
    /// ±30 ms), but the ±1 %-refined local windows must keep ≥ 90 %.
    #[test]
    fn local_grid_tracks_tempo_drift() {
        let p0 = 0.45f64;
        let total = 200.0f64;
        let drift = 0.003f64;
        let mut t = 0.4f64;
        let mut hits: Vec<Hit> = Vec::new();
        let mut cls = 0usize;
        while t < total {
            hits.push(Hit {
                class: if cls % 2 == 0 {
                    DrumClass::Kick
                } else {
                    DrumClass::Snare
                },
                pos: (t * SR) as usize,
                peak_db: -10.0,
                layer: 3,
                flip: false,
            });
            cls += 1;
            t += p0 * (1.0 + drift * t / total) / 2.0;
        }
        let g = gate_hits(&hits, &[], &[], SR);
        assert!(!g.disabled, "local grid gate disabled");
        assert!(
            g.on_grid as f64 >= 0.9 * g.gate1 as f64,
            "on_grid {}/{}",
            g.on_grid,
            g.gate1
        );
        // For contrast, a single global grid on the same onsets is much
        // worse — the local refinement is what carries the pattern.
        let times: Vec<f64> = hits.iter().map(|h| h.pos as f64 / SR).collect();
        let (_, on_global) = grid_phase(&times, g.beat_sec * 500.0);
        assert!(
            g.on_grid > on_global,
            "global grid unexpectedly passes ({on_global} vs {})",
            g.on_grid
        );
    }
}
