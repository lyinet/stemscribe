use crate::audio::chords::detect_chords;
use crate::ml::separator::run_separation;
use crate::ml::transcriber::{run_transcription, write_midi_file};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchJobOptions {
    pub file_paths: Vec<String>,
    pub output_root: String,
    pub export_midi_for_vocals: bool,
    pub export_chords_json: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchProgressEvent {
    pub index: usize,
    pub total: usize,
    pub file_name: String,
    pub stage: String,
    pub status: String, // "running" | "done" | "error"
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchJobSummary {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub output_root: String,
}

/// Process a batch queue of audio files sequentially on Apple Silicon CoreML,
/// emitting live `batch-job-progress` events to the macOS UI.
pub fn run_batch_queue(app: &AppHandle, opts: BatchJobOptions) -> Result<BatchJobSummary> {
    let root = PathBuf::from(&opts.output_root);
    std::fs::create_dir_all(&root)?;

    let total = opts.file_paths.len();
    let mut succeeded = 0usize;
    let mut failed = 0usize;

    for (index, file_path) in opts.file_paths.iter().enumerate() {
        let file_name = Path::new(file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("track")
            .to_string();
        let song_dir = root.join(&file_name);
        let _ = std::fs::create_dir_all(&song_dir);

        let emit = |stage: &str, status: &str, message: &str| {
            let _ = app.emit(
                "batch-job-progress",
                BatchProgressEvent {
                    index,
                    total,
                    file_name: file_name.clone(),
                    stage: stage.to_string(),
                    status: status.to_string(),
                    message: message.to_string(),
                },
            );
        };

        emit("separate", "running", "正在执行 CoreML 4 轨分离...");
        match run_separation(file_path, Some(song_dir.to_string_lossy().to_string()), false) {
            Ok(stems) => {
                if opts.export_midi_for_vocals {
                    if let Some(vocal) = stems.iter().find(|s| s.name == "vocals") {
                        emit("transcribe", "running", "正在转录人声轨为 MIDI...");
                        if let Ok(tr) = run_transcription(&vocal.file_path, "vocals") {
                            let mid_path = song_dir.join(format!("{file_name}_vocals.mid"));
                            let _ = write_midi_file(
                                &tr.notes,
                                tr.estimated_bpm,
                                &mid_path.to_string_lossy(),
                            );
                        }
                    }
                }
                if opts.export_chords_json {
                    emit("chords", "running", "正在分析全曲和弦...");
                    if let Ok(chords) = detect_chords(file_path, 2.0) {
                        let json_path = song_dir.join(format!("{file_name}_chords.json"));
                        if let Ok(text) = serde_json::to_string_pretty(&chords) {
                            let _ = std::fs::write(json_path, text);
                        }
                    }
                }
                succeeded += 1;
                emit("complete", "done", "分轨与导出完成");
            }
            Err(err) => {
                failed += 1;
                emit("error", "error", &err.to_string());
            }
        }
    }

    Ok(BatchJobSummary {
        total,
        succeeded,
        failed,
        output_root: opts.output_root,
    })
}
