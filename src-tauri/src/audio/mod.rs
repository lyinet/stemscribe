pub mod bpm;
pub mod chords;
pub mod drum_hits;
pub mod drums;
pub mod dsp;
pub mod key;
pub mod midi_in;
pub mod quality;
pub mod reharmonize;
pub mod resample;
pub mod refmatch;
pub mod restore;
pub mod structure;
pub mod takes;

use anyhow::{anyhow, Context, Result};
use hound::{SampleFormat, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioMetadata {
    pub file_path: String,
    pub file_name: String,
    pub sample_rate: u32,
    pub channels: usize,
    pub duration_sec: f64,
    pub waveform_peaks: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StemMixInput {
    pub file_path: String,
    pub gain: f32,
    pub pan: f32,
    pub enabled: bool,
}

pub struct DecodedAudio {
    pub sample_rate: u32,
    pub channels: usize,
    pub samples: Vec<f32>,
}

impl DecodedAudio {
    pub fn duration_sec(&self) -> f64 {
        if self.sample_rate == 0 || self.channels == 0 {
            return 0.0;
        }
        (self.samples.len() / self.channels) as f64 / self.sample_rate as f64
    }

    pub fn to_mono(&self) -> Vec<f32> {
        if self.channels == 1 {
            return self.samples.clone();
        }
        let frames = self.samples.len() / self.channels;
        let mut mono = Vec::with_capacity(frames);
        for i in 0..frames {
            let mut sum = 0.0f32;
            for c in 0..self.channels {
                sum += self.samples[i * self.channels + c];
            }
            mono.push(sum / self.channels as f32);
        }
        mono
    }

    pub fn to_stereo_planar(&self) -> (Vec<f32>, Vec<f32>) {
        let frames = self.samples.len() / self.channels.max(1);
        let mut left = Vec::with_capacity(frames);
        let mut right = Vec::with_capacity(frames);
        if self.channels == 1 {
            left.extend_from_slice(&self.samples);
            right.extend_from_slice(&self.samples);
        } else {
            for i in 0..frames {
                left.push(self.samples[i * self.channels]);
                right.push(self.samples[i * self.channels + 1]);
            }
        }
        (left, right)
    }
}

/// Streams every decoded block (interleaved f32) to `on_block`, using the
/// channel count and sample rate reported by the decoder itself rather than
/// container metadata, which is wrong for some AAC/HE-AAC files.
fn decode_stream(path: &str, mut on_block: impl FnMut(&[f32], usize, u32)) -> Result<(u32, usize)> {
    let file = File::open(path).with_context(|| format!("无法打开音频文件: {path}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default())
        .map_err(|e| anyhow!("不支持的音频格式（{e}）"))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("文件中没有可解码的音轨"))?;
    let track_id = track.id;
    let mut sample_rate = track.codec_params.sample_rate.unwrap_or(0);
    let mut channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(0);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| anyhow!("无法初始化解码器（{e}）"))?;

    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut got_audio = false;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(_)) => break,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            // Trailing junk / truncated files: keep what was decoded so far.
            Err(_) if got_audio => break,
            Err(e) => return Err(anyhow!("读取音频数据失败（{e}）")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                if spec.channels.count() == 0 || decoded.frames() == 0 {
                    continue;
                }
                sample_rate = spec.rate;
                channels = spec.channels.count();
                let needs_new = sample_buf
                    .as_ref()
                    .map(|b| b.capacity() < decoded.capacity() * channels)
                    .unwrap_or(true);
                if needs_new {
                    sample_buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
                }
                let buf = sample_buf.as_mut().expect("sample buffer initialised above");
                buf.copy_interleaved_ref(decoded);
                on_block(buf.samples(), channels, sample_rate);
                got_audio = true;
            }
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(_) if got_audio => break,
            Err(e) => return Err(anyhow!("音频解码失败（{e}）")),
        }
    }

    if !got_audio || sample_rate == 0 || channels == 0 {
        return Err(anyhow!("没有解码出任何音频数据，文件可能已损坏或不包含音轨"));
    }
    Ok((sample_rate, channels))
}

pub fn decode_audio_file(path: &str) -> Result<DecodedAudio> {
    let mut samples: Vec<f32> = Vec::new();
    let (sample_rate, channels) = decode_stream(path, |block, _, _| samples.extend_from_slice(block))?;
    Ok(DecodedAudio { sample_rate, channels, samples })
}

/// Mono, down-sampled audio shared by every analysis step of one file.
pub struct AnalysisAudio {
    pub mono: Vec<f32>,
    pub sample_rate: u32,
    pub source_sample_rate: u32,
    pub source_channels: usize,
}

