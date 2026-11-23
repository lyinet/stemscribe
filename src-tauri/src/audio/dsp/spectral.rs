//! Soothe-style STFT resonance suppressor. FFT 2048, hop 512, sqrt-Hann
//! analysis+synthesis, centred frames (zero net latency), perfect
//! reconstruction when no cut is applied.

use realfft::{num_complex::Complex, RealFftPlanner};

pub struct SpectralSuppressor {
    sr: f64,
    f_lo: f64,
    f_hi: f64,
    threshold_db: f64,
    depth: f64,
    max_cut_db: f64,
    attack_ms: f64,
    release_ms: f64,
}

const N: usize = 2048;
const HOP: usize = 512;

impl SpectralSuppressor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        sr: f64,
        f_lo: f64,
        f_hi: f64,
        threshold_db: f64,
        depth: f64,
        max_cut_db: f64,
        attack_ms: f64,
        release_ms: f64,
    ) -> Self {
        Self {
            sr,
            f_lo,
            f_hi,
            threshold_db,
            depth,
            max_cut_db,
            attack_ms,
            release_ms,
        }
    }

    fn sqrt_hann() -> Vec<f64> {
        (0..N)
            .map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (N - 1) as f64).cos()).sqrt())
            .collect()
    }

    /// Mono convenience: stereo callers run one instance per channel.
    pub fn process(&mut self, x: &[f32]) -> Vec<f32> {
        let n = x.len();
        let pad = N / 2;
        let len = n + N; // padded on both sides
        let mut padded = vec![0.0f64; len + N];
        for (i, &s) in x.iter().enumerate() {
            padded[pad + i] = s as f64;
        }
        let win = Self::sqrt_hann();
        let n_frames = n / HOP + 1;
        let bins = N / 2 + 1;

        let mut planner = RealFftPlanner::<f64>::new();
        let fft = planner.plan_fft_forward(N);
        let ifft = planner.plan_fft_inverse(N);

        let bin_hz = self.sr / N as f64;
        let lo_bin = (self.f_lo / bin_hz).floor() as usize;
        let hi_bin = ((self.f_hi / bin_hz).ceil() as usize).min(bins - 1);
        // 1/3-octave smoothing width in bins
        let smooth_bins = |b: usize| -> (usize, usize) {
            let f = b as f64 * bin_hz;
            let lo = f / 2f64.powf(1.0 / 6.0);
            let hi = f * 2f64.powf(1.0 / 6.0);
            (
                (lo / bin_hz).floor() as usize,
                ((hi / bin_hz).ceil() as usize).min(bins - 1),
            )
        };
        let atk_c = (-(HOP as f64) / (self.attack_ms.max(0.1) * self.sr / 1000.0)).exp();
        let rel_c = (-(HOP as f64) / (self.release_ms.max(1.0) * self.sr / 1000.0)).exp();

        let mut out_acc = vec![0.0f64; padded.len()];
        let mut norm_acc = vec![0.0f64; padded.len()];
        let mut cut_prev = vec![0.0f64; bins];

        let mut frame_in = fft.make_input_vec();
        let mut spec = fft.make_output_vec();
        let mut frame_out = ifft.make_output_vec();
        let mut work = ifft.make_input_vec();

        for fr in 0..n_frames {
            let centre = fr * HOP; // centre position in padded buffer coords
            let start = centre; // frame [centre, centre+N)
            for i in 0..N {
                frame_in[i] = padded[start + i] * win[i];
            }
            if fft.process(&mut frame_in, &mut spec).is_err() {
                continue;
            }
            // magnitude dB per bin
            for b in 0..bins {
                let _ = b;
            }
            // compute cut per bin
            let mut mags = vec![0.0f64; bins];
            for b in lo_bin..=hi_bin {
                let c = spec[b];
                let m = (c.re * c.re + c.im * c.im).sqrt();
                mags[b] = 20.0 * m.max(1e-12).log10();
            }
            let mut cut = vec![0.0f64; bins];
            for b in lo_bin..=hi_bin {
                let (a, z) = smooth_bins(b);
                let mut s = 0.0;
                let mut c = 0;
                for k in a..=z {
                    if k >= lo_bin && k <= hi_bin {
                        s += mags[k];
                        c += 1;
                    }
                }
                let env = if c > 0 { s / c as f64 } else { mags[b] };
                let excess = mags[b] - env - self.threshold_db;
                if excess > 0.0 {
                    cut[b] = (self.depth * excess).min(self.max_cut_db);
                }
            }
            // temporal smoothing (attack fast, release slow in "cut" units)
            for b in lo_bin..=hi_bin {
                let c = if cut[b] > cut_prev[b] { atk_c } else { rel_c };
                cut_prev[b] = c * cut_prev[b] + (1.0 - c) * cut[b];
            }
            // frequency smoothing ±2 bins
            let mut gain_db = vec![0.0f64; bins];
            for b in lo_bin..=hi_bin {
                let mut s = 0.0;
                let mut c = 0;
                for k in b.saturating_sub(2)..=(b + 2).min(hi_bin) {
                    s += cut_prev[k];
                    c += 1;
                }
                gain_db[b] = s / c as f64;
            }
            // apply
            for b in 0..bins {
                let g = 10f64.powf(-gain_db[b] / 20.0);
                work[b] = Complex::new(spec[b].re * g, spec[b].im * g);
            }
            if ifft.process(&mut work, &mut frame_out).is_err() {
                continue;
            }
            for i in 0..N {
                out_acc[start + i] += frame_out[i] * win[i] / N as f64;
                norm_acc[start + i] += win[i] * win[i];
            }
        }
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let idx = pad + i;
            let d = if norm_acc[idx] > 1e-9 { norm_acc[idx] } else { 1.0 };
            out.push((out_acc[idx] / d) as f32);
        }
        out
    }

    pub fn process_stereo(&mut self, l: &[f32], r: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let ll = self.process(l);
        let rr = self.process(r);
        (ll, rr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_depth_is_null() {
        let sr = 48000.0;
        let x: Vec<f32> = (0..48000)
            .map(|i| {
                (0.3 * (2.0 * std::f64::consts::PI * 997.0 * i as f64 / sr).sin()
                    + 0.2 * (2.0 * std::f64::consts::PI * 3137.0 * i as f64 / sr).sin()) as f32
            })
            .collect();
        let mut s = SpectralSuppressor::new(sr, 2500.0, 9000.0, 4.0, 0.0, 6.0, 5.0, 60.0);
        let y = s.process(&x);
        let mut max_err = 0.0f64;
        for i in 2048..x.len() - 2048 {
            max_err = max_err.max((y[i] - x[i]).abs() as f64);
        }
        let db = 20.0 * max_err.max(1e-12).log10();
        assert!(db <= -100.0, "null error {db:.1} dB");
    }
}
