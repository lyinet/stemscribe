use crate::audio::decode_audio_file;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TempoAndLoudness {
    pub bpm: f32,
    pub confidence: f32,
    pub peak_dbfs: f32,
    pub rms_dbfs: f32,
}

/// On-device Rust DSP tempo (onset-envelope autocorrelation, 60-180 BPM)
/// and loudness (Peak / RMS dBFS) analyzer.
pub fn analyze_tempo_and_loudness(file_path: &str) -> Result<TempoAndLoudness> {
    let decoded = decode_audio_file(file_path)?;
    let mono = decoded.to_mono();
    let sr = decoded.sample_rate.max(1) as f32;
    Ok(compute_tempo_and_loudness(&mono, sr))
}

pub fn compute_tempo_and_loudness(mono: &[f32], sr: f32) -> TempoAndLoudness {
    if mono.is_empty() {
        return TempoAndLoudness {
            bpm: 120.0,
            confidence: 0.0,
            peak_dbfs: -96.0,
            rms_dbfs: -96.0,
        };
    }

    let mut peak = 0.0f32;
    let mut sum_sq = 0.0f64;
    for &x in mono {
        let a = x.abs();
        if a > peak {
            peak = a;
        }
        sum_sq += (x as f64) * (x as f64);
    }
    let rms = (sum_sq / mono.len() as f64).sqrt() as f32;
    let peak_dbfs = 20.0 * peak.max(1e-5).log10();
    let rms_dbfs = 20.0 * rms.max(1e-5).log10();

    // Analyze up to first 60s in 10ms hops for fast onset envelope autocorrelation
    let max_samples = ((sr * 60.0) as usize).min(mono.len());
    let hop = ((sr * 0.01) as usize).max(128);
    let hop_sec = hop as f32 / sr;

    let mut env = Vec::with_capacity(max_samples / hop + 1);
    for chunk in mono[..max_samples].chunks(hop) {
        let e = (chunk.iter().map(|&v| v * v).sum::<f32>() / chunk.len().max(1) as f32).sqrt();
        env.push(e);
    }

    // Half-wave rectified first-order difference = onset strength envelope
    let mut odf = vec![0.0f32; env.len()];
    for i in 1..env.len() {
        odf[i] = (env[i] - env[i - 1]).max(0.0);
    }

    let min_lag = ((60.0 / 180.0) / hop_sec).round() as usize;
    let max_lag = ((60.0 / 60.0) / hop_sec).round() as usize;
    let max_lag = max_lag.min(odf.len().saturating_sub(1));

    let mut best_lag = min_lag.max(1);
    let mut best_score = 0.0f32;
    let mut total_energy = 0.0f32;

    for &v in &odf {
        total_energy += v * v;
    }

    if total_energy > 1e-6 && max_lag > min_lag {
        for lag in min_lag..=max_lag {
            let mut acc = 0.0f32;
            for i in 0..(odf.len() - lag) {
                acc += odf[i] * odf[i + lag];
            }
            if acc > best_score {
                best_score = acc;
                best_lag = lag;
            }
        }
    }

    let raw_bpm = if best_score > 0.0 {
        60.0 / (best_lag as f32 * hop_sec)
    } else {
        120.0
    };
    let bpm = (raw_bpm * 2.0).round() / 2.0;
    let confidence = if total_energy > 1e-6 {
        (best_score / total_energy).clamp(0.0, 1.0)
    } else {
        0.0
    };

    TempoAndLoudness {
        bpm: bpm.clamp(60.0, 180.0),
        confidence,
        peak_dbfs,
        rms_dbfs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_120_bpm_click_track() {
        let sr = 16_000.0f32;
        let len = (sr * 8.0) as usize;
        let mut mono = vec![0.0f32; len];
        // Place sharp impulses every 0.5s (= 120 BPM)
        for beat in 0..16 {
            let idx = (beat as f32 * 0.5 * sr) as usize;
            for k in 0..80 {
                if idx + k < len {
                    mono[idx + k] = 0.9;
                }
            }
        }
        let res = compute_tempo_and_loudness(&mono, sr);
        assert!((res.bpm - 120.0).abs() <= 2.5, "Expected ~120 BPM, got {}", res.bpm);
        assert!(res.peak_dbfs > -2.0);
    }
}
