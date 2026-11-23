//! Offline high-quality sample-rate conversion (windowed-sinc via rubato FFT
//! resampler). Delay-compensated: `process_all` resets the resampler, trims the
//! reported output delay and flushes the tail, so an event at input frame n
//! lands at round(n * dst/src) in the output.

use anyhow::{anyhow, Result};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};

const CHUNK: usize = 8192;

fn build(src_rate: u32, dst_rate: u32) -> Result<Fft<f32>> {
    Fft::<f32>::new(
        src_rate as usize,
        dst_rate as usize,
        CHUNK,
        1,
        FixedSync::Input,
    )
    .map_err(|e| anyhow!("重采样器初始化失败（{src_rate} → {dst_rate} Hz）: {e}"))
}

fn run(resampler: &mut Fft<f32>, input: &[f32], src_rate: u32, dst_rate: u32) -> Result<Vec<f32>> {
    let adapter = InterleavedSlice::new(input, 1, input.len())
        .map_err(|e| anyhow!("重采样输入缓冲无效: {e}"))?;
    let out = resampler
        .process_all(&adapter, input.len(), None)
        .map_err(|e| anyhow!("重采样失败: {e}"))?;
    let mut data = out.take_data();
    let target_len = ((input.len() as f64) * dst_rate as f64 / src_rate as f64).round() as usize;
    match data.len().cmp(&target_len) {
        std::cmp::Ordering::Greater => data.truncate(target_len),
        std::cmp::Ordering::Less => data.resize(target_len, 0.0),
        std::cmp::Ordering::Equal => {}
    }
    Ok(data)
}

/// High-quality mono resample. Output length is exactly
/// `round(input.len() * dst_rate / src_rate)`.
pub fn resample_hq(input: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if src_rate == dst_rate || input.is_empty() {
        return input.to_vec();
    }
    let mut resampler = match build(src_rate, dst_rate) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("resample_hq fallback to linear: {e}");
            return resample_linear(input, src_rate, dst_rate);
        }
    };
    run(&mut resampler, input, src_rate, dst_rate).unwrap_or_else(|e| {
        eprintln!("resample_hq fallback to linear: {e}");
        resample_linear(input, src_rate, dst_rate)
    })
}

/// Stereo variant sharing one resampler instance between channels.
pub fn resample_hq_stereo(
    left: &[f32],
    right: &[f32],
    src_rate: u32,
    dst_rate: u32,
) -> (Vec<f32>, Vec<f32>) {
    if src_rate == dst_rate {
        return (left.to_vec(), right.to_vec());
    }
    match build(src_rate, dst_rate) {
        Ok(mut r) => {
            let l = run(&mut r, left, src_rate, dst_rate)
                .unwrap_or_else(|_| resample_linear(left, src_rate, dst_rate));
            let r2 = run(&mut r, right, src_rate, dst_rate)
                .unwrap_or_else(|_| resample_linear(right, src_rate, dst_rate));
            (l, r2)
        }
        Err(_) => (
            resample_linear(left, src_rate, dst_rate),
            resample_linear(right, src_rate, dst_rate),
        ),
    }
}

/// Last-resort linear interpolation (only used if rubato cannot be built).
pub fn resample_linear(input: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if src_rate == dst_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = dst_rate as f64 / src_rate as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = (i as f64) / ratio;
        let idx = src_pos.floor() as usize;
        let frac = (src_pos - idx as f64) as f32;
        let s0 = input.get(idx).copied().unwrap_or(0.0);
        let s1 = input.get(idx + 1).copied().unwrap_or(s0);
        out.push(s0 + (s1 - s0) * frac);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, rate: u32, n: usize, amp: f64) -> Vec<f32> {
        (0..n)
            .map(|i| (amp * (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin()) as f32)
            .collect()
    }

    fn rms(v: &[f32]) -> f64 {
        (v.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() / v.len().max(1) as f64).sqrt()
    }

    #[test]
    fn roundtrip_error_below_minus_80db() {
        let n = 48000;
        let orig = sine(1000.0, 48000, n, 0.5);
        let down = resample_hq(&orig, 48000, 44100);
        let back = resample_hq(&down, 44100, 48000);
        assert_eq!(back.len(), n);
        let margin = 2000;
        let err: Vec<f32> = back[margin..n - margin]
            .iter()
            .zip(orig[margin..n - margin].iter())
            .map(|(a, b)| a - b)
            .collect();
        let err_db = 20.0 * (rms(&err) / rms(&orig[margin..n - margin])).log10();
        assert!(err_db <= -80.0, "roundtrip error {err_db:.1} dB");
    }

    #[test]
    fn antialias_suppresses_23khz() {
        let n = 48000;
        let input = sine(23000.0, 48000, n, 0.5);
        let out = resample_hq(&input, 48000, 44100);
        let in_rms = rms(&input);
        let out_rms = rms(&out[2000..out.len() - 2000]);
        let db = 20.0 * (out_rms / in_rms).log10();
        assert!(db <= -90.0, "alias suppression only {db:.1} dB");
    }

    #[test]
    fn impulse_delay_compensated() {
        let n = 48000;
        let mut input = vec![0.0f32; n];
        input[10000] = 1.0;
        let out = resample_hq(&input, 48000, 44100);
        let expected = (10000.0f64 * 44100.0 / 48000.0).round() as usize;
        let (peak_idx, _) = out
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
            .unwrap();
        assert!(
            (peak_idx as isize - expected as isize).abs() <= 1,
            "peak at {peak_idx}, expected {expected}"
        );
    }

    #[test]
    fn exact_output_lengths() {
        for (src, dst, n) in [
            (48000u32, 44100u32, 48000usize),
            (44100, 48000, 44100),
            (32000, 48000, 32000),
            (48000, 22050, 12345),
            (22050, 44100, 999),
            (96000, 44100, 100000),
        ] {
            let input = sine(440.0, src, n, 0.3);
            let out = resample_hq(&input, src, dst);
            let expected = ((n as f64) * dst as f64 / src as f64).round() as usize;
            assert_eq!(out.len(), expected, "{src}->{dst} n={n}");
        }
    }

    #[test]
    fn identity_same_rate() {
        let input = sine(440.0, 44100, 1000, 0.3);
        let out = resample_hq(&input, 44100, 44100);
        assert_eq!(out, input);
    }
}
