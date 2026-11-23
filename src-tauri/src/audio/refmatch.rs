//! Reference matching: measure the LTAS (mid & side) of a reference track,
//! derive a smooth correction curve vs the current master and apply it as a
//! linear-phase FIR on M and S. Own implementation (no Matchering code).

use super::quality::spectrum::BandLevel;
use realfft::RealFftPlanner;

pub const FIR_TAPS: usize = 8193;
const FMIN: f64 = 20.0;
const FMAX: f64 = 20_000.0;

/// Interpolate a band curve (sorted by hz) at frequency f, linear in log f.
fn curve_at(bands: &[BandLevel], f: f64) -> f64 {
    if bands.is_empty() {
        return 0.0;
    }
    if f <= bands[0].hz as f64 {
        return bands[0].db as f64;
    }
    let last = &bands[bands.len() - 1];
    if f >= last.hz as f64 {
        return last.db as f64;
    }
    let mut i = 1;
    while i < bands.len() && (bands[i].hz as f64) < f {
        i += 1;
    }
    let (h0, h1) = (bands[i - 1].hz as f64, bands[i].hz as f64);
    let t = (f.ln() - h0.ln()) / (h1.ln() - h0.ln()).max(1e-9);
    bands[i - 1].db as f64 + (bands[i].db as f64 - bands[i - 1].db as f64) * t
}

/// Mean dB over bands in [lo, hi] — bands are log-spaced so a plain mean
/// is already log-frequency weighted.
fn band_mean(bands: &[BandLevel], lo: f64, hi: f64) -> f64 {
    let mut sum = 0.0;
    let mut n = 0;
    for b in bands {
        let f = b.hz as f64;
        if f >= lo && f <= hi {
            sum += b.db as f64;
            n += 1;
        }
    }
    if n == 0 {
        0.0
    } else {
        sum / n as f64
    }
}

/// Moving-average smooth a dB-vs-log-f curve sampled at `fs`, window
/// ±`half_oct` octaves. `fs` = (freq, db) pairs sorted by freq.
fn smooth_log(fs: &[(f64, f64)], half_oct: f64) -> Vec<(f64, f64)> {
    fs.iter()
        .map(|&(f, _)| {
            let lo = f / 2f64.powf(half_oct);
            let hi = f * 2f64.powf(half_oct);
            let mut s = 0.0;
            let mut n = 0;
            for &(ff, d) in fs {
                if ff >= lo && ff <= hi {
                    s += d;
                    n += 1;
                }
            }
            (f, if n == 0 { 0.0 } else { s / n as f64 })
        })
        .collect()
}

/// Raised-cosine taper: 0 below `lo_hz`, 1 above `lo_hz*2^half_oct` (when
/// `rising`), or the mirror when `falling`.
fn taper(f: f64, edge_hz: f64, half_oct: f64, rising: bool) -> f64 {
    let a = edge_hz.ln();
    let b = (edge_hz * 2f64.powf(half_oct)).ln();
    let t = ((f.ln() - a) / (b - a)).clamp(0.0, 1.0);
    let w = 0.5 - 0.5 * (t * std::f64::consts::PI).cos();
    if rising {
        w
    } else {
        1.0 - w
    }
}

/// Difference curve (ref − y) of normalized LTAS, smoothed/clamped/tapered.
/// `norm_band` = [lo, hi] normalization window. Returns (freq, dB) pairs on
/// the union of both band grids' evaluation points.
fn diff_curve(
    y: &[BandLevel],
    rf: &[BandLevel],
    smooth_half_oct: f64,
    clamp_db: f64,
    side: bool,
) -> Vec<(f64, f64)> {
    let norm = |b: &[BandLevel]| {
        if side {
            // SMR normalization is implicit: side and mid are both measured
            // against the same 100 Hz-8 kHz mid mean, applied below.
            0.0
        } else {
            band_mean(b, 100.0, 8000.0)
        }
    };
    let ny = norm(y);
    let nr = norm(rf);
    // Evaluate on the union grid (log-spaced, ~1/12 octave)
    let mut fs = Vec::new();
    let mut f = FMIN;
    while f <= FMAX {
        fs.push((f, (curve_at(rf, f) - nr) - (curve_at(y, f) - ny)));
        f *= 2f64.powf(1.0 / 12.0);
    }
    let mut sm = smooth_log(&fs, smooth_half_oct);
    for p in &mut sm {
        p.1 = p.1.clamp(-clamp_db, clamp_db);
    }
    sm
}

/// SMR (side-minus-mid) curve per band evaluated on the log grid.
fn smr_curve(mid: &[BandLevel], side: &[BandLevel]) -> Vec<(f64, f64)> {
    let mut fs = Vec::new();
    let mut f = FMIN;
    while f <= FMAX {
        fs.push((f, curve_at(side, f) - curve_at(mid, f)));
        f *= 2f64.powf(1.0 / 12.0);
    }
    fs
}

