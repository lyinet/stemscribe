//! Local objective quality critic: Meta Audiobox Aesthetics (CC-BY 4.0).
//! Scores a decoded track on four axes (CE content enjoyment, CU content
//! usefulness, PC production complexity, PQ production quality) by running
//! the int8 ONNX model over back-to-back 10 s windows of mono 16 kHz audio
//! and averaging window scores weighted by window length.

use crate::audio::decode_audio_file;
use crate::audio::resample::resample_hq;
use crate::ml::{audiobox_aes_model_path, build_cpu_session};
use anyhow::{anyhow, Result};
use ndarray::Array3;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};

pub const CRITIC_SAMPLE_RATE: u32 = 16_000;
/// One 10 s analysis window; the tail window is shorter and never padded.
pub const WINDOW_SAMPLES: usize = 160_000;

// Denormalization constants from the model's config.json target_transform
// (score = normalized * std + mean), axis order CE, CU, PC, PQ.
const TARGET_MEAN: [f32; 4] = [5.06865, 5.73633, 3.18591, 6.57505];
const TARGET_STD: [f32; 4] = [1.93029, 1.75669, 1.86637, 1.51466];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CriticWindow {
    pub start_sec: f64,
    pub pq: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CriticScore {
    pub ce: f32,
    pub cu: f32,
    pub pc: f32,
    pub pq: f32,
    pub duration_sec: f64,
    pub windows: Vec<CriticWindow>,
}

/// Back-to-back window (start, len) pairs covering `total` samples.
fn split_windows(total: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < total {
        let len = (total - start).min(WINDOW_SAMPLES);
        out.push((start, len));
        start += len;
    }
    out
}

/// Length-weighted mean of per-window axis scores; `w = len / WINDOW_SAMPLES`.
fn weighted_mean(per_window: &[(usize, [f32; 4])]) -> [f32; 4] {
    let mut acc = [0f64; 4];
    let mut wsum = 0f64;
    for (len, s) in per_window {
        let w = *len as f64 / WINDOW_SAMPLES as f64;
        wsum += w;
        for (k, a) in acc.iter_mut().enumerate() {
            *a += s[k] as f64 * w;
        }
    }
    if wsum <= 0.0 {
        return [0.0; 4];
    }
    let mut out = [0f32; 4];
    for (k, a) in acc.iter().enumerate() {
        out[k] = (a / wsum) as f32;
    }
    out
}

pub fn score_audio(path: &str) -> Result<CriticScore> {
    let model_path = audiobox_aes_model_path()?;
    if !model_path.exists() {
        return Err(anyhow!(
            "audiobox_aes 模型未安装（期望 {}）：设置 → 本地模型 → 下载 / 导入模型",
            model_path.display()
        ));
    }
    let mono16 = {
        let decoded = decode_audio_file(path)?;
        let ch = decoded.channels.max(1);
        let frames = decoded.samples.len() / ch;
        if frames == 0 {
            return Err(anyhow!("音频为空或无法解码: {path}"));
        }
        let mut mono = vec![0f32; frames];
        for i in 0..frames {
            let mut s = 0f32;
            for c in 0..ch {
                s += decoded.samples[i * ch + c];
            }
            mono[i] = s / ch as f32;
        }
        resample_hq(&mono, decoded.sample_rate, CRITIC_SAMPLE_RATE)
    };

    let mut session = build_cpu_session(&model_path)?;
    let windows_spec = split_windows(mono16.len());
    let mut per_window: Vec<(usize, [f32; 4])> = Vec::with_capacity(windows_spec.len());
    let mut windows: Vec<CriticWindow> = Vec::with_capacity(windows_spec.len());
    for (start, len) in &windows_spec {
        let input = Array3::from_shape_vec(
            (1, 1, *len),
            mono16[*start..*start + *len].to_vec(),
        )?;
        let outs = session.run(ort::inputs![Tensor::from_array(input)?])?;
        let (shape, data) = outs[0].try_extract_tensor::<f32>()?;
        if data.len() < 4 {
            return Err(anyhow!("audiobox_aes 输出形状异常: {shape:?}"));
        }
        let mut score = [0f32; 4];
        for k in 0..4 {
            score[k] = data[k] * TARGET_STD[k] + TARGET_MEAN[k];
        }
        per_window.push((*len, score));
        windows.push(CriticWindow {
            start_sec: *start as f64 / CRITIC_SAMPLE_RATE as f64,
            pq: score[3],
        });
    }

    let mean = weighted_mean(&per_window);
    Ok(CriticScore {
        ce: mean[0],
        cu: mean[1],
        pc: mean[2],
        pq: mean[3],
        duration_sec: mono16.len() as f64 / CRITIC_SAMPLE_RATE as f64,
        windows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_split_and_weighting_25s() {
        // 25 s at 16 kHz: two full 10 s windows plus a 5 s tail (weight 0.5).
        let total = 25 * WINDOW_SAMPLES / 10;
        let ws = split_windows(total);
        assert_eq!(ws.len(), 3);
        assert_eq!(ws[0], (0, WINDOW_SAMPLES));
        assert_eq!(ws[1], (WINDOW_SAMPLES, WINDOW_SAMPLES));
        assert_eq!(ws[2], (2 * WINDOW_SAMPLES, WINDOW_SAMPLES / 2));

        // Scores 2, 4, 8 per axis → (1*2 + 1*4 + 0.5*8) / 2.5 = 4.
        let per_window = vec![
            (WINDOW_SAMPLES, [2.0; 4]),
            (WINDOW_SAMPLES, [4.0; 4]),
            (WINDOW_SAMPLES / 2, [8.0; 4]),
        ];
        let mean = weighted_mean(&per_window);
        for m in mean {
            assert!((m - 4.0).abs() < 1e-5, "weighted mean {m} != 4.0");
        }
    }
}
