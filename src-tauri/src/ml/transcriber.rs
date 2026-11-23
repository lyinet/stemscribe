use crate::audio::chords::ChordEvent;
use crate::audio::{decode_audio_file, resample::resample_hq};
use crate::ml::{basic_pitch_model_path, build_coreml_session, build_cpu_session};
use anyhow::{anyhow, Result};
use midly::num::{u15, u24, u28, u4, u7};
use midly::{Format, Header, MetaMessage, MidiMessage, Smf, Timing, Track, TrackEvent, TrackEventKind};
use ndarray::Array3;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use std::path::Path;

const BASIC_PITCH_SR: u32 = 22_050;
const WINDOW_SAMPLES: usize = 43_844;
const OVERLAP_SAMPLES: usize = 7_680;
const OVERLAP_FRAMES: usize = 30;
const HOP_SAMPLES: usize = WINDOW_SAMPLES - OVERLAP_SAMPLES;
const NUM_PITCHES: usize = 88;
const MIDI_OFFSET: u8 = 21;
const FRAMES_PER_SECOND: f64 = 22_050.0 / 256.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MidiNote {
    pub pitch: u8,
    pub start_sec: f64,
    pub end_sec: f64,
    pub velocity: u8,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionResult {
    pub stem_name: String,
    pub estimated_bpm: f32,
    pub notes: Vec<MidiNote>,
}

pub fn run_transcription(stem_path: &str, stem_name: &str) -> Result<TranscriptionResult> {
    let model_path = basic_pitch_model_path()?;
    if !model_path.exists() {
        return Err(anyhow!(
            "未检测到转谱模型 basic_pitch.onnx。请先在模型管理器中下载或运行 scripts/export_models_onnx.py"
        ));
    }

    let decoded = decode_audio_file(stem_path)?;
    let mono = resample_hq(&decoded.to_mono(), decoded.sample_rate, BASIC_PITCH_SR);
    if mono.is_empty() {
        return Err(anyhow!("音轨为空，无法转谱"));
    }
    let mut session = build_coreml_session(&model_path).or_else(|_| build_cpu_session(&model_path))?;
    let mut on_cpu = false;

    // Same windowing as the reference implementation: pad half an overlap at
    // the start, run fixed windows, then drop half an overlap of frames from
    // each side so neighbouring windows do not produce duplicate notes.
    let half_pad = OVERLAP_SAMPLES / 2;
    let mut padded = vec![0.0f32; half_pad];
    padded.extend_from_slice(&mono);
    let trim = OVERLAP_FRAMES / 2;
    let expected_frames = ((mono.len() as f64) * FRAMES_PER_SECOND / BASIC_PITCH_SR as f64).ceil() as usize;

    let mut note_post: Vec<f32> = Vec::with_capacity(expected_frames * NUM_PITCHES);
    let mut onset_post: Vec<f32> = Vec::with_capacity(expected_frames * NUM_PITCHES);
    let mut offset = 0usize;

    while offset < padded.len() {
        let valid_len = (padded.len() - offset).min(WINDOW_SAMPLES);
        let mut input = Array3::<f32>::zeros((1, WINDOW_SAMPLES, 1));
        for i in 0..valid_len {
            input[[0, i, 0]] = padded[offset + i];
        }

        let run_window = |session: &mut ort::session::Session| -> Result<(usize, Vec<f32>, Vec<f32>)> {
            let outputs = session.run(ort::inputs![Tensor::from_array(input.clone())?])?;
            let pick = |names: &[&str]| -> Result<(usize, Vec<f32>)> {
                for name in names {
                    if let Some(value) = outputs.get(*name) {
                        let (shape, data) = value.try_extract_tensor::<f32>()?;
                        if shape.len() == 3 && shape[2] as usize == NUM_PITCHES {
                            return Ok((shape[1] as usize, data.to_vec()));
                        }
                    }
                }
                Err(anyhow!("转谱模型输出与 Basic Pitch 不一致（缺少 {}），请重新下载官方 nmp.onnx", names[0]))
            };
            let (frames, note) = pick(&["StatefulPartitionedCall:1", "note"])?;
            let (_, onset) = pick(&["StatefulPartitionedCall:2", "onset"])?;
            Ok((frames, note, onset))
        };
        let (frames, note, onset) = match run_window(&mut session) {
            Ok(r) => r,
            Err(_) if !on_cpu => {
                session = build_cpu_session(&model_path)?;
                on_cpu = true;
                run_window(&mut session)?
            }
            Err(e) => return Err(e),
        };

        let start = trim;
        let end = frames.saturating_sub(trim).max(start);
        note_post.extend_from_slice(&note[start * NUM_PITCHES..end * NUM_PITCHES]);
        onset_post.extend_from_slice(&onset[start * NUM_PITCHES..end * NUM_PITCHES]);

        if offset + WINDOW_SAMPLES >= padded.len() {
            break;
        }
        offset += HOP_SAMPLES;
    }

    let total_frames = (note_post.len() / NUM_PITCHES).min(expected_frames.max(1));
    note_post.truncate(total_frames * NUM_PITCHES);
    onset_post.truncate(total_frames * NUM_PITCHES);
    let mut all_notes = decode_notes_from_posterior(&note_post, &onset_post, total_frames, 0.0, 0.50, 0.30, 0.06);

    all_notes.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));
    let estimated_bpm = estimate_bpm_from_onsets(&all_notes);

    Ok(TranscriptionResult {
        stem_name: stem_name.to_string(),
        estimated_bpm,
        notes: all_notes,
    })
}