/// Mid + side correction curves in dB, sampled on the shared log grid.
/// `input_cutoff` = detected source cutoff (None -> full range).
pub fn match_curves(
    y_mid: &[BandLevel],
    y_side: &[BandLevel],
    ref_mid: &[BandLevel],
    ref_side: &[BandLevel],
    amount: f64,
    input_cutoff_hz: Option<f64>,
) -> (Vec<(f64, f64)>, Vec<(f64, f64)>) {
    // Mid: 1/3-oct smoothing (±1/6 oct window), ±6 dB clamp, taper below
    // 30 Hz and above min(16 kHz, input cutoff).
    let mut dmid = diff_curve(y_mid, ref_mid, 1.0 / 6.0, 6.0, false);
    let hi_edge = input_cutoff_hz.unwrap_or(16_000.0).min(16_000.0);
    for p in &mut dmid {
        let g = taper(p.0, 30.0, 0.5, true) * taper(p.0, hi_edge, 0.5, false);
        p.1 *= g * amount;
    }
    // Side: SMR difference, 1-oct smoothing (±0.5 oct), ±4 dB clamp,
    // active only above 150 Hz.
    let smr_y = smr_curve(y_mid, y_side);
    let smr_r = smr_curve(ref_mid, ref_side);
    let raw: Vec<(f64, f64)> = smr_y
        .iter()
        .zip(smr_r.iter())
        .map(|(&(f, dy), &(_, dr))| (f, dr - dy))
        .collect();
    let mut ds = smooth_log(&raw, 0.5);
    for p in &mut ds {
        p.1 = p.1.clamp(-4.0, 4.0) * taper(p.0, 150.0, 0.5, true) * amount;
    }
    (dmid, ds)
}

/// Design a linear-phase FIR (freq-sampling, Hann window) from a smooth
/// dB curve on the log grid. Returns `FIR_TAPS` taps centred at (TAPS-1)/2.
pub fn design_fir(curve: &[(f64, f64)], sr: f64) -> Vec<f64> {
    let m = FIR_TAPS;
    let n = 2 * (m - 1); // FFT size for the zero-phase impulse
    let bins = n / 2 + 1;
    let mut planner = RealFftPlanner::<f64>::new();
    let irfft = planner.plan_fft_inverse(n);
    let mut spec = irfft.make_input_vec(); // Complex, n/2+1 bins
    for (k, c) in spec.iter_mut().enumerate() {
        let f = k as f64 * sr / n as f64;
        let db = if f < FMIN || k >= bins {
            curve_at_curve(curve, f.max(FMIN))
        } else {
            curve_at_curve(curve, f)
        };
        let lin = 10f64.powf(db / 20.0);
        *c = realfft::num_complex::Complex64::new(lin, 0.0);
    }
    let mut time = irfft.make_output_vec(); // f64, n samples
    irfft.process(&mut spec, &mut time).expect("irfft");
    // Zero-phase impulse: wrap indices 0..m/2 and N-(m/2)..N around centre.
    let alpha = m / 2; // 4096
    let mut h = vec![0.0f64; m];
    let scale = 1.0 / n as f64;
    for i in 0..=alpha {
        h[alpha - i] = time[i] * scale;
        h[alpha + i] = time[if i == 0 { 0 } else { n - i }] * scale;
    }
    // Hann window.
    for (i, v) in h.iter_mut().enumerate() {
        *v *= 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (m - 1) as f64).cos();
    }
    h
}

fn curve_at_curve(curve: &[(f64, f64)], f: f64) -> f64 {
    if curve.is_empty() {
        return 0.0;
    }
    if f <= curve[0].0 {
        return curve[0].1;
    }
    if f >= curve[curve.len() - 1].0 {
        return curve[curve.len() - 1].1;
    }
    let mut i = 1;
    while i < curve.len() && curve[i].0 < f {
        i += 1;
    }
    let (f0, f1) = (curve[i - 1].0, curve[i].0);
    let t = (f.ln() - f0.ln()) / (f1.ln() - f0.ln()).max(1e-9);
    curve[i - 1].1 + (curve[i].1 - curve[i - 1].1) * t
}