impl AnalysisAudio {
    pub fn duration_sec(&self) -> f64 {
        self.mono.len() as f64 / self.sample_rate.max(1) as f64
    }
}

pub const ANALYSIS_SAMPLE_RATE: u32 = 22_050;
/// Longest audio accepted for import (2 hours).
pub const MAX_IMPORT_SEC: f64 = 2.0 * 3600.0;

type AnalysisCacheEntry = (String, u64, Option<std::time::SystemTime>, Arc<AnalysisAudio>);

fn analysis_cache() -> &'static Mutex<Vec<AnalysisCacheEntry>> {
    static CACHE: OnceLock<Mutex<Vec<AnalysisCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// Decodes `path` once into mono audio at [`ANALYSIS_SAMPLE_RATE`] and caches
/// it, so the parallel import analyses (waveform, tempo, key, structure,
/// chords) share one decode instead of each holding a full-rate copy.
pub fn load_analysis_audio(path: &str) -> Result<Arc<AnalysisAudio>> {
    let meta = std::fs::metadata(path).with_context(|| format!("找不到音频文件: {path}"))?;
    let (len, mtime) = (meta.len(), meta.modified().ok());

    // Holding the lock while decoding makes concurrent callers wait and then
    // reuse the result rather than decoding the same file in parallel.
    let mut cache = analysis_cache().lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, _, _, audio)) = cache.iter().find(|(p, l, m, _)| p == path && *l == len && *m == mtime) {
        return Ok(audio.clone());
    }

    let mut mono: Vec<f32> = Vec::new();
    let mut acc = 0.0f32;
    let mut acc_n = 0u32;
    let mut phase = 0.0f64;
    let mut step = 1.0f64;
    let mut too_long = false;
    let max_frames_hint = (MAX_IMPORT_SEC * ANALYSIS_SAMPLE_RATE as f64) as usize;

    let (source_sample_rate, source_channels) = decode_stream(path, |block, ch, sr| {
        if too_long {
            return;
        }
        step = (ANALYSIS_SAMPLE_RATE.min(sr) as f64) / sr as f64;
        let inv = 1.0 / ch as f32;
        for frame in block.chunks_exact(ch) {
            acc += frame.iter().sum::<f32>() * inv;
            acc_n += 1;
            phase += step;
            if phase >= 1.0 {
                phase -= 1.0;
                mono.push(acc / acc_n as f32);
                acc = 0.0;
                acc_n = 0;
            }
        }
        if mono.len() > max_frames_hint {
            too_long = true;
        }
    })?;
    if too_long {
        return Err(anyhow!("音频超过 {} 分钟，暂不支持导入这么长的文件", (MAX_IMPORT_SEC / 60.0) as u32));
    }

    let audio = Arc::new(AnalysisAudio {
        mono,
        sample_rate: ANALYSIS_SAMPLE_RATE.min(source_sample_rate),
        source_sample_rate,
        source_channels,
    });
    cache.retain(|(p, ..)| p != path);
    cache.insert(0, (path.to_string(), len, mtime, audio.clone()));
    cache.truncate(3);
    Ok(audio)
}

pub fn extract_waveform_peaks(mono: &[f32], num_bins: usize) -> Vec<f32> {
    if mono.is_empty() || num_bins == 0 {
        return vec![0.0; num_bins];
    }
    let bin_size = (mono.len() / num_bins).max(1);
    let mut peaks = Vec::with_capacity(num_bins);
    for i in 0..num_bins {
        let start = i * bin_size;
        let end = ((i + 1) * bin_size).min(mono.len());
        if start >= mono.len() {
            peaks.push(0.0);
            continue;
        }
        let max_amp = mono[start..end]
            .iter()
            .fold(0.0f32, |acc, &x| acc.max(x.abs()));
        peaks.push(max_amp.min(1.0));
    }
    peaks
}

pub fn inspect_audio(path: &str) -> Result<AudioMetadata> {
    let audio = load_analysis_audio(path)?;
    let peaks = extract_waveform_peaks(&audio.mono, 480);
    let file_name = Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("audio")
        .to_string();

    Ok(AudioMetadata {
        file_path: path.to_string(),
        file_name,
        sample_rate: audio.source_sample_rate,
        channels: audio.source_channels,
        duration_sec: audio.duration_sec(),
        waveform_peaks: peaks,
    })
}