fn decode_notes_from_posterior(
    note_probs: &[f32],
    onset_probs: &[f32],
    num_frames: usize,
    time_offset_sec: f64,
    onset_thresh: f32,
    frame_thresh: f32,
    min_note_len_sec: f64,
) -> Vec<MidiNote> {
    let mut notes = Vec::new();
    for pitch_idx in 0..NUM_PITCHES {
        let mut active_start: Option<usize> = None;
        let mut peak_prob: f32 = 0.0;

        for t in 0..num_frames {
            let idx = t * NUM_PITCHES + pitch_idx;
            let n_p = note_probs.get(idx).copied().unwrap_or(0.0);
            let o_p = onset_probs.get(idx).copied().unwrap_or(0.0);

            if active_start.is_none() && (o_p >= onset_thresh || n_p >= onset_thresh + 0.12) {
                active_start = Some(t);
                peak_prob = n_p.max(o_p);
            } else if let Some(start_f) = active_start {
                peak_prob = peak_prob.max(n_p);
                let is_re_onset = t > start_f + 2 && o_p >= onset_thresh + 0.15;
                if n_p < frame_thresh || is_re_onset || t == num_frames - 1 {
                    let start_sec = time_offset_sec + (start_f as f64 / FRAMES_PER_SECOND);
                    let end_sec = time_offset_sec + (t as f64 / FRAMES_PER_SECOND);
                    if end_sec - start_sec >= min_note_len_sec {
                        notes.push(MidiNote {
                            pitch: MIDI_OFFSET + pitch_idx as u8,
                            start_sec,
                            end_sec,
                            velocity: ((peak_prob.clamp(0.25, 1.0)) * 118.0) as u8,
                            confidence: peak_prob,
                        });
                    }
                    active_start = if is_re_onset { Some(t) } else { None };
                    peak_prob = if is_re_onset { o_p } else { 0.0 };
                }
            }
        }
    }
    notes
}

fn estimate_bpm_from_onsets(notes: &[MidiNote]) -> f32 {
    if notes.len() < 4 {
        return 120.0;
    }
    let mut intervals = Vec::new();
    for w in notes.windows(2) {
        let dt = w[1].start_sec - w[0].start_sec;
        if (0.20..=1.20).contains(&dt) {
            intervals.push(dt);
        }
    }
    if intervals.is_empty() {
        return 120.0;
    }
    intervals.sort_by(|a, b| a.total_cmp(b));
    let median_dt = intervals[intervals.len() / 2];
    let mut bpm = (60.0 / median_dt) as f32;
    while bpm < 70.0 {
        bpm *= 2.0;
    }
    while bpm > 170.0 {
        bpm /= 2.0;
    }
    (bpm * 2.0).round() / 2.0
}

