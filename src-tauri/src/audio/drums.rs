use crate::audio::load_analysis_audio;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DrumKind {
    Kick,
    Snare,
    Hihat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrumHit {
    pub time_sec: f64,
    pub kind: DrumKind,
    pub midi_note: u8,
    pub velocity: u8,
}

/// On-device Rust 3-band onset detector for separated drum stems:
/// - Low-pass (< ~180Hz): Kick (GM MIDI 36)
/// - Band-pass (180Hz - 2.5kHz): Snare (GM MIDI 38)
/// - High-pass (> ~4.5kHz): Closed Hi-Hat (GM MIDI 42)
pub fn detect_drum_hits(drum_stem_path: &str) -> Result<Vec<DrumHit>> {
    let audio = load_analysis_audio(drum_stem_path)?;
    let mono = &audio.mono;
    let sr = audio.sample_rate.max(1) as f32;

    let hop = ((sr * 0.02) as usize).max(256); // 20ms frame hop
    let mut lp_state = 0.0f32;
    let mut hp_prev_x = 0.0f32;
    let mut hp_prev_y = 0.0f32;

    let lp_alpha = (2.0 * std::f32::consts::PI * 180.0 / sr).clamp(0.01, 0.5);
    let hp_alpha = 1.0 / (1.0 + 2.0 * std::f32::consts::PI * 4500.0 / sr);

    let mut low_env = Vec::new();
    let mut mid_env = Vec::new();
    let mut high_env = Vec::new();

    for chunk in mono.chunks(hop) {
        let mut e_low = 0.0f32;
        let mut e_mid = 0.0f32;
        let mut e_high = 0.0f32;
        for &x in chunk {
            lp_state += lp_alpha * (x - lp_state);
            let hp = hp_alpha * (hp_prev_y + x - hp_prev_x);
            hp_prev_x = x;
            hp_prev_y = hp;
            let mid = x - lp_state - hp;

            e_low += lp_state * lp_state;
            e_mid += mid * mid;
            e_high += hp * hp;
        }
        let n = chunk.len().max(1) as f32;
        low_env.push((e_low / n).sqrt());
        mid_env.push((e_mid / n).sqrt());
        high_env.push((e_high / n).sqrt());
    }

    let mut hits = Vec::new();
    let hop_sec = hop as f64 / sr as f64;
    pick_peaks(&low_env, hop_sec, DrumKind::Kick, 36, 0.08, 1.55, &mut hits);
    pick_peaks(&mid_env, hop_sec, DrumKind::Snare, 38, 0.08, 1.65, &mut hits);
    pick_peaks(&high_env, hop_sec, DrumKind::Hihat, 42, 0.06, 1.50, &mut hits);

    hits.sort_by(|a, b| a.time_sec.total_cmp(&b.time_sec));
    Ok(hits)
}

fn pick_peaks(
    env: &[f32],
    hop_sec: f64,
    kind: DrumKind,
    midi_note: u8,
    min_gap_sec: f64,
    ratio_thresh: f32,
    out: &mut Vec<DrumHit>,
) {
    if env.len() < 4 {
        return;
    }
    let avg: f32 = env.iter().sum::<f32>() / env.len() as f32;
    let floor = (avg * ratio_thresh).max(0.015);
    let mut last_hit = -1.0f64;

    for i in 1..(env.len() - 1) {
        let v = env[i];
        if v > floor && v >= env[i - 1] && v > env[i + 1] {
            let t = i as f64 * hop_sec;
            if t - last_hit >= min_gap_sec {
                last_hit = t;
                let vel = ((v / (floor * 2.5)).clamp(0.35, 1.0) * 120.0) as u8;
                out.push(DrumHit {
                    time_sec: t,
                    kind: kind.clone(),
                    midi_note,
                    velocity: vel,
                });
            }
        }
    }
}