/// Offline linear-phase convolution with exact latency compensation:
/// output[i] = conv(x, h)[i + alpha], so a unit-delay-free input passes
/// through with zero net lag (group delay removed).
pub fn apply_fir(x: &[f32], h: &[f64]) -> Vec<f32> {
    let n = x.len();
    let alpha = h.len() / 2;
    let mut planner = RealFftPlanner::<f64>::new();
    // Block size: convolve in 16384-sample hops with 8192-tap kernel.
    let block = 16384usize;
    let fft_len = block + h.len() - 1;
    let fft_len = fft_len.next_power_of_two();
    let fwd = planner.plan_fft_forward(fft_len);
    let inv = planner.plan_fft_inverse(fft_len);
    // Kernel spectrum.
    let mut hpad = vec![0.0f64; fft_len];
    hpad[..h.len()].copy_from_slice(h);
    let mut hs = fwd.make_output_vec();
    let mut hin = fwd.make_input_vec();
    hin.copy_from_slice(&hpad);
    fwd.process(&mut hin, &mut hs).expect("fft");
    let mut out = vec![0.0f64; n + h.len()];
    let scale = 1.0 / fft_len as f64;
    let mut pos = 0usize;
    while pos < n {
        let take = block.min(n - pos);
        hin.iter_mut().for_each(|v| *v = 0.0);
        hin[..take].copy_from_slice(&x[pos..pos + take].iter().map(|v| *v as f64).collect::<Vec<_>>());
        let mut xs = fwd.make_output_vec();
        fwd.process(&mut hin, &mut xs).expect("fft");
        for (a, b) in xs.iter_mut().zip(hs.iter()) {
            *a *= *b;
        }
        let mut time = inv.make_output_vec(); // f64, fft_len samples
        inv.process(&mut xs, &mut time).expect("ifft");
        for i in 0..fft_len.min(n + h.len() - pos) {
            out[pos + i] += time[i] * scale;
        }
        pos += take;
    }
    (0..n).map(|i| out[i + alpha] as f32).collect()
}

/// Full reference-match stage: measure y's mid/side LTAS, derive the
/// correction curves, apply them as linear-phase FIRs, then re-measure
/// and apply one residual pass so the *measured* spectrum (with its
/// band-leakage characteristics) converges to the reference's measured
/// spectrum. Zero net delay in every pass.
pub fn match_apply(
    l: &[f32],
    r: &[f32],
    sr: f64,
    ref_mid: &[BandLevel],
    ref_side: &[BandLevel],
    amount: f64,
    input_cutoff_hz: Option<f64>,
) -> (Vec<f32>, Vec<f32>) {
    if amount <= 0.0 {
        return (l.to_vec(), r.to_vec());
    }
    let mut ol = l.to_vec();
    let mut or_ = r.to_vec();
    for pass in 0..3 {
        let (ym, ys) = super::quality::spectrum::ms_ltas(&ol, &or_, sr as u32);
        let pass_amount = if pass == 0 { amount } else { 1.0 };
        let (cm, cs) =
            match_curves(&ym, &ys, ref_mid, ref_side, pass_amount, input_cutoff_hz);
        if pass > 0 {
            // Stop early when the residual is already negligible.
            let worst = cm
                .iter()
                .chain(cs.iter())
                .fold(0.0f64, |m, p| m.max(p.1.abs()));
            if worst <= 0.15 {
                break;
            }
        }
        let (a, b) = apply_match(&ol, &or_, sr, &cm, &cs);
        ol = a;
        or_ = b;
    }
    (ol, or_)
}

/// Apply the mid/side correction FIRs to a stereo buffer.
/// Returns processed (l, r) with zero net delay.
pub fn apply_match(
    l: &[f32],
    r: &[f32],
    sr: f64,
    mid_curve: &[(f64, f64)],
    side_curve: &[(f64, f64)],
) -> (Vec<f32>, Vec<f32>) {
    let n = l.len().min(r.len());
    let mut mid = Vec::with_capacity(n);
    let mut side = Vec::with_capacity(n);
    for i in 0..n {
        mid.push((l[i] + r[i]) * 0.5);
        side.push((l[i] - r[i]) * 0.5);
    }
    let hm = design_fir(mid_curve, sr);
    let hs = design_fir(side_curve, sr);
    let m2 = apply_fir(&mid, &hm);
    let s2 = apply_fir(&side, &hs);
    let mut ol = Vec::with_capacity(n);
    let mut or_ = Vec::with_capacity(n);
    for i in 0..n {
        ol.push(m2[i] + s2[i]);
        or_.push(m2[i] - s2[i]);
    }
    (ol, or_)
}

