use crate::audio::decode_audio_file;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::f32::consts::PI;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChordEvent {
    pub start_sec: f64,
    pub end_sec: f64,
    pub symbol: String,
    pub confidence: f32,
}

const PITCH_CLASSES: [&str; 12] = [
    "C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B",
];

pub fn detect_chords(file_path: &str, window_sec: f64) -> Result<Vec<ChordEvent>> {
    let decoded = decode_audio_file(file_path)?;
    let mono = decoded.to_mono();
    let sr = decoded.sample_rate.max(1) as f32;
    let win_len = ((window_sec.max(0.5) * sr as f64) as usize).max(2048);

    let mut raw_events: Vec<ChordEvent> = Vec::new();
    let mut offset = 0usize;

    while offset + 1024 < mono.len() {
        let end = (offset + win_len).min(mono.len());
        let frame = &mono[offset..end];
        let chroma = compute_chroma_goertzel(frame, sr);
        let (symbol, conf) = match_chord_template(&chroma);

        let start_sec = offset as f64 / sr as f64;
        let end_sec = end as f64 / sr as f64;

        if let Some(last) = raw_events.last_mut() {
            if last.symbol == symbol {
                last.end_sec = end_sec;
                last.confidence = (last.confidence + conf) * 0.5;
            } else {
                raw_events.push(ChordEvent {
                    start_sec,
                    end_sec,
                    symbol,
                    confidence: conf,
                });
            }
        } else {
            raw_events.push(ChordEvent {
                start_sec,
                end_sec,
                symbol,
                confidence: conf,
            });
        }

        offset += win_len;
    }

    Ok(raw_events)
}

fn goertzel_energy(samples: &[f32], sr: f32, target_hz: f32) -> f32 {
    if samples.is_empty() || target_hz <= 0.0 || target_hz >= sr * 0.48 {
        return 0.0;
    }
    let omega = 2.0 * PI * target_hz / sr;
    let coeff = 2.0 * omega.cos();
    let mut s_prev = 0.0f32;
    let mut s_prev2 = 0.0f32;

    for &x in samples.iter().step_by(2) {
        let s = x + coeff * s_prev - s_prev2;
        s_prev2 = s_prev;
        s_prev = s;
    }
    let power = s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2;
    power.max(0.0).sqrt()
}

pub(crate) fn compute_chroma_goertzel(samples: &[f32], sr: f32) -> [f32; 12] {
    let mut chroma = [0.0f32; 12];
    for midi in 36..=83 {
        let freq = 440.0 * 2.0f32.powf((midi as f32 - 69.0) / 12.0);
        let energy = goertzel_energy(samples, sr, freq);
        chroma[(midi % 12) as usize] += energy;
    }
    let norm = chroma.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-6);
    for c in &mut chroma {
        *c /= norm;
    }
    chroma
}

fn match_chord_template(chroma: &[f32; 12]) -> (String, f32) {
    let mut best_symbol = "N".to_string();
    let mut best_score = 0.0f32;

    let templates: [(&str, &[usize]); 3] = [
        ("", &[0, 4, 7]),
        ("m", &[0, 3, 7]),
        ("7", &[0, 4, 7, 10]),
    ];

    for root in 0..12 {
        for (suffix, intervals) in templates {
            let mut sum = 0.0f32;
            for &iv in intervals {
                sum += chroma[(root + iv) % 12];
            }
            let score = sum / (intervals.len() as f32).sqrt();
            if score > best_score {
                best_score = score;
                best_symbol = format!("{}{}", PITCH_CLASSES[root], suffix);
            }
        }
    }

    (best_symbol, best_score.clamp(0.0, 1.0))
}