fn build_track_from_notes<'a>(
    notes: &[MidiNote],
    ticks_per_sec: f64,
    channel: u8,
    include_tempo_us: Option<u32>,
) -> Track<'a> {
    let mut raw_events: Vec<(u32, MidiMessage)> = Vec::with_capacity(notes.len() * 2);
    for n in notes {
        let on_tick = (n.start_sec.max(0.0) * ticks_per_sec).round() as u32;
        let off_tick = (n.end_sec.max(n.start_sec + 0.05) * ticks_per_sec).round() as u32;
        let key = u7::new(n.pitch.min(127));
        let vel = u7::new(n.velocity.clamp(1, 127));
        raw_events.push((on_tick, MidiMessage::NoteOn { key, vel }));
        raw_events.push((
            off_tick,
            MidiMessage::NoteOff {
                key,
                vel: u7::new(0),
            },
        ));
    }
    raw_events.sort_by_key(|(tick, _)| *tick);

    let mut track: Track = Vec::with_capacity(raw_events.len() + 2);
    if let Some(us) = include_tempo_us {
        track.push(TrackEvent {
            delta: u28::new(0),
            kind: TrackEventKind::Meta(MetaMessage::Tempo(u24::new(us))),
        });
    }

    let mut last_tick = 0u32;
    let ch = u4::new(channel.min(15));
    for (tick, msg) in raw_events {
        let delta = tick.saturating_sub(last_tick);
        last_tick = tick;
        track.push(TrackEvent {
            delta: u28::new(delta),
            kind: TrackEventKind::Midi {
                channel: ch,
                message: msg,
            },
        });
    }

    track.push(TrackEvent {
        delta: u28::new(0),
        kind: TrackEventKind::Meta(MetaMessage::EndOfTrack),
    });
    track
}

pub fn write_midi_file(notes: &[MidiNote], bpm: f32, save_path: &str) -> Result<String> {
    let ppq: u16 = 480;
    let bpm_clamped = bpm.clamp(40.0, 240.0);
    let micros_per_beat = (60_000_000.0 / bpm_clamped) as u32;
    let ticks_per_sec = (ppq as f64) * (bpm_clamped as f64) / 60.0;

    let track = build_track_from_notes(notes, ticks_per_sec, 0, Some(micros_per_beat));
    let smf = Smf {
        header: Header {
            format: Format::SingleTrack,
            timing: Timing::Metrical(u15::new(ppq)),
        },
        tracks: vec![track],
    };

    let path = Path::new(save_path);
    smf.save(path)?;
    Ok(path.to_string_lossy().to_string())
}

/// Export a 2-track Type-1 `.mid` file:
/// - Track 1 (Ch 1): Transcribed melody/solo notes
/// - Track 2 (Ch 2): Block chord accompaniment generated from detected/edited ChordEvents
pub fn write_multitrack_midi_with_chords(
    notes: &[MidiNote],
    chords: &[ChordEvent],
    bpm: f32,
    save_path: &str,
) -> Result<String> {
    let ppq: u16 = 480;
    let bpm_clamped = bpm.clamp(40.0, 240.0);
    let micros_per_beat = (60_000_000.0 / bpm_clamped) as u32;
    let ticks_per_sec = (ppq as f64) * (bpm_clamped as f64) / 60.0;

    let melody_track = build_track_from_notes(notes, ticks_per_sec, 0, Some(micros_per_beat));

    let mut chord_notes: Vec<MidiNote> = Vec::new();
    for ch in chords {
        for pitch in chord_symbol_to_midi_voicing(&ch.symbol) {
            chord_notes.push(MidiNote {
                pitch,
                start_sec: ch.start_sec,
                end_sec: (ch.end_sec - 0.04).max(ch.start_sec + 0.2),
                velocity: 74,
                confidence: ch.confidence,
            });
        }
    }
    let chord_track = build_track_from_notes(&chord_notes, ticks_per_sec, 1, None);

    let smf = Smf {
        header: Header {
            format: Format::Parallel,
            timing: Timing::Metrical(u15::new(ppq)),
        },
        tracks: vec![melody_track, chord_track],
    };

    let path = Path::new(save_path);
    smf.save(path)?;
    Ok(path.to_string_lossy().to_string())
}

pub fn chord_symbol_to_midi_voicing(symbol: &str) -> Vec<u8> {
    let trimmed = symbol.trim();
    if trimmed.is_empty() || trimmed == "N" {
        return vec![];
    }
    let bytes = trimmed.as_bytes();
    let mut root: i8 = match bytes[0] as char {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        _ => return vec![],
    };
    let mut rest = &trimmed[1..];
    if rest.starts_with('#') {
        root = (root + 1) % 12;
        rest = &rest[1..];
    } else if rest.starts_with('b') {
        root = (root + 11) % 12;
        rest = &rest[1..];
    }

    let base = 48u8 + root as u8; // C3..B3 voicing
    let intervals: &[u8] = if rest.starts_with("maj7") {
        &[0, 4, 7, 11]
    } else if rest.starts_with("m7") {
        &[0, 3, 7, 10]
    } else if rest.starts_with('m') {
        &[0, 3, 7]
    } else if rest.starts_with('7') {
        &[0, 4, 7, 10]
    } else {
        &[0, 4, 7]
    };

    intervals.iter().map(|&iv| base + iv).collect()
}