/// Normalized-LTAS spectral distance: RMS over bands 60 Hz-12 kHz of the
/// (a_norm − b_norm) difference, dB.
pub fn spectral_distance(a: &[BandLevel], b: &[BandLevel]) -> f64 {
    let na = band_mean(a, 100.0, 8000.0);
    let nb = band_mean(b, 100.0, 8000.0);
    let mut sum = 0.0;
    let mut n = 0;
    for bd in a {
        let f = bd.hz as f64;
        if f >= 60.0 && f <= 12_000.0 {
            let d = (bd.db as f64 - na) - (curve_at(b, f) - nb);
            sum += d * d;
            n += 1;
        }
    }
    if n == 0 {
        0.0
    } else {
        (sum / n as f64).sqrt()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::quality::spectrum::ms_ltas;

    fn pink_noise(n: usize, sr: u32, tilt_db_oct: f64) -> Vec<f32> {
        // Approximate pink noise: white noise through a −3 dB/oct tilt
        // applied in the freq domain, plus optional extra tilt.
        use realfft::RealFftPlanner;
        let m = n.next_power_of_two();
        let mut p = RealFftPlanner::<f64>::new();
        let fwd = p.plan_fft_forward(m);
        let inv = p.plan_fft_inverse(m);
        let mut x = vec![0.0f64; m];
        let mut seed = 0x9E3779B9u64;
        for v in &mut x {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            *v = ((seed >> 33) as f64 / u32::MAX as f64) * 2.0 - 1.0;
        }
        let mut spec = fwd.make_output_vec();
        let mut inp = fwd.make_input_vec();
        inp.copy_from_slice(&x);
        fwd.process(&mut inp, &mut spec).unwrap();
        for (k, c) in spec.iter_mut().enumerate() {
            let f = (k as f64 * sr as f64 / m as f64).max(20.0);
            // −3 dB/oct pink slope, plus optional extra tilt above 1 kHz.
            let mut g = (f / 1000.0).powf(-1.5);
            if f > 1000.0 {
                g *= (f / 1000.0).powf(tilt_db_oct / 6.0);
            }
            *c *= g;
        }
        let mut t = inv.make_output_vec(); // f64 time domain
        inv.process(&mut spec, &mut t).unwrap();
        let sc = 1.0 / m as f64;
        (0..n).map(|i| (t[i] * sc * 0.05) as f32).collect()
    }

    #[test]
    fn pink_match_within_half_db() {
        let sr = 48000u32;
        let n = sr as usize * 4;
        let base = pink_noise(n, sr, 0.0);
        // Reference = same noise with +2 dB/oct tilt above 1 kHz.
        let rf = pink_noise(n, sr, 2.0);
        // Recompute reference from the same noise: apply tilt via FIR? The
        // test uses an independently generated tilted copy — matching must
        // learn the tilt regardless of realization since LTAS is smooth.
        let (_ym, _ys) = ms_ltas(&base, &base, sr);
        let (rm, rs) = ms_ltas(&rf, &rf, sr);
        let (ol, _or) = match_apply(&base, &base, sr as f64, &rm, &rs, 1.0, None);
        let (om, _os) = ms_ltas(&ol, &ol, sr);
        let d = spectral_distance(&om, &rm);
        assert!(d <= 0.5, "distance after = {d:.3} dB");
    }

    #[test]
    fn identical_reference_is_flat() {
        let sr = 48000u32;
        let n = sr as usize * 2;
        let x = pink_noise(n, sr, 0.0);
        let (ym, ys) = ms_ltas(&x, &x, sr);
        let (cm, _cs) = match_curves(&ym, &ys, &ym, &ys, 1.0, None);
        let worst = cm.iter().fold(0.0f64, |m, p| m.max(p.1.abs()));
        assert!(worst <= 0.1, "|D| max = {worst:.3} dB");
    }

    #[test]
    fn fir_has_zero_lag() {
        // A non-flat curve still passes impulses at the right time.
        let sr = 48000.0;
        let n = 48000usize;
        let mut x = vec![0.0f32; n];
        for &i in &[8000usize, 24000, 40000] {
            x[i] = 1.0;
        }
        let curve: Vec<(f64, f64)> = vec![
            (20.0, 0.0),
            (100.0, -2.0),
            (1000.0, 0.0),
            (4000.0, 1.5),
            (10000.0, -1.0),
            (20000.0, 0.0),
        ];
        let h = design_fir(&curve, sr);
        let y = apply_fir(&x, &h);
        for &i in &[8000usize, 24000, 40000] {
            // Impulse must land within ±1 tap of its source index.
            let win = &y[i - 4..i + 5];
            let peak = win.iter().fold(0.0f32, |m, v| m.max(v.abs()));
            assert!(peak > 0.05, "impulse at {i} missing (peak {peak})");
            let (mut bi, mut bv) = (0usize, 0.0f32);
            for (j, &v) in y[i - 8..i + 9].iter().enumerate() {
                if v.abs() > bv {
                    bv = v.abs();
                    bi = j;
                }
            }
            assert_eq!(bi, 8, "impulse at {i} shifted by {}", bi as i64 - 8);
        }
    }
}
