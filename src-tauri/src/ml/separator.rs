use crate::audio::{decode_audio_file, extract_waveform_peaks, resample::resample_hq_stereo, write_stereo_wav_f32};
use crate::ml::{build_cpu_session, demucs_ft_vocals_model_path, demucs_model_path};
use anyhow::{anyhow, Result};
use ndarray::Array3;
use ort::session::Session;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const TARGET_SR: u32 = 44_100;
/// 7.8s chunk length matches HTDemucs default training segment (343,980 samples @ 44.1kHz)
const CHUNK_SAMPLES: usize = 343_980;
const OVERLAP_SAMPLES: usize = 44_100; // 1s overlap-add crossfade
const STEM_NAMES: [&str; 4] = ["drums", "bass", "other", "vocals"];
/// Stem indices in the model output [drums, bass, other, vocals].
const IDX_OTHER: usize = 2;
const IDX_VOCALS: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StemOutput {
    pub name: String,
    pub label_zh: String,
    pub file_path: String,
    pub waveform_peaks: Vec<f32>,
    pub duration_sec: f64,
    /// Engine role: lead/backing/drums/perc/bass/other (None = derive).
    #[serde(default)]
    pub role: Option<String>,
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
///
/// `high_quality` additionally runs the HTDemucs-FT vocals specialist on
/// the same chunks and replaces the vocals stem with its index-3 output;
/// `other` absorbs `base_vocals − ft_vocals` so Σstems is preserved
/// (see `absorb_vocal_delta`).
pub fn run_separation(
    file_path: &str,
    output_dir: Option<String>,
    high_quality: bool,
) -> Result<Vec<StemOutput>> {
    // Stems for a given source live in a per-song dir under app data (not
    // the shared temp dir), which doubles as the separation cache: a
    // completed run leaves stems.json + the four wavs.
    let auto_dir = output_dir.is_none();
    let out_dir = match output_dir {
        Some(d) => PathBuf::from(d),
        None => crate::ml::stems_dir_for(file_path)?,
    };
    let sidecar = out_dir.join("stems.json");
    if auto_dir && sidecar.is_file() {
        if let Ok(text) = std::fs::read_to_string(&sidecar) {
            if let Ok(cached) = serde_json::from_str::<serde_json::Value>(&text) {
                let flag_ok = cached
                    .get("high_quality")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                    == high_quality;
                if flag_ok {
                    if let Ok(stems) =
                        serde_json::from_value::<Vec<StemOutput>>(cached["stems"].clone())
                    {
                        if stems.len() == 4
                            && stems
                                .iter()
                                .all(|s| std::path::Path::new(&s.file_path).is_file())
                        {
                            return Ok(stems);
                        }
                    }
                }
            }
        }
    }

    let model_path = demucs_model_path()?;
    if !model_path.exists() {
        return Err(anyhow!(
            "未安装 AI 分轨模型（htdemucs.onnx）。请在 设置 → 本地模型 中一键下载（约 166 MB），或手动放入 {}",
            model_path.display()
        ));
    }

    let decoded = decode_audio_file(file_path)?;
    let (left_raw, right_raw) = decoded.to_stereo_planar();
    let src_sr = decoded.sample_rate;
    drop(decoded);
    let (left, right) = resample_hq_stereo(&left_raw, &right_raw, src_sr, TARGET_SR);
    drop(left_raw);
    drop(right_raw);
    let total_len = left.len().min(right.len());

    // CoreML runs HTDemucs ~4x slower than CPU and its fp16 path yields NaN
    // (silent stems), so separation always uses the CPU provider.
    let (mut stem_left, mut stem_right) = {
        let mut session = build_cpu_session(&model_path)?;
        infer_stems(&mut session, &left, &right, total_len)?
    };

    if high_quality {
        let ft_path = demucs_ft_vocals_model_path()?;
        if !ft_path.exists() {
            return Err(anyhow!(
                "未安装 HTDemucs-FT 人声专家模型（htdemucs_ft_vocals.onnx）。请在 设置 → 本地模型 中一键下载（约 166 MB），或关闭 高质量分轨"
            ));
        }
        let mut ft_session = build_cpu_session(&ft_path)?;
        let (ft_left, ft_right) = infer_stems(&mut ft_session, &left, &right, total_len)?;
        for ch in 0..2 {
            let (acc, ft) = if ch == 0 {
                (&mut stem_left, &ft_left)
            } else {
                (&mut stem_right, &ft_right)
            };
            let (lo, hi) = acc.split_at_mut(IDX_VOCALS);
            absorb_vocal_delta(&mut lo[IDX_OTHER], &hi[0], &ft[IDX_VOCALS]);
        }
        stem_left[IDX_VOCALS] = ft_left[IDX_VOCALS].clone();
        stem_right[IDX_VOCALS] = ft_right[IDX_VOCALS].clone();
    }

    std::fs::create_dir_all(&out_dir)?;

    let mut results = Vec::with_capacity(4);
    let duration_sec = total_len as f64 / TARGET_SR as f64;

    for (idx, stem_name) in STEM_NAMES.iter().enumerate() {
        let stem_file = out_dir.join(format!("{stem_name}.wav"));
        write_stereo_wav_f32(&stem_file, &stem_left[idx], &stem_right[idx], TARGET_SR)?;
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
            role: Some(match *stem_name {
                "vocals" => "lead".to_string(),
                "drums" => "drums".to_string(),
                "bass" => "bass".to_string(),
                _ => "other".to_string(),
            }),
        });
    }

    if auto_dir {
        let sidecar_json = serde_json::json!({
            "source": file_path,
            "high_quality": high_quality,
            "stems": results,
        });
        if let Ok(text) = serde_json::to_string(&sidecar_json) {
            let _ = std::fs::write(&sidecar, text);
        }
    }

    Ok(results)
}

