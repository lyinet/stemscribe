//! Linkwitz-Riley 4th-order crossover (two cascaded 2nd-order Butterworth).

use super::biquad::Biquad;

pub struct Lr4 {
    low: [Biquad; 2],
    high: [Biquad; 2],
}

impl Lr4 {
    pub fn new(sr: f64, freq: f64) -> Self {
        // LR4 = two identical cascaded 2nd-order Butterworth sections per
        // branch -> -6 dB at fc, in-phase -> flat power/voltage sum.
        const Q: f64 = std::f64::consts::FRAC_1_SQRT_2;
        Self {
            low: [Biquad::low_pass(sr, freq, Q), Biquad::low_pass(sr, freq, Q)],
            high: [Biquad::high_pass(sr, freq, Q), Biquad::high_pass(sr, freq, Q)],
        }
    }

    pub fn split(&mut self, x: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let l = self.low.iter_mut().fold(x.to_vec(), |s, b| b.process(&s));
        let h = self.high.iter_mut().fold(x.to_vec(), |s, b| b.process(&s));
        (l, h)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine_amp(sig: &[f32], freq: f64, sr: f64) -> f64 {
        let n = sig.len() / 4;
        let off = n;
        let (mut sa, mut sb) = (0.0f64, 0.0f64);
        for i in 0..n {
            let t = (off + i) as f64 / sr;
            sa += sig[off + i] as f64 * (2.0 * std::f64::consts::PI * freq * t).sin();
            sb += sig[off + i] as f64 * (2.0 * std::f64::consts::PI * freq * t).cos();
        }
        2.0 * (sa * sa + sb * sb).sqrt() / n as f64
    }

    #[test]
    fn low_high_sum_flat() {
        let sr = 48000.0;
        let mut xo = Lr4::new(sr, 2000.0);
        for freq in [60.0, 250.0, 1000.0, 2000.0, 5000.0, 12000.0, 19000.0] {
            let n = (sr * 0.5) as usize;
            let sig: Vec<f32> = (0..n)
                .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32)
                .collect();
            let (lo, hi) = xo.split(&sig);
            let sum: Vec<f32> = lo.iter().zip(hi.iter()).map(|(a, b)| a + b).collect();
            let amp = sine_amp(&sum, freq, sr);
            let db = 20.0 * amp.max(1e-12).log10();
            assert!(db.abs() <= 0.1, "freq {freq}: sum {db:.3} dB");
        }
    }
}
