use crate::audio::{decode_audio_file, extract_waveform_peaks, resample_linear, write_stereo_wav};
use crate::ml::{build_cpu_session, demucs_model_path};
use anyhow::{anyhow, Result};
use ndarray::Array3;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const TARGET_SR: u32 = 44_100;
/// 7.8s chunk length matches HTDemucs default training segment (343,980 samples @ 44.1kHz)
const CHUNK_SAMPLES: usize = 343_980;
const OVERLAP_SAMPLES: usize = 44_100; // 1s overlap-add crossfade
const STEM_NAMES: [&str; 4] = ["drums", "bass", "other", "vocals"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StemOutput {
    pub name: String,
    pub label_zh: String,
    pub file_path: String,
    pub waveform_peaks: Vec<f32>,
    pub duration_sec: f64,
}

fn stem_label_zh(name: &str) -> &'static str {
    match name {
        "vocals" => "人声",
        "drums" => "鼓组",
        "bass" => "贝斯",
        "other" => "伴奏/其他",
        _ => "音轨",
    }
}

/// Chunked overlap-add inference for 4-stem HTDemucs ONNX model.
/// Expected ONNX I/O:
/// - Input:  float32 [1, 2, CHUNK_SAMPLES]
/// - Output: float32 [1, 4, 2, CHUNK_SAMPLES] ordered as [drums, bass, other, vocals]
pub fn run_separation(file_path: &str, output_dir: Option<String>) -> Result<Vec<StemOutput>> {
    let model_path = demucs_model_path()?;
    if !model_path.exists() {
        return Err(anyhow!(
            "未安装 AI 分轨模型（htdemucs.onnx）。请在 设置 → 本地模型 中一键下载（约 166 MB），或手动放入 {}",
            model_path.display()
        ));
    }

    let decoded = decode_audio_file(file_path)?;
    let (left_raw, right_raw) = decoded.to_stereo_planar();
    let left = resample_linear(&left_raw, decoded.sample_rate, TARGET_SR);
    let right = resample_linear(&right_raw, decoded.sample_rate, TARGET_SR);
    let total_len = left.len().min(right.len());

    // CoreML runs HTDemucs ~4x slower than CPU and its fp16 path yields NaN
    // (silent stems), so separation always uses the CPU provider.
    let mut session = build_cpu_session(&model_path)?;

    // Output accumulators: 4 stems x 2 channels x total_len
    let mut stem_left = vec![vec![0.0f32; total_len]; 4];
    let mut stem_right = vec![vec![0.0f32; total_len]; 4];
    let mut weight_acc = vec![0.0f32; total_len];

    let hop = CHUNK_SAMPLES - OVERLAP_SAMPLES;
    let mut offset = 0usize;

    while offset < total_len {
        let valid_len = (total_len - offset).min(CHUNK_SAMPLES);
        let mut input = Array3::<f32>::zeros((1, 2, CHUNK_SAMPLES));
        for i in 0..valid_len {
            input[[0, 0, i]] = left[offset + i];
            input[[0, 1, i]] = right[offset + i];
        }

        let outputs = session.run(ort::inputs![Tensor::from_array(input)?])?;
        let (shape, output_data) = outputs[0].try_extract_tensor::<f32>()?;
        if shape.len() != 4 || shape[1] != 4 || shape[2] != 2 || shape[3] as usize != CHUNK_SAMPLES {
            return Err(anyhow!("分轨模型输出形状不符合 HTDemucs 4 轨格式: {shape:?}"));
        }
        if output_data.iter().any(|v| !v.is_finite()) {
            return Err(anyhow!("分轨模型输出了无效数值（NaN），模型文件可能已损坏，请在 设置 → 本地模型 中重新下载"));
        }

        // Flat index for [1, 4, 2, CHUNK_SAMPLES]
        for i in 0..valid_len {
            let w = triangle_window(i, valid_len, OVERLAP_SAMPLES);
            weight_acc[offset + i] += w;
            for s in 0..4 {
                let l_idx = (s * 2) * CHUNK_SAMPLES + i;
                let r_idx = (s * 2 + 1) * CHUNK_SAMPLES + i;
                stem_left[s][offset + i] += output_data[l_idx] * w;
                stem_right[s][offset + i] += output_data[r_idx] * w;
            }
        }

        if offset + CHUNK_SAMPLES >= total_len {
            break;
        }
        offset += hop;
    }

    // Normalize overlap-add weights
    for i in 0..total_len {
        let w = weight_acc[i].max(1e-6);
        for s in 0..4 {
            stem_left[s][i] /= w;
            stem_right[s][i] /= w;
        }
    }

    let out_dir = match output_dir {
        Some(d) => PathBuf::from(d),
        None => std::env::temp_dir().join("stemscribe_stems"),
    };
    std::fs::create_dir_all(&out_dir)?;

    let mut results = Vec::with_capacity(4);
    let duration_sec = total_len as f64 / TARGET_SR as f64;

    for (idx, stem_name) in STEM_NAMES.iter().enumerate() {
        let stem_file = out_dir.join(format!("{stem_name}.wav"));
        write_stereo_wav(&stem_file, &stem_left[idx], &stem_right[idx], TARGET_SR)?;
        let mono: Vec<f32> = stem_left[idx]
            .iter()
            .zip(stem_right[idx].iter())
            .map(|(l, r)| 0.5 * (l + r))
            .collect();
        let peaks = extract_waveform_peaks(&mono, 320);

        results.push(StemOutput {
            name: (*stem_name).to_string(),
            label_zh: stem_label_zh(stem_name).to_string(),
            file_path: stem_file.to_string_lossy().to_string(),
            waveform_peaks: peaks,
            duration_sec,
        });
    }

    Ok(results)
}

fn triangle_window(i: usize, len: usize, fade: usize) -> f32 {
    if fade == 0 || len <= 2 {
        return 1.0;
    }
    let f = fade.min(len / 2);
    if i < f {
        (i + 1) as f32 / f as f32
    } else if i >= len - f {
        (len - i) as f32 / f as f32
    } else {
        1.0
    }
}
