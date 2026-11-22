use crate::audio::decode_audio_file;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SongStructureSegment {
    pub id: String,
    pub label: String,
    pub kind: String, // "intro" | "verse" | "chorus" | "bridge" | "outro"
    pub start_sec: f64,
    pub end_sec: f64,
    pub energy: f32,
}

/// Detect song structure segments (Intro / Verse / Chorus / Bridge / Outro)
/// using RMS energy contour and half-wave rectified spectral-flux novelty.
pub fn detect_song_structure(file_path: &str) -> Result<Vec<SongStructureSegment>> {
    let decoded = decode_audio_file(file_path)?;
    let mono = decoded.to_mono();
    let duration = decoded.duration_sec();
    Ok(segment_from_mono(&mono, decoded.sample_rate, duration))
}

pub fn segment_from_mono(
    mono: &[f32],
    sample_rate: u32,
    duration_sec: f64,
) -> Vec<SongStructureSegment> {
    if mono.is_empty() || sample_rate == 0 || duration_sec <= 1.0 {
        return Vec::new();
    }

    let hop_sec = 0.5f64;
    let hop = ((sample_rate as f64) * hop_sec).round().max(1.0) as usize;
    let num_frames = (mono.len() / hop).max(1);

    let mut energies = Vec::with_capacity(num_frames);
    let mut zcr = Vec::with_capacity(num_frames);

    for f in 0..num_frames {
        let start = f * hop;
        let end = ((f + 1) * hop).min(mono.len());
        let slice = &mono[start..end];
        let mut sum_sq = 0.0f64;
        let mut crossings = 0usize;
        for i in 0..slice.len() {
            let v = slice[i] as f64;
            sum_sq += v * v;
            if i > 0 && ((slice[i] >= 0.0) != (slice[i - 1] >= 0.0)) {
                crossings += 1;
            }
        }
        let rms = (sum_sq / slice.len().max(1) as f64).sqrt() as f32;
        energies.push(rms);
        zcr.push(crossings as f32 / slice.len().max(1) as f32);
    }

    let max_e = energies.iter().copied().fold(0.0f32, f32::max).max(1e-6);
    for e in &mut energies {
        *e /= max_e;
    }

    // Compute novelty curve comparing 4-frame (~2s) lookback vs lookahead mean energy & ZCR
    let win = 4usize;
    let mut novelty = vec![0.0f32; num_frames];
    for i in win..num_frames.saturating_sub(win) {
        let left_e: f32 = energies[i - win..i].iter().sum::<f32>() / win as f32;
        let right_e: f32 = energies[i..i + win].iter().sum::<f32>() / win as f32;
        let left_z: f32 = zcr[i - win..i].iter().sum::<f32>() / win as f32;
        let right_z: f32 = zcr[i..i + win].iter().sum::<f32>() / win as f32;
        novelty[i] = (right_e - left_e).abs() * 0.8 + (right_z - left_z).abs() * 0.2;
    }

    let min_gap_frames = if duration_sec >= 48.0 {
        16 // >= 8 seconds per section
    } else if duration_sec >= 20.0 {
        10 // >= 5 seconds
    } else {
        6 // >= 3 seconds for short clips
    };

    let mut boundaries: Vec<usize> = vec![0];
    let mut candidates: Vec<(usize, f32)> = novelty
        .iter()
        .enumerate()
        .filter(|&(i, &v)| i >= min_gap_frames && i + min_gap_frames < num_frames && v > 0.08)
        .map(|(i, &v)| (i, v))
        .collect();
    candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let max_sections = if duration_sec >= 90.0 {
        7
    } else if duration_sec >= 30.0 {
        5
    } else {
        4
    };

    for (idx, _score) in candidates {
        if boundaries.len() >= max_sections {
            break;
        }
        if boundaries
            .iter()
            .all(|&b| idx.abs_diff(b) >= min_gap_frames)
        {
            boundaries.push(idx);
        }
    }

    // Fallback to musical phrasing if audio is very uniform
    if boundaries.len() < 3 && num_frames >= 12 {
        boundaries = vec![0, num_frames / 4, num_frames / 2, (num_frames * 3) / 4];
    }
    boundaries.sort_unstable();
    boundaries.push(num_frames);

    // Compute average energy per segment
    let mut seg_energies = Vec::new();
    for w in boundaries.windows(2) {
        let s = w[0];
        let e = w[1].max(s + 1).min(num_frames);
        let avg = energies[s..e].iter().sum::<f32>() / (e - s).max(1) as f32;
        seg_energies.push(avg);
    }

    let mean_energy = seg_energies.iter().sum::<f32>() / seg_energies.len().max(1) as f32;
    let total_segs = seg_energies.len();

    let mut out = Vec::with_capacity(total_segs);
    let mut verse_count = 0usize;
    let mut chorus_count = 0usize;

    for (i, w) in boundaries.windows(2).enumerate() {
        let start_sec = (w[0] as f64) * hop_sec;
        let end_sec = ((w[1] as f64) * hop_sec).min(duration_sec);
        let energy = seg_energies[i].clamp(0.0, 1.0);

        let (kind, label) = if i == 0 && total_segs >= 3 && energy <= mean_energy * 1.05 {
            ("intro".to_string(), "前奏 Intro".to_string())
        } else if i + 1 == total_segs && total_segs >= 3 && energy <= mean_energy * 1.08 {
            ("outro".to_string(), "尾奏 Outro".to_string())
        } else if energy >= mean_energy * 1.06 {
            chorus_count += 1;
            let suffix = if chorus_count > 1 {
                format!(" {chorus_count}")
            } else {
                String::new()
            };
            ("chorus".to_string(), format!("副歌 Chorus{suffix}"))
        } else if i + 2 == total_segs && total_segs >= 5 {
            ("bridge".to_string(), "桥段 Bridge".to_string())
        } else {
            verse_count += 1;
            let suffix = if verse_count > 1 {
                format!(" {verse_count}")
            } else {
                String::new()
            };
            ("verse".to_string(), format!("主歌 Verse{suffix}"))
        };

        out.push(SongStructureSegment {
            id: format!("sec_{i}"),
            label,
            kind,
            start_sec: (start_sec * 100.0).round() / 100.0,
            end_sec: (end_sec * 100.0).round() / 100.0,
            energy: (energy * 100.0).round() / 100.0,
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_structure_segmentation_detects_energy_contrast() {
        let sr = 8000u32;
        let mut mono = Vec::new();
        // 6s quiet intro (0.15), 6s medium verse (0.4), 6s loud chorus (0.95), 6s quiet outro (0.2)
        for &(amp, secs) in &[(0.15f32, 6), (0.4f32, 6), (0.95f32, 6), (0.2f32, 6)] {
            for i in 0..(sr as usize * secs) {
                let t = i as f32 / sr as f32;
                mono.push((2.0 * std::f32::consts::PI * 220.0 * t).sin() * amp);
            }
        }
        let segs = segment_from_mono(&mono, sr, 24.0);
        assert!(segs.len() >= 3, "Expected at least 3 segments, got {}", segs.len());
        assert!(
            segs.iter().any(|s| s.kind == "chorus"),
            "Expected a chorus segment in high-energy region"
        );
    }
}