pub fn write_stereo_wav(
    path: &Path,
    left: &[f32],
    right: &[f32],
    sample_rate: u32,
) -> Result<()> {
    let spec = WavSpec {
        channels: 2,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec)?;
    let len = left.len().min(right.len());
    for i in 0..len {
        let l = (left[i].clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        let r = (right[i].clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer.write_sample(l)?;
        writer.write_sample(r)?;
    }
    writer.finalize()?;
    Ok(())
}

/// 32-bit float WAV (keeps full headroom for post-processing / stems).
pub fn write_stereo_wav_f32(
    path: &Path,
    left: &[f32],
    right: &[f32],
    sample_rate: u32,
) -> Result<()> {
    let spec = WavSpec {
        channels: 2,
        sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };
    let mut writer = WavWriter::create(path, spec)?;
    let len = left.len().min(right.len());
    for i in 0..len {
        writer.write_sample(left[i])?;
        writer.write_sample(right[i])?;
    }
    writer.finalize()?;
    Ok(())
}

/// 24-bit PCM WAV (delivery/export quality).
pub fn write_stereo_wav_i24(
    path: &Path,
    left: &[f32],
    right: &[f32],
    sample_rate: u32,
) -> Result<()> {
    let spec = WavSpec {
        channels: 2,
        sample_rate,
        bits_per_sample: 24,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec)?;
    let len = left.len().min(right.len());
    let scale = (1i64 << 23) as f32;
    for i in 0..len {
        let l = (left[i].clamp(-1.0, 1.0) * scale) as i32;
        let r = (right[i].clamp(-1.0, 1.0) * scale) as i32;
        writer.write_sample(l)?;
        writer.write_sample(r)?;
    }
    writer.finalize()?;
    Ok(())
}

pub fn export_audio_slice_wav(
    file_path: &str,
    start_sec: f64,
    end_sec: f64,
    save_path: &str,
) -> Result<String> {
    if end_sec <= start_sec + 0.05 {
        return Err(anyhow!("A-B 切片区间无效，请确保 B 点大于 A 点"));
    }
    let decoded = decode_audio_file(file_path)?;
    let (l_all, r_all) = decoded.to_stereo_planar();
    let sr = decoded.sample_rate.max(1) as f64;
    let total = l_all.len().min(r_all.len());

    let start_idx = ((start_sec.max(0.0) * sr) as usize).min(total);
    let end_idx = ((end_sec.max(start_sec) * sr) as usize).min(total);
    if end_idx <= start_idx {
        return Err(anyhow!("所选 A-B 区间超出音频总时长"));
    }

    let mut l = l_all[start_idx..end_idx].to_vec();
    let mut r = r_all[start_idx..end_idx].to_vec();
    let fade_len = ((sr * 0.015) as usize).min(l.len() / 4);
    for i in 0..fade_len {
        let w = (i + 1) as f32 / fade_len as f32;
        l[i] *= w;
        r[i] *= w;
        let tail = l.len() - 1 - i;
        l[tail] *= w;
        r[tail] *= w;
    }

    let path = Path::new(save_path);
    write_stereo_wav(path, &l, &r, decoded.sample_rate)?;
    Ok(path.to_string_lossy().to_string())
}

pub fn export_mixed_stems_wav(
    inputs: &[StemMixInput],
    save_path: &str,
    target_peak_dbfs: Option<f32>,
    source_sample_rate: Option<u32>,
) -> Result<String> {
    let active: Vec<&StemMixInput> = inputs.iter().filter(|s| s.enabled).collect();
    if active.is_empty() {
        return Err(anyhow!("请至少保留一条未静音的音轨再导出混音 WAV"));
    }

    // Output rate = the source song rate when the caller passes it; otherwise
    // fall back to the first stem's rate.
    let mut target_sr = source_sample_rate.unwrap_or(44_100);
    let mut mix_l: Vec<f32> = Vec::new();
    let mut mix_r: Vec<f32> = Vec::new();

    for (idx, item) in active.iter().enumerate() {
        let decoded = decode_audio_file(&item.file_path)?;
        if idx == 0 && source_sample_rate.is_none() {
            target_sr = decoded.sample_rate;
        }
        let (l_raw, r_raw) = decoded.to_stereo_planar();
        let (l, r) = resample::resample_hq_stereo(&l_raw, &r_raw, decoded.sample_rate, target_sr);

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

    let target_db = target_peak_dbfs.unwrap_or(-1.0).clamp(-12.0, -0.1);
    let target_lin = 10.0f32.powf(target_db / 20.0);
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

    let path = Path::new(save_path);
    write_stereo_wav_i24(path, &mix_l, &mix_r, target_sr)?;
    Ok(path.to_string_lossy().to_string())
}
