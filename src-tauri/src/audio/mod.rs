pub mod bpm;
pub mod chords;
pub mod drums;
pub mod key;
pub mod midi_in;
pub mod reharmonize;
pub mod structure;
pub mod takes;

use anyhow::{anyhow, Context, Result};
use hound::{SampleFormat, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;
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

pub fn decode_audio_file(path: &str) -> Result<DecodedAudio> {
    let file = File::open(path).with_context(|| format!("Failed to open audio file: {path}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| anyhow!("Unsupported audio container: {e}"))?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| anyhow!("No default audio track found"))?;

    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| anyhow!("Missing sample rate metadata"))?;
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(2);
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| anyhow!("Failed to initialize decoder: {e}"))?;

    let mut samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(_)) => break,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(e) => return Err(anyhow!("Audio packet read error: {e}")),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                let mut sample_buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                sample_buf.copy_interleaved_ref(decoded);
                samples.extend_from_slice(sample_buf.samples());
            }
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(anyhow!("Audio decode error: {e}")),
        }
    }

    Ok(DecodedAudio {
        sample_rate,
        channels,
        samples,
    })
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
    let decoded = decode_audio_file(path)?;
    let mono = decoded.to_mono();
    let peaks = extract_waveform_peaks(&mono, 480);
    let file_name = Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("audio")
        .to_string();

    Ok(AudioMetadata {
        file_path: path.to_string(),
        file_name,
        sample_rate: decoded.sample_rate,
        channels: decoded.channels,
        duration_sec: decoded.duration_sec(),
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
) -> Result<String> {
    let active: Vec<&StemMixInput> = inputs.iter().filter(|s| s.enabled).collect();
    if active.is_empty() {
        return Err(anyhow!("请至少保留一条未静音的音轨再导出混音 WAV"));
    }

    let mut target_sr = 44_100u32;
    let mut mix_l: Vec<f32> = Vec::new();
    let mut mix_r: Vec<f32> = Vec::new();

    for (idx, item) in active.iter().enumerate() {
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
    write_stereo_wav(path, &mix_l, &mix_r, target_sr)?;
    Ok(path.to_string_lossy().to_string())
}

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