/// Import an existing `.mid` file (Type-0 or Type-1) into StemScribe notes + BPM
/// so users can immediately practice in Synthesia Falling Notes, Piano/Fretboard, or Pitch Coach.
pub fn read_midi_file(midi_path: &str) -> Result<TranscriptionResult> {
    let bytes = std::fs::read(midi_path)?;
    let smf = Smf::parse(&bytes).map_err(|e| anyhow!("MIDI 解析失败: {e}"))?;

    let ppq = match smf.header.timing {
        Timing::Metrical(t) => t.as_int().max(1) as f64,
        Timing::Timecode(fps, sub) => (fps.as_f32() as f64 * sub as f64).max(1.0),
    };

    let mut micros_per_beat: f64 = 500_000.0; // default 120 BPM
    for track in &smf.tracks {
        for ev in track {
            if let TrackEventKind::Meta(MetaMessage::Tempo(t)) = ev.kind {
                micros_per_beat = (t.as_int() as f64).max(100_000.0);
                break;
            }
        }
    }
    let bpm = (60_000_000.0 / micros_per_beat).clamp(40.0, 240.0) as f32;
    let sec_per_tick = (micros_per_beat / 1_000_000.0) / ppq;

    let mut notes: Vec<MidiNote> = Vec::new();
    for track in &smf.tracks {
        let mut abs_tick: u64 = 0;
        let mut active: std::collections::HashMap<u8, (f64, u8)> = std::collections::HashMap::new();
        for ev in track {
            abs_tick += ev.delta.as_int() as u64;
            let t_sec = abs_tick as f64 * sec_per_tick;
            if let TrackEventKind::Midi { message, .. } = ev.kind {
                match message {
                    MidiMessage::NoteOn { key, vel } if vel.as_int() > 0 => {
                        let k = key.as_int();
                        active.insert(k, (t_sec, vel.as_int()));
                    }
                    MidiMessage::NoteOff { key, .. } | MidiMessage::NoteOn { key, .. } => {
                        let k = key.as_int();
                        if let Some((start_sec, velocity)) = active.remove(&k) {
                            let end_sec = t_sec.max(start_sec + 0.06);
                            notes.push(MidiNote {
                                pitch: k,
                                start_sec,
                                end_sec,
                                velocity,
                                confidence: 1.0,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    notes.sort_by(|a, b| {
        a.start_sec
            .partial_cmp(&b.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.pitch.cmp(&b.pitch))
    });

    let stem_name = Path::new(midi_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported MIDI")
        .to_string();

    Ok(TranscriptionResult {
        stem_name,
        estimated_bpm: (bpm * 10.0).round() / 10.0,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chord_voicing() {
        assert_eq!(chord_symbol_to_midi_voicing("C"), vec![48, 52, 55]);
        assert_eq!(chord_symbol_to_midi_voicing("Am7"), vec![57, 60, 64, 67]);
        assert_eq!(chord_symbol_to_midi_voicing("Cmaj7"), vec![48, 52, 55, 59]);
    }

    #[test]
    fn test_midi_write_and_read_roundtrip() {
        let tmp = std::env::temp_dir().join("stemscribe_roundtrip_test.mid");
        let input = vec![
            MidiNote { pitch: 60, start_sec: 0.0, end_sec: 0.5, velocity: 96, confidence: 1.0 },
            MidiNote { pitch: 64, start_sec: 0.5, end_sec: 1.0, velocity: 90, confidence: 1.0 },
        ];
        write_midi_file(&input, 120.0, &tmp.to_string_lossy()).unwrap();
        let parsed = read_midi_file(&tmp.to_string_lossy()).unwrap();
        let _ = std::fs::remove_file(&tmp);
        assert_eq!(parsed.notes.len(), 2);
        assert_eq!(parsed.notes[0].pitch, 60);
        assert_eq!(parsed.notes[1].pitch, 64);
        assert!((parsed.estimated_bpm - 120.0).abs() < 1.0);
    }
}
