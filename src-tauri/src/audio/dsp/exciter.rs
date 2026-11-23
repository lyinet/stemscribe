//! HF restoration exciter for sources with a spectral cutoff at `fc`:
//! the band [fc/2, fc] is saturated at 4x oversampling, harmonics above fc
//! are kept, and a static gain aligns the generated band level with the
//! level just below fc plus `target_rel_db`.

use super::biquad::{butter4_highpass, butter4_lowpass};
use super::oversample::map4x;
use crate::audio::quality::spectrum::welch_psd;

fn band_level_db(psd: &[f64], rate: u32, lo: f64, hi: f64) -> f64 {
    let n = psd.len().saturating_sub(1).max(1) * 2;
    let bin_hz = rate as f64 / n as f64;
    let mut sum = 0.0;
    let mut cnt = 0;
    for (b, &p) in psd.iter().enumerate() {
        let f = b as f64 * bin_hz;
        if b > 0 && f >= lo && f < hi {
            sum += p;
            cnt += 1;
        }
    }
    if cnt == 0 || sum <= 0.0 {
        -160.0
    } else {
        10.0 * (sum / cnt as f64).log10()
    }
}

/// Returns the HF-restoration layer only (caller adds it to the mix), for one
/// channel. `fc` = detected cutoff Hz, `target_rel_db` = desired level of the
/// generated band [fc, fc+2k] relative to the input band [fc-2k, fc].
pub fn exciter_band(x: &[f32], sr: u32, fc: f64, target_rel_db: f64) -> Vec<f32> {
    let n = x.len();
    if n == 0 || fc <= 0.0 || fc >= sr as f64 / 2.0 - 500.0 {
        return vec![0.0; n];
    }
    // 1. source band [fc/2, fc]
    let xf: Vec<f64> = x.iter().map(|&v| v as f64).collect();
    let hp = butter4_highpass(sr as f64, fc / 2.0);
    let lp = butter4_lowpass(sr as f64, fc);
    let mut src = vec![0.0f64; n];
    {
        let mut b = hp;
        let tmp: Vec<f64> = x.iter().map(|&v| {
            let mut s = v as f64;
            for q in &mut b {
                s = q.tick(s);
            }
            s
        }).collect();
        let mut l = lp;
        for (i, v) in tmp.iter().enumerate() {
            let mut s = *v;
            for q in &mut l {
                s = q.tick(s);
            }
            src[i] = s;
        }
    }
    // 2. nonlinearity at 4x (block-streamed, bounded memory), then
    // anti-alias decimate back — delay-compensated so output aligns with src.
    let gen = map4x(&src, |v| (3.0 * v).tanh() / 3.0 + 0.3 * v.abs());
    // 3. keep only content above fc (LR4 HP at fc on the generated signal)
    let mut hp2 = butter4_highpass(sr as f64, fc);
    let mut gen_hp = vec![0.0f64; n];
    for (i, v) in gen.iter().enumerate() {
        let mut s = *v;
        for q in &mut hp2 {
            s = q.tick(s);
        }
        gen_hp[i] = s;
    }
    // 4. static gain: level in [fc, fc+2k] should equal input level in
    //    [fc-2k, fc] + target_rel_db, capped at +18 dB.
    let xf32: Vec<f32> = xf.iter().map(|&v| v as f32).collect();
    let gen_f32: Vec<f32> = gen_hp.iter().map(|&v| v as f32).collect();
    let psd_in = welch_psd(&xf32, sr);
    let psd_gen = welch_psd(&gen_f32, sr);
    let in_db = band_level_db(&psd_in, sr, fc - 2000.0, fc);
    let gen_db = band_level_db(&psd_gen, sr, fc, fc + 2000.0);
    let gain_db = (in_db + target_rel_db - gen_db).min(18.0);
    let g = 10f64.powf(gain_db / 20.0);
    gen_hp.iter().map(|&v| (v * g) as f32).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::dsp::biquad::Biquad;
    use crate::audio::quality::spectrum::welch_psd;

    fn band_db(psd: &[f64], sr: u32, lo: f64, hi: f64) -> f64 {
        let n = psd.len();
        let bin_hz = sr as f64 / (2.0 * n as f64);
        let i0 = (lo / bin_hz).floor() as usize;
        let i1 = (hi / bin_hz).ceil() as usize;
        let sum: f64 = (i0..=i1.min(n - 1)).map(|i| psd[i]).sum();
        10.0 * sum.max(1e-30).log10()
    }

    #[test]
    fn restores_band_within_12db() {
        let sr = 48000u32;
        let n = sr as usize * 4;
        // pink-ish noise: filtered white noise
        let mut seed = 12345u64;
        let mut rng = move || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((seed >> 33) as f64 / u32::MAX as f64) * 2.0 - 1.0
        };
        // 8th-order LP at 12 kHz = 4 cascaded Butterworth-2
        let mut lps: Vec<Biquad> = (0..4)
            .map(|_| Biquad::low_pass(sr as f64, 12000.0, std::f64::consts::FRAC_1_SQRT_2))
            .collect();
        let mut x = vec![0.0f32; n];
        for i in 0..n {
            let mut v = rng();
            for b in &mut lps {
                v = b.tick(v);
            }
            x[i] = v as f32;
        }
        let layer = exciter_band(&x, sr, 12000.0, -6.0);
        let mut out = x.clone();
        for i in 0..n.min(layer.len()) {
            out[i] += layer[i];
        }
        let psd = welch_psd(&out, sr);
        let lo = band_db(&psd, sr, 10000.0, 12000.0);
        let hi = band_db(&psd, sr, 12500.0, 14000.0);
        assert!(
            (hi - lo).abs() <= 12.0,
            "10-12k={lo:.1} dB 12.5-14k={hi:.1} dB diff {:.1}",
            hi - lo
        );
    }
}
