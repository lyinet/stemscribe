use crate::audio::chords::compute_chroma_goertzel;
use crate::audio::load_analysis_audio;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyEstimate {
    pub tonic: String,
    pub mode: String, // "major" | "minor"
    pub label: String,
    pub confidence: f32,
    /// Pitch classes (0=C .. 11=B) belonging to the detected scale for Piano Roll highlighting
    pub scale_pitch_classes: Vec<u8>,
}

const NOTE_NAMES: [&str; 12] = [
    "C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B",
];

/// Krumhansl-Schmuckler major & minor tonal key profiles
const MAJOR_PROFILE: [f32; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE: [f32; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

const MAJOR_INTERVALS: [u8; 7] = [0, 2, 4, 5, 7, 9, 11];
const MINOR_INTERVALS: [u8; 7] = [0, 2, 3, 5, 7, 8, 10];

/// Estimate overall musical key & scale on-device in Rust using Krumhansl-Schmuckler correlation.
pub fn detect_key(file_path: &str) -> Result<KeyEstimate> {
    let audio = load_analysis_audio(file_path)?;
    let mono = &audio.mono;
    let sr = audio.sample_rate.max(1) as f32;

    // Sample up to the first 60 seconds in 2-second chunks for fast key estimation
    let max_samples = ((sr * 60.0) as usize).min(mono.len());
    let win = ((sr * 2.0) as usize).max(4096);
    let mut global_chroma = [0.0f32; 12];

    let mut offset = 0usize;
    while offset + 1024 < max_samples {
        let end = (offset + win).min(max_samples);
        let c = compute_chroma_goertzel(&mono[offset..end], sr);
        for i in 0..12 {
            global_chroma[i] += c[i];
        }
        offset += win;
    }

    Ok(estimate_key_from_chroma(&global_chroma))
}

pub fn estimate_key_from_chroma(chroma: &[f32; 12]) -> KeyEstimate {
    let mut best_root = 0usize;
    let mut best_is_major = true;
    let mut best_corr = -2.0f32;

    for root in 0..12 {
        let mut rotated = [0.0f32; 12];
        for i in 0..12 {
            rotated[i] = chroma[(root + i) % 12];
        }
        let c_maj = pearson_corr(&rotated, &MAJOR_PROFILE);
        if c_maj > best_corr {
            best_corr = c_maj;
            best_root = root;
            best_is_major = true;
        }
        let c_min = pearson_corr(&rotated, &MINOR_PROFILE);
        if c_min > best_corr {
            best_corr = c_min;
            best_root = root;
            best_is_major = false;
        }
    }

    let tonic = NOTE_NAMES[best_root].to_string();
    let mode = if best_is_major { "major" } else { "minor" }.to_string();
    let label = format!("{tonic} {}", if best_is_major { "大调 (Major)" } else { "小调 (Minor)" });
    let intervals = if best_is_major { &MAJOR_INTERVALS } else { &MINOR_INTERVALS };
    let scale_pitch_classes = intervals
        .iter()
        .map(|&iv| ((best_root as u8) + iv) % 12)
        .collect();

    KeyEstimate {
        tonic,
        mode,
        label,
        confidence: ((best_corr + 1.0) * 0.5).clamp(0.0, 1.0),
        scale_pitch_classes,
    }
}

fn pearson_corr(a: &[f32; 12], b: &[f32; 12]) -> f32 {
    let mean_a = a.iter().sum::<f32>() / 12.0;
    let mean_b = b.iter().sum::<f32>() / 12.0;
    let mut num = 0.0f32;
    let mut da = 0.0f32;
    let mut db = 0.0f32;
    for i in 0..12 {
        let xa = a[i] - mean_a;
        let xb = b[i] - mean_b;
        num += xa * xb;
        da += xa * xa;
        db += xb * xb;
    }
    let denom = (da * db).sqrt();
    if denom < 1e-6 {
        0.0
    } else {
        num / denom
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_c_major_detection() {
        let chroma = [1.0, 0.0, 0.5, 0.0, 0.8, 0.6, 0.0, 0.9, 0.0, 0.5, 0.0, 0.4];
        let est = estimate_key_from_chroma(&chroma);
        assert_eq!(est.tonic, "C");
        assert_eq!(est.mode, "major");
        assert!(est.scale_pitch_classes.contains(&0));
        assert!(est.scale_pitch_classes.contains(&4));
        assert!(est.scale_pitch_classes.contains(&7));
    }
}
