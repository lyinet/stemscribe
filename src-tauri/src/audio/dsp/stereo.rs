//! Stereo width (M/S on a band above a split freq) and low-band mono-ization.

use super::crossover::Lr4;

/// Widen/narrow the band above `split` by `width` (side *= width).
pub fn widen_band(
    l: &[f32],
    r: &[f32],
    sr: f64,
    split: f64,
    width: f64,
) -> (Vec<f32>, Vec<f32>) {
    let n = l.len().min(r.len());
    let mut xo_l = Lr4::new(sr, split);
    let mut xo_r = Lr4::new(sr, split);
    let (lo_l, hi_l) = xo_l.split(&l[..n]);
    let (lo_r, hi_r) = xo_r.split(&r[..n]);
    let mut out_l = Vec::with_capacity(n);
    let mut out_r = Vec::with_capacity(n);
    for i in 0..n {
        let mid = (hi_l[i] as f64 + hi_r[i] as f64) * 0.5;
        let side = (hi_l[i] as f64 - hi_r[i] as f64) * 0.5 * width;
        out_l.push((lo_l[i] as f64 + mid + side) as f32);
        out_r.push((lo_r[i] as f64 + mid - side) as f32);
    }
    (out_l, out_r)
}

/// Collapse everything below `fc` to mono (LR4 split, keep high intact).
pub fn mono_below(l: &[f32], r: &[f32], sr: f64, fc: f64) -> (Vec<f32>, Vec<f32>) {
    let n = l.len().min(r.len());
    let ((lo_l, hi_l), (lo_r, hi_r)) = std::thread::scope(|sc| {
        let hl = sc.spawn(|| Lr4::new(sr, fc).split(&l[..n]));
        let hr = sc.spawn(|| Lr4::new(sr, fc).split(&r[..n]));
        (hl.join().unwrap(), hr.join().unwrap())
    });
    let mut out_l = Vec::with_capacity(n);
    let mut out_r = Vec::with_capacity(n);
    for i in 0..n {
        let lm = (lo_l[i] as f64 + lo_r[i] as f64) * 0.5;
        out_l.push((hi_l[i] as f64 + lm) as f32);
        out_r.push((hi_r[i] as f64 + lm) as f32);
    }
    (out_l, out_r)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(v: &[f32]) -> f64 {
        (v.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>()
            / v.len().max(1) as f64)
            .sqrt()
    }

    #[test]
    fn mono_below_collapses_low_band() {
        use super::super::crossover::Lr4;
        let sr = 48000.0;
        let n = (sr as usize) / 2;
        // 60 Hz at different phases per channel + identical 3 kHz
        let l: Vec<f32> = (0..n)
            .map(|i| {
                ((2.0 * std::f64::consts::PI * 60.0 * i as f64 / sr).sin()
                    + 0.3 * (2.0 * std::f64::consts::PI * 3000.0 * i as f64 / sr).sin())
                    as f32
            })
            .collect();
        let r: Vec<f32> = (0..n)
            .map(|i| {
                ((2.0 * std::f64::consts::PI * 60.0 * i as f64 / sr + 1.0).sin()
                    + 0.3 * (2.0 * std::f64::consts::PI * 3000.0 * i as f64 / sr).sin())
                    as f32
            })
            .collect();
        let (ol, orr) = mono_below(&l, &r, sr, 120.0);
        // LR4 monoization reduces the L/R low-band difference by >>20 dB
        // (the hi band keeps an inherent ~-24 dB/oct sub-fc residue).
        let lo_diff = |a: &[f32], b: &[f32]| -> f64 {
            let mut xo = Lr4::new(sr, 120.0);
            let (la, _) = xo.split(a);
            let mut xo2 = Lr4::new(sr, 120.0);
            let (lb, _) = xo2.split(b);
            la.iter()
                .zip(lb.iter())
                .map(|(x, y)| ((x - y) as f64).powi(2))
                .sum::<f64>()
                .sqrt()
        };
        let d_in = lo_diff(&l, &r);
        let d_out = lo_diff(&ol, &orr);
        assert!(d_out < d_in * 0.08, "low-band diff {d_in:.3} -> {d_out:.3}");
        // and low-band energy is retained, not collapsed to silence
        let mut xo = Lr4::new(sr, 120.0);
        let (lo_out, _) = xo.split(&ol);
        let e = lo_out.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>();
        assert!(e / n as f64 > 0.05, "low band lost: e {}", e / n as f64);
    }

    #[test]
    fn widen_increases_side_energy() {
        let sr = 48000.0;
        let n = (sr as usize) / 2;
        let l: Vec<f32> = (0..n)
            .map(|i| {
                (2.0 * std::f64::consts::PI * 500.0 * i as f64 / sr).sin()
                    + 0.5 * (2.0 * std::f64::consts::PI * 3000.0 * i as f64 / sr).sin()
            })
            .map(|v| v as f32)
            .collect();
        let r: Vec<f32> = l
            .iter()
            .enumerate()
            .map(|(i, _)| {
                ((2.0 * std::f64::consts::PI * 500.0 * i as f64 / sr).sin()
                    - 0.5 * (2.0 * std::f64::consts::PI * 3000.0 * i as f64 / sr).sin())
                    as f32
            })
            .collect();
        let (ol, orr) = widen_band(&l, &r, sr, 1000.0, 1.5);
        let side = |a: &[f32], b: &[f32]| -> Vec<f32> {
            a.iter().zip(b.iter()).map(|(x, y)| (x - y) * 0.5).collect()
        };
        let s_in = rms(&side(&l, &r));
        let s_out = rms(&side(&ol, &orr));
        assert!(s_out > s_in * 1.1, "side {s_in:.4} -> {s_out:.4}");
    }
}
