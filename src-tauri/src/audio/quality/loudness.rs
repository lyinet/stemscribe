//! ITU-R BS.1770-4 integrated loudness, EBU Tech 3342 loudness range,
//! true peak (4x oversampling) and sample peak.

use super::super::resample::resample_hq;

/// Biquad in direct-form I, applied per channel.
struct Biquad {
    b: [f64; 3],
    a: [f64; 3],
}

impl Biquad {
    fn process(&self, x: &[f32]) -> Vec<f64> {
        let mut y = Vec::with_capacity(x.len());
        let mut x1 = 0.0f64;
        let mut x2 = 0.0f64;
        let mut y1 = 0.0f64;
        let mut y2 = 0.0f64;
        for &s in x {
            let x0 = s as f64;
            let y0 = self.b[0] * x0 + self.b[1] * x1 + self.b[2] * x2
                - self.a[1] * y1
                - self.a[2] * y2;
            y.push(y0);
            x2 = x1;
            x1 = x0;
            y2 = y1;
            y1 = y0;
        }
        y
    }
}

/// K-weighting coefficients for an arbitrary sample rate, using the same
/// bilinear design as the BS.1770 reference implementation (DeMan's
/// corrected pre-filter and the RLB high-pass).
fn k_weighting(rate: f64) -> (Biquad, Biquad) {
    // Pre-filter: high shelf.
    let f0 = 1681.974450955533f64;
    let g = 3.999843853973347f64;
    let q = 0.7071752369554196f64;
    let k = (std::f64::consts::PI * f0 / rate).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let pre = Biquad {
        b: [
            (vh + vb * k / q + k * k) / a0,
            2.0 * (k * k - vh) / a0,
            (vh - vb * k / q + k * k) / a0,
        ],
        a: [1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
    };
    // RLB high-pass.
    let f0r = 38.13547087602444f64;
    let qr = 0.5003270373238773f64;
    let kr = (std::f64::consts::PI * f0r / rate).tan();
    let a0r = 1.0 + kr / qr + kr * kr;
    let rlb = Biquad {
        b: [1.0 / a0r, -2.0 / a0r, 1.0 / a0r],
        a: [1.0, 2.0 * (kr * kr - 1.0) / a0r, (1.0 - kr / qr + kr * kr) / a0r],
    };
    (pre, rlb)
}

/// Channel-wise mean-square sequence for windowed loudness stats: applies the
/// two K-weighting stages and returns per-channel filtered power summed over
/// channels as a running prefix sum so arbitrary windows are O(1).
fn gated_prefix_energy(channels: &[Vec<f32>], rate: u32) -> Vec<f64> {
    let (pre, rlb) = k_weighting(rate as f64);
    let n = channels.first().map(|c| c.len()).unwrap_or(0);
    let mut prefix = vec![0.0f64; n + 1];
    for ch in channels {
        let stage1 = pre.process(ch);
        let stage2 = rlb.process(&stage1.iter().map(|&v| v as f32).collect::<Vec<f32>>());
        for (i, v) in stage2.iter().enumerate() {
            prefix[i + 1] += v * v;
        }
    }
    for i in 1..=n {
        prefix[i] += prefix[i - 1];
    }
    prefix
}

fn window_energy(prefix: &[f64], start: usize, len: usize) -> f64 {
    (prefix[start + len] - prefix[start]) / len as f64
}

fn energy_to_loudness(ms: f64) -> f64 {
    -0.691 + 10.0 * ms.log10()
}

/// BS.1770-4 integrated loudness in LUFS. `channels` are planar f32.
pub fn integrated_lufs(channels: &[Vec<f32>], rate: u32) -> f64 {
    if channels.is_empty() {
        return f64::NEG_INFINITY;
    }
    let prefix = gated_prefix_energy(channels, rate);
    let n = prefix.len() - 1;
    let block = (0.4 * rate as f64) as usize;
    let hop = (0.1 * rate as f64) as usize;
    if n < block {
        return f64::NEG_INFINITY;
    }
    let mut energies = Vec::new();
    let mut i = 0usize;
    while i + block <= n {
        let ms = window_energy(&prefix, i, block);
        if ms > 0.0 && energy_to_loudness(ms) >= -70.0 {
            energies.push(ms);
        }
        i += hop;
    }
    if energies.is_empty() {
        return f64::NEG_INFINITY;
    }
    let mean_e = energies.iter().sum::<f64>() / energies.len() as f64;
    let rel_gate = energy_to_loudness(mean_e) - 10.0;
    let mut kept = 0usize;
    let mut sum = 0.0f64;
    for &ms in &energies {
        if energy_to_loudness(ms) >= rel_gate {
            sum += ms;
            kept += 1;
        }
    }
    if kept == 0 {
        return f64::NEG_INFINITY;
    }
    energy_to_loudness(sum / kept as f64)
}

/// EBU Tech 3342 loudness range in LU (3 s windows, 100 ms hop,
/// absolute gate −70 LUFS, relative gate −20 LU, 10th–95th percentile).
pub fn loudness_range_lu(channels: &[Vec<f32>], rate: u32) -> f64 {
    if channels.is_empty() {
        return 0.0;
    }
    let prefix = gated_prefix_energy(channels, rate);
    let n = prefix.len() - 1;
    let win = (3.0 * rate as f64) as usize;
    let hop = (0.1 * rate as f64) as usize;
    if n < win {
        return 0.0;
    }
    let mut values = Vec::new();
    let mut i = 0usize;
    while i + win <= n {
        let ms = window_energy(&prefix, i, win);
        if ms > 0.0 {
            let l = energy_to_loudness(ms);
            if l >= -70.0 {
                values.push(l);
            }
        }
        i += hop;
    }
    if values.is_empty() {
        return 0.0;
    }
    let mean_l = values.iter().sum::<f64>() / values.len() as f64;
    let rel_gate = mean_l - 20.0;
    let mut gated: Vec<f64> = values.into_iter().filter(|&l| l >= rel_gate).collect();
    if gated.is_empty() {
        return 0.0;
    }
    gated.sort_by(|a, b| a.total_cmp(b));
    let p = |frac: f64| -> f64 {
        let idx = ((gated.len() - 1) as f64 * frac).round() as usize;
        gated[idx]
    };
    p(0.95) - p(0.10)
}

/// True peak in dBTP using 4x oversampling; `None` for empty input.
pub fn true_peak_dbtp(channels: &[Vec<f32>], rate: u32) -> f64 {
    let mut tp = 0.0f32;
    for ch in channels {
        if ch.is_empty() {
            continue;
        }
        let up = resample_hq(ch, rate, rate * 4);
        for &s in &up {
            tp = tp.max(s.abs());
        }
    }
    20.0 * (tp.max(1e-9) as f64).log10()
}

pub fn sample_peak_dbfs(channels: &[Vec<f32>]) -> f64 {
    let mut p = 0.0f32;
    for ch in channels {
        for &s in ch {
            p = p.max(s.abs());
        }
    }
    20.0 * (p.max(1e-9) as f64).log10()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo_sine(freq: f64, rate: u32, secs: f64, peak_dbfs: f64) -> Vec<Vec<f32>> {
        let amp = 10f64.powf(peak_dbfs / 20.0);
        let n = (rate as f64 * secs) as usize;
        let ch: Vec<f32> = (0..n)
            .map(|i| (amp * (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin()) as f32)
            .collect();
        vec![ch.clone(), ch]
    }

    #[test]
    fn sine_minus23dbfs_gives_minus23lufs() {
        let ch = stereo_sine(1000.0, 48000, 20.0, -23.0);
        let l = integrated_lufs(&ch, 48000);
        assert!((l - -23.0).abs() <= 0.1, "got {l:.3} LUFS");
    }

    #[test]
    fn sine_minus33dbfs_gives_minus33lufs() {
        let ch = stereo_sine(1000.0, 48000, 20.0, -33.0);
        let l = integrated_lufs(&ch, 48000);
        assert!((l - -33.0).abs() <= 0.1, "got {l:.3} LUFS");
    }

    #[test]
    fn loudness_range_of_two_levels() {
        let mut ch = stereo_sine(1000.0, 48000, 20.0, -20.0);
        let quiet = stereo_sine(1000.0, 48000, 20.0, -30.0);
        ch[0].extend_from_slice(&quiet[0]);
        ch[1].extend_from_slice(&quiet[1]);
        let lra = loudness_range_lu(&ch, 48000);
        assert!((lra - 10.0).abs() <= 1.0, "got {lra:.2} LU");
    }
}
