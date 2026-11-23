//! Long-term average spectrum via Welch's method (FFT 8192, Hann, 50%
//! overlap, on the mid channel), aggregated into 1/6-octave bands.

use realfft::RealFftPlanner;
use serde::{Deserialize, Serialize};

pub const FFT_SIZE: usize = 8192;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BandLevel {
    pub hz: f32,
    pub db: f32,
}

fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (n - 1) as f32).cos())
        .collect()
}

/// Welch power spectral density estimate on `mono`, returning one mean-power
/// value per FFT bin (0..=N/2). Power units are consistent across bins; call
/// sites convert to dB.
pub fn welch_psd(mono: &[f32], rate: u32) -> Vec<f64> {
    let n = FFT_SIZE;
    if mono.len() < n {
        // Zero-pad short clips into a single frame.
        let mut padded = mono.to_vec();
        padded.resize(n, 0.0);
        return welch_psd(&padded, rate);
    }
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    let window = hann(n);
    let win_energy: f64 = window.iter().map(|&w| (w as f64) * (w as f64)).sum();
    let hop = n / 2;
    let bins = n / 2 + 1;
    let mut power = vec![0.0f64; bins];
    let mut frames = 0usize;
    let mut input = fft.make_input_vec();
    let mut output = fft.make_output_vec();

    let mut pos = 0usize;
    while pos + n <= mono.len() {
        for i in 0..n {
            input[i] = mono[pos + i] * window[i];
        }
        if fft.process(&mut input, &mut output).is_ok() {
            for (b, c) in output.iter().enumerate() {
                power[b] += ((c.re as f64) * (c.re as f64) + (c.im as f64) * (c.im as f64))
                    / (n as f64 * win_energy);
            }
            frames += 1;
        }
        pos += hop;
    }
    if frames > 0 {
        for p in &mut power {
            *p /= frames as f64;
        }
    }
    let _ = rate;
    power
}

/// 1/6-octave band levels from a Welch PSD. Bands run from 20 Hz up to the
/// highest band whose centre is below `rate`/2.
pub fn sixth_octave_bands(psd: &[f64], rate: u32) -> Vec<BandLevel> {
    let n = psd.len().saturating_sub(1).max(1) * 2; // FFT size
    let bin_hz = rate as f64 / n as f64;
    let nyquist = rate as f64 / 2.0;
    let mut bands = Vec::new();
    let step = 2f64.powf(1.0 / 12.0); // band edge ratio (±1/12 octave)
    let mut fc = 20.0f64;
    while fc <= nyquist {
        let lo = fc / step;
        let hi = fc * step;
        let mut sum = 0.0f64;
        let mut cnt = 0usize;
        let mut b = (lo / bin_hz).ceil() as usize;
        if b == 0 {
            b = 1;
        }
        while b < psd.len() && (b as f64) * bin_hz <= hi {
            sum += psd[b];
            cnt += 1;
            b += 1;
        }
        let db = if cnt > 0 && sum > 0.0 {
            10.0 * (sum / cnt as f64).log10()
        } else if cnt == 0 && !psd.is_empty() {
            // Band narrower than the FFT bin spacing: take the PSD
            // interpolated at the band centre instead of flooring out.
            let x = fc / bin_hz;
            let i0 = (x.floor() as usize).min(psd.len() - 1);
            let i1 = (i0 + 1).min(psd.len() - 1);
            let t = x - i0 as f64;
            let p = psd[i0] + (psd[i1] - psd[i0]) * t;
            if p > 0.0 {
                10.0 * p.log10()
            } else {
                -160.0
            }
        } else {
            -160.0
        };
        bands.push(BandLevel {
            hz: fc as f32,
            db: db as f32,
        });
        fc *= 2f64.powf(1.0 / 6.0);
    }
    bands
}