/// Chunked overlap-add inference of one 4-stem ONNX model over the whole
/// mix. Returns (left, right) per-stem buffers.
fn infer_stems(
    session: &mut Session,
    left: &[f32],
    right: &[f32],
    total_len: usize,
) -> Result<(Vec<Vec<f32>>, Vec<Vec<f32>>)> {
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

    Ok((stem_left, stem_right))
}

/// After replacing the vocals stem with the FT specialist output, fold
/// `base_vocals − ft_vocals` into `other` so the stem sum is preserved
/// exactly: other' + ft = other + base (up to f32 rounding).
pub fn absorb_vocal_delta(other: &mut [f32], base_vocals: &[f32], ft_vocals: &[f32]) {
    for i in 0..other.len() {
        other[i] += base_vocals[i] - ft_vocals[i];
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// After replacing vocals with the FT output and absorbing the delta
    /// into `other`, Σstems must equal the base Σstems up to f32 rounding.
    #[test]
    fn vocal_delta_rebalance_preserves_stem_sum() {
        let n = 4096usize;
        let gen = |seed: u64| -> Vec<f32> {
            (0..n)
                .map(|i| ((i as f64 * 0.013 + seed as f64).sin() * 0.3) as f32)
                .collect()
        };
        let drums = gen(1);
        let bass = gen(2);
        let orig_other = gen(3);
        let base_voc = gen(4);
        let ft_voc = gen(5);
        let mut other = orig_other.clone();
        absorb_vocal_delta(&mut other, &base_voc, &ft_voc);
        let mut max_diff = 0.0f64;
        for i in 0..n {
            let before = drums[i] as f64 + bass[i] as f64 + orig_other[i] as f64 + base_voc[i] as f64;
            let after = drums[i] as f64 + bass[i] as f64 + other[i] as f64 + ft_voc[i] as f64;
            max_diff = max_diff.max((after - before).abs());
        }
        assert!(max_diff < 1e-6, "stem sum drifted by {max_diff}");
    }
}
