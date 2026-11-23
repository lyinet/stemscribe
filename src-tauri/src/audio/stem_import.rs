//! Import official/Suno-style multi-stem sets: decode + resample stems to a
//! common rate, sum them into a mix (or sanity-check a provided mix), write
//! the 32-bit float mix next to the project data.

use super::resample::resample_hq_stereo;
use super::{decode_audio_file, extract_waveform_peaks};
use crate::audio::restore::guess_stem_role;
use crate::ml::separator::StemOutput;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Common sample rate all imported stems (and the summed mix) are resampled to.
pub const IMPORT_SR: u32 = 48_000;

#[derive(Debug, Clone, Deserialize)]
pub struct ImportStemSpec {
    pub file_path: String,
    /// Optional explicit role; empty = infer from the file name.
    #[serde(default)]
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportedStems {
    /// Path to the mix the caller should use as source_path.
    pub mix_path: String,
    /// True when the mix was synthesized as Σstems by us (float WAV).
    pub mix_is_synth: bool,
    pub stems: Vec<StemOutput>,
    pub notes: Vec<String>,
    pub duration_sec: f64,
    pub sample_rate: u32,
}

fn imports_dir() -> Result<PathBuf> {
    let base = dirs::data_dir().ok_or_else(|| anyhow!("无法定位应用数据目录"))?;
    Ok(base.join("StemScribe").join("imports"))
}

fn rms(v: &[f32]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    (v.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() / v.len() as f64).sqrt()
}

/// Decode + resample each stem to [`IMPORT_SR`]; when `mix_path` is given,
/// sanity-check it against Σstems (mismatch > 10% → fall back to the sum);
/// otherwise write Σstems as a 32-bit float WAV under the imports dir.
pub fn import_stems(specs: &[ImportStemSpec], mix_path: Option<&str>) -> Result<ImportedStems> {
    if specs.is_empty() {
        return Err(anyhow!("未选择任何分轨文件"));
    }
    let mut notes: Vec<String> = Vec::new();
    let mut stems_pcm: Vec<(Vec<f32>, Vec<f32>)> = Vec::new();
    let mut stems_out: Vec<StemOutput> = Vec::new();
    let mut min_len = usize::MAX;
    for spec in specs {
        let d = decode_audio_file(&spec.file_path)
            .map_err(|e| anyhow!("读取分轨 {} 失败: {e}", spec.file_path))?;
        let sr_in = d.sample_rate;
        let (sl, sr_) = d.to_stereo_planar();
        drop(d);
        let (l, r) = resample_hq_stereo(&sl, &sr_, sr_in, IMPORT_SR);
        min_len = min_len.min(l.len()).min(r.len());
        let mono: Vec<f32> = l.iter().zip(&r).map(|(a, b)| (a + b) * 0.5).collect();
        let peaks = extract_waveform_peaks(&mono, 320);
        let name = Path::new(&spec.file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("stem")
            .to_string();
        let role = if spec.role.is_empty() {
            match guess_stem_role(&spec.file_path) {
                "mix" => "other".to_string(),
                r => r.to_string(),
            }
        } else {
            spec.role.clone()
        };
        stems_out.push(StemOutput {
            name,
            label_zh: super::restore::role_label_zh(&role).to_string(),
            file_path: spec.file_path.clone(),
            waveform_peaks: peaks,
            duration_sec: l.len() as f64 / IMPORT_SR as f64,
            role: Some(role),
        });
        stems_pcm.push((l, r));
    }
    let n = if min_len == usize::MAX { 0 } else { min_len };
    if n == 0 {
        return Err(anyhow!("分轨文件为空或无法解码"));
    }
    // Σstems at the common rate, trimmed to the shortest stem.
    let mut sum_l = vec![0.0f32; n];
    let mut sum_r = vec![0.0f32; n];
    for (l, r) in &stems_pcm {
        for i in 0..n {
            sum_l[i] += l[i];
            sum_r[i] += r[i];
        }
    }

    let mut mix_is_synth = false;
    let mix_path_out = match mix_path {
        Some(mp) if !mp.is_empty() => {
            // Provided mix: if it disagrees with Σstems (>10% residual RMS),
            // trust the stems instead.
            let d = decode_audio_file(mp).map_err(|e| anyhow!("读取混音文件失败: {e}"))?;
            let sr_in = d.sample_rate;
            let (xl, xr) = d.to_stereo_planar();
            drop(d);
            let (xl, xr) = resample_hq_stereo(&xl, &xr, sr_in, IMPORT_SR);
            let m = n.min(xl.len()).min(xr.len());
            let num = (rms(&xl[..m]) + rms(&xr[..m])).hypot(0.0).max(1e-12);
            let diff_l: Vec<f32> = (0..m).map(|i| xl[i] - sum_l[i]).collect();
            let diff_r: Vec<f32> = (0..m).map(|i| xr[i] - sum_r[i]).collect();
            let residual = (rms(&diff_l) + rms(&diff_r)).hypot(0.0) / num;
            if residual > 0.10 {
                notes.push("分轨相加与混音不一致，已改用分轨之和作为原曲".to_string());
                mix_is_synth = true;
                write_sum(&sum_l, &sum_r)?
            } else {
                mp.to_string()
            }
        }
        _ => {
            mix_is_synth = true;
            write_sum(&sum_l, &sum_r)?
        }
    };
    drop(stems_pcm);
    Ok(ImportedStems {
        mix_path: mix_path_out,
        mix_is_synth,
        stems: stems_out,
        notes,
        duration_sec: n as f64 / IMPORT_SR as f64,
        sample_rate: IMPORT_SR,
    })
}

fn write_sum(sum_l: &[f32], sum_r: &[f32]) -> Result<String> {
    let dir = imports_dir()?;
    std::fs::create_dir_all(&dir)?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let p = dir.join(format!("stem_mix_{ts}.wav"));
    super::write_stereo_wav_f32(&p, sum_l, sum_r, IMPORT_SR)?;
    Ok(p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guess_role_table() {
        // >= 20 filenames incl. Chinese; expected engine roles.
        let cases: &[(&str, &str)] = &[
            ("song (Vocals).wav", "lead"),
            ("song VOCALS.WAV", "lead"),
            ("主唱干声.wav", "lead"),
            ("01 - vox.flac", "lead"),
            ("人声.wav", "lead"),
            ("song (Backing Vocals).wav", "backing"),
            ("BGV_take2.wav", "backing"),
            ("chorus_vocal.wav", "backing"),
            ("和声.wav", "backing"),
            ("song (Drums).wav", "drums"),
            ("DRUM_STEM.mp3", "drums"),
            ("鼓组.wav", "drums"),
            ("percussion.wav", "perc"),
            ("perc_01.wav", "perc"),
            ("打击乐.wav", "perc"),
            ("song (Bass).wav", "bass"),
            ("BASS.WAV", "bass"),
            ("贝斯.wav", "bass"),
            ("song (Guitar).wav", "other"),
            ("keys.wav", "other"),
            ("piano stem.wav", "other"),
            ("Synth.wav", "other"),
            ("strings.wav", "other"),
            ("brass section.wav", "other"),
            ("fx.wav", "other"),
            ("instrumental.wav", "other"),
            ("song (Synth).wav", "other"),
            ("混音.wav", "mix"),
            ("song_master.wav", "mix"),
            ("full mix.wav", "mix"),
            ("song_mix.wav", "mix"),
            ("untitled.wav", "mix"),
            ("东北的东.wav", "mix"),
        ];
        for (name, want) in cases {
            assert_eq!(guess_stem_role(name), *want, "file: {name}");
        }
    }
}
