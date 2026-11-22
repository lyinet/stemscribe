use crate::audio::{decode_audio_file, resample_linear, write_stereo_wav, StemMixInput};
use anyhow::{anyhow, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedTakeInfo {
    pub file_name: String,
    pub file_path: String,
    pub size_bytes: u64,
}

fn takes_dir() -> Result<PathBuf> {
    let base = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("StemScribe")
        .join("takes");
    fs::create_dir_all(&base)?;
    Ok(base)
}

pub fn sanitize_take_filename(song_name: &str, label: &str) -> String {
    let clean = |s: &str| -> String {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };
    let s = clean(song_name);
    let l = clean(label);
    let s_trimmed = if s.is_empty() { "song" } else { s.as_str() };
    let l_trimmed = if l.is_empty() { "take" } else { l.as_str() };
    format!("{s_trimmed}_{l_trimmed}.wav")
}

pub fn save_take_wav_base64(
    song_name: &str,
    label: &str,
    wav_base64: &str,
) -> Result<SavedTakeInfo> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(wav_base64)
        .context("Invalid base64 WAV payload")?;
    let file_name = sanitize_take_filename(song_name, label);
    let path = takes_dir()?.join(&file_name);
    fs::write(&path, &bytes)?;
    Ok(SavedTakeInfo {
        file_name,
        file_path: path.to_string_lossy().to_string(),
        size_bytes: bytes.len() as u64,
    })
}

pub fn list_saved_takes() -> Result<Vec<SavedTakeInfo>> {
    let dir = takes_dir()?;
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("wav") {
            continue;
        }
        let meta = entry.metadata()?;
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("take.wav")
            .to_string();
        out.push(SavedTakeInfo {
            file_name,
            file_path: path.to_string_lossy().to_string(),
            size_bytes: meta.len(),
        });
    }
    out.sort_by(|a, b| b.file_name.cmp(&a.file_name));
    Ok(out)
}

/// Shift a PCM channel forward (positive offset_samples = prepend silence)
/// or backward (negative offset_samples = trim leading latency).
pub fn apply_offset_samples(samples: &[f32], offset_samples: isize) -> Vec<f32> {
    if offset_samples == 0 || samples.is_empty() {
        return samples.to_vec();
    }
    if offset_samples > 0 {
        let pad = offset_samples as usize;
        let mut out = vec![0.0f32; pad + samples.len()];
        out[pad..].copy_from_slice(samples);
        out
    } else {
        let trim = (-offset_samples) as usize;
        if trim >= samples.len() {
            Vec::new()
        } else {
            samples[trim..].to_vec()
        }
    }
}

/// Bounce a final cover WAV by mixing active backing stems with a recorded overdub take,
/// supporting latency compensation (offset_ms), independent take gain, and -1.0 dBFS peak normalization.
pub fn mix_take_with_stems_wav(
    stems: &[StemMixInput],
    take_wav_base64: &str,
    take_gain: f32,
    take_offset_ms: i32,
    save_path: &str,
) -> Result<String> {
    let active_stems: Vec<&StemMixInput> = stems.iter().filter(|s| s.enabled).collect();
    if active_stems.is_empty() {
        return Err(anyhow!("请至少保留一条未静音的伴奏音轨再合轨导出"));
    }

    let tmp_take = save_take_wav_base64("bounce_tmp", "overdub", take_wav_base64)?;
    let decoded_take = decode_audio_file(&tmp_take.file_path)?;

    let mut target_sr = 44_100u32;
    let mut mix_l: Vec<f32> = Vec::new();
    let mut mix_r: Vec<f32> = Vec::new();

    for (idx, item) in active_stems.iter().enumerate() {
        let decoded = decode_audio_file(&item.file_path)?;
        if idx == 0 {
            target_sr = decoded.sample_rate;
        }
        let (l_raw, r_raw) = decoded.to_stereo_planar();
        let l = resample_linear(&l_raw, decoded.sample_rate, target_sr);
        let r = resample_linear(&r_raw, decoded.sample_rate, target_sr);

        let len = l.len().min(r.len());
        if mix_l.len() < len {
            mix_l.resize(len, 0.0);
            mix_r.resize(len, 0.0);
        }

        let pan = item.pan.clamp(-1.0, 1.0);
        let gain_l = item.gain.clamp(0.0, 1.5) * (1.0 - pan.max(0.0));
        let gain_r = item.gain.clamp(0.0, 1.5) * (1.0 + pan.min(0.0));

        for i in 0..len {
            mix_l[i] += l[i] * gain_l;
            mix_r[i] += r[i] * gain_r;
        }
    }

    // Resample & latency-compensate the recorded overdub take
    let (tl_raw, tr_raw) = decoded_take.to_stereo_planar();
    let tl_rs = resample_linear(&tl_raw, decoded_take.sample_rate, target_sr);
    let tr_rs = resample_linear(&tr_raw, decoded_take.sample_rate, target_sr);
    let offset_samples = ((take_offset_ms as f64 / 1000.0) * target_sr as f64).round() as isize;
    let tl = apply_offset_samples(&tl_rs, offset_samples);
    let tr = apply_offset_samples(&tr_rs, offset_samples);

    let take_len = tl.len().min(tr.len());
    if mix_l.len() < take_len {
        mix_l.resize(take_len, 0.0);
        mix_r.resize(take_len, 0.0);
    }
    let tg = take_gain.clamp(0.0, 2.0);
    for i in 0..take_len {
        mix_l[i] += tl[i] * tg;
        mix_r[i] += tr[i] * tg;
    }

    // Peak normalize to -1.0 dBFS
    let target_lin = 10.0f32.powf(-1.0 / 20.0);
    let peak = mix_l
        .iter()
        .chain(mix_r.iter())
        .fold(0.0f32, |acc, &v| acc.max(v.abs()));
    if peak > 1e-5 {
        let scale = target_lin / peak;
        for v in &mut mix_l {
            *v *= scale;
        }
        for v in &mut mix_r {
            *v *= scale;
        }
    }

    let out_path = Path::new(save_path);
    write_stereo_wav(out_path, &mix_l, &mix_r, target_sr)?;
    let _ = fs::remove_file(&tmp_take.file_path);
    Ok(out_path.to_string_lossy().to_string())
}

pub fn delete_take(file_name: &str) -> Result<Vec<SavedTakeInfo>> {
    let trimmed = file_name.trim();
    if trimmed.is_empty()
        || trimmed.contains("..")
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return Err(anyhow!("非法的录音文件名: {file_name}"));
    }
    let path = takes_dir()?.join(trimmed);
    if path.exists() && path.is_file() {
        fs::remove_file(&path)?;
    }
    list_takes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_take_filename() {
        assert_eq!(
            sanitize_take_filename("My Song (Demo).wav", "Take 1"),
            "My_Song__Demo__wav_Take_1.wav"
        );
        assert_eq!(sanitize_take_filename("", ""), "song_take.wav");
    }

    #[test]
    fn test_apply_offset_samples() {
        let src = vec![0.1, 0.2, 0.3, 0.4];
        assert_eq!(apply_offset_samples(&src, 2), vec![0.0, 0.0, 0.1, 0.2, 0.3, 0.4]);
        assert_eq!(apply_offset_samples(&src, -2), vec![0.3, 0.4]);
        assert_eq!(apply_offset_samples(&src, -10), Vec::<f32>::new());
    }

    #[test]
    fn test_delete_take_rejects_path_traversal() {
        assert!(delete_take("../secret.wav").is_err());
        assert!(delete_take("sub/take.wav").is_err());
        assert!(delete_take("").is_err());
    }
}
