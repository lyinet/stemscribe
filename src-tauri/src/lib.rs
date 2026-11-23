pub mod audio;
pub mod batch;
pub mod llm;
pub mod menu;
pub mod ml;
pub mod project;

use audio::bpm::TempoAndLoudness;
use audio::chords::ChordEvent;
use audio::drums::DrumHit;
use audio::key::KeyEstimate;
use audio::midi_in::MidiInputPortInfo;
use audio::reharmonize::ReharmonizeResult;
use audio::structure::SongStructureSegment;
use audio::takes::SavedTakeInfo;
use audio::{AudioMetadata, StemMixInput};
use batch::{BatchJobOptions, BatchJobSummary};
use llm::advisor::{AdvisorInput, AdvisorResult};
use llm::lyrics::LyricLine;
use llm::{ArrangementAnalysis, LlmRelayConfig, RefinedScoreResponse};
use ml::downloader::ModelItemInfo;
use ml::separator::StemOutput;
use ml::transcriber::{MidiNote, TranscriptionResult};
use ml::ModelStatus;
use project::leadsheet::LeadSheetInput;
use project::practice_log::PracticeRecord;
use project::setlist::Setlist;
use project::{ProjectSummary, StemScribeProject};
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
async fn inspect_audio_file(file_path: String) -> Result<AudioMetadata, String> {
    tokio::task::spawn_blocking(move || audio::inspect_audio(&file_path))
        .await
        .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn detect_bpm_local(file_path: String) -> Result<TempoAndLoudness, String> {
    tokio::task::spawn_blocking(move || audio::bpm::analyze_tempo_and_loudness(&file_path))
        .await
        .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn detect_chords_local(
    file_path: String,
    window_sec: Option<f64>,
) -> Result<Vec<ChordEvent>, String> {
    let win = window_sec.unwrap_or(1.5);
    tokio::task::spawn_blocking(move || audio::chords::detect_chords(&file_path, win))
        .await
        .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn reharmonize_chords_local(
    chords: Vec<ChordEvent>,
    style: String,
) -> Result<ReharmonizeResult, String> {
    Ok(audio::reharmonize::reharmonize_chords(&chords, &style))
}

#[tauri::command]
async fn detect_key_local(file_path: String) -> Result<KeyEstimate, String> {
    tokio::task::spawn_blocking(move || audio::key::detect_key(&file_path))
        .await
        .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn detect_song_structure_local(
    file_path: String,
) -> Result<Vec<SongStructureSegment>, String> {
    tokio::task::spawn_blocking(move || audio::structure::detect_song_structure(&file_path))
        .await
        .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn detect_drum_hits_local(drum_stem_path: String) -> Result<Vec<DrumHit>, String> {
    tokio::task::spawn_blocking(move || audio::drums::detect_drum_hits(&drum_stem_path))
        .await
        .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_audio_slice_wav(
    file_path: String,
    start_sec: f64,
    end_sec: f64,
    save_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        audio::export_audio_slice_wav(&file_path, start_sec, end_sec, &save_path)
    })
    .await
    .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn analyze_audio_quality(file_path: String) -> Result<audio::quality::QualityReport, String> {
    tokio::task::spawn_blocking(move || audio::quality::analyze_quality(&file_path))
        .await
        .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn score_audio_quality(
    file_path: String,
) -> Result<audio::quality::critic::CriticScore, String> {
    tokio::task::spawn_blocking(move || audio::quality::critic::score_audio(&file_path))
        .await
        .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn restore_audio(
    app: AppHandle,
    request: audio::restore::RestoreRequest,
) -> Result<audio::restore::RestoreResult, String> {
    tokio::task::spawn_blocking(move || {
        let app2 = app.clone();
        audio::restore::run_restore(&request, move |stage, percent| {
            let _ = app2.emit(
                "restore-progress",
                serde_json::json!({ "stage": stage, "percent": percent }),
            );
        })
    })
    .await
    .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn restore_compare(
    app: AppHandle,
    request: audio::restore::RestoreRequest,
) -> Result<audio::restore::CompareResult, String> {
    tokio::task::spawn_blocking(move || {
        let app2 = app.clone();
        audio::restore::run_restore_compare(&request, move |stage, percent| {
            let _ = app2.emit(
                "restore-progress",
                serde_json::json!({ "stage": stage, "percent": percent }),
            );
        })
    })
    .await
    .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
    .map_err(|e| e.to_string())
}

/// Infer import roles for a list of file paths (for the confirm dialog).
#[tauri::command]
fn guess_stem_roles(file_paths: Vec<String>) -> Vec<String> {
    file_paths
        .iter()
        .map(|p| audio::restore::guess_stem_role(p).to_string())
        .collect()
}

/// Import a stem set (+ optional mix): resample to 48 kHz, sum to a mix
/// (or sanity-check a provided mix), return stems with roles.
#[tauri::command]
async fn import_stems_as_mix(
    stems: Vec<audio::stem_import::ImportStemSpec>,
    mix_path: Option<String>,
) -> Result<audio::stem_import::ImportedStems, String> {
    tokio::task::spawn_blocking(move || {
        audio::stem_import::import_stems(&stems, mix_path.as_deref())
    })
    .await
    .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_restored_wav(
    render_path: String,
    save_path: String,
    bit_depth: u16,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        if bit_depth == 24 {
            std::fs::copy(&render_path, &save_path)?;
        } else {
            let d = audio::decode_audio_file(&render_path)?;
            let (l, r) = d.to_stereo_planar();
            audio::restore::write_stereo_wav_i16_tpdf(
                std::path::Path::new(&save_path),
                &l,
                &r,
                d.sample_rate,
            )?;
        }
        Ok::<String, anyhow::Error>(save_path)
    })
    .await
    .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_mixed_wav(
    inputs: Vec<StemMixInput>,
    save_path: String,
    target_peak_dbfs: Option<f32>,
    source_sample_rate: Option<u32>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        audio::export_mixed_stems_wav(&inputs, &save_path, target_peak_dbfs, source_sample_rate)
    })
    .await
    .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_recorded_take_wav(
    song_name: String,
    label: String,
    wav_base64: String,
) -> Result<SavedTakeInfo, String> {
    tokio::task::spawn_blocking(move || {
        audio::takes::save_take_wav_base64(&song_name, &label, &wav_base64)
    })
    .await
    .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn mix_take_with_stems_wav(
    stems: Vec<StemMixInput>,
    take_wav_base64: String,
    take_gain: f32,
    take_offset_ms: i32,
    save_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        audio::takes::mix_take_with_stems_wav(
            &stems,
            &take_wav_base64,
            take_gain,
            take_offset_ms,
            &save_path,
        )
    })
    .await
    .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_midi_inputs() -> Result<Vec<MidiInputPortInfo>, String> {
    audio::midi_in::list_midi_inputs().map_err(|e| e.to_string())
}

#[tauri::command]
async fn connect_midi_input(app: AppHandle, port_index: usize) -> Result<String, String> {
    audio::midi_in::connect_midi_input(app, port_index).map_err(|e| e.to_string())
}

#[tauri::command]
async fn disconnect_midi_input() -> Result<(), String> {
    audio::midi_in::disconnect_midi_input().map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_recorded_takes() -> Result<Vec<SavedTakeInfo>, String> {
    audio::takes::list_saved_takes().map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_recorded_take(file_name: String) -> Result<Vec<SavedTakeInfo>, String> {
    audio::takes::delete_take(&file_name).map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_batch_job(
    app: AppHandle,
    options: BatchJobOptions,
) -> Result<BatchJobSummary, String> {
    tokio::task::spawn_blocking(move || batch::run_batch_queue(&app, options))
        .await
        .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SystemDiagnostics {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub coreml_enabled: bool,
    pub basic_pitch_installed: bool,
    pub htdemucs_installed: bool,
    pub models_dir: String,
    pub midi_input_count: usize,
    pub saved_projects_count: usize,
    pub practice_records_count: usize,
    pub recorded_takes_count: usize,
}

#[tauri::command]
async fn get_system_diagnostics() -> Result<SystemDiagnostics, String> {
    let ms = ml::check_model_status().map_err(|e| e.to_string())?;
    let midi_input_count = audio::midi_in::list_midi_inputs()
        .map(|v| v.len())
        .unwrap_or(0);
    let saved_projects_count = project::list_projects().map(|v| v.len()).unwrap_or(0);
    let practice_records_count = project::practice_log::list_records()
        .map(|v| v.len())
        .unwrap_or(0);
    let recorded_takes_count = audio::takes::list_saved_takes().map(|v| v.len()).unwrap_or(0);
    Ok(SystemDiagnostics {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        coreml_enabled: ms.coreml_enabled,
        basic_pitch_installed: ms.basic_pitch_installed,
        htdemucs_installed: ms.demucs_installed,
        models_dir: ms.models_dir,
        midi_input_count,
        saved_projects_count,
        practice_records_count,
        recorded_takes_count,
    })
}

#[tauri::command]
async fn get_model_status() -> Result<ModelStatus, String> {
    ml::check_model_status().map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_onnx_models() -> Result<Vec<ModelItemInfo>, String> {
    ml::downloader::list_models().map_err(|e| e.to_string())
}

#[tauri::command]
async fn download_onnx_model(
    app: AppHandle,
    model_id: String,
    custom_url: String,
) -> Result<String, String> {
    ml::downloader::download_model_with_progress(&app, &model_id, &custom_url)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn import_onnx_model(model_id: String, source_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || ml::downloader::import_local_model(&model_id, &source_path))
        .await
        .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_onnx_model(model_id: String) -> Result<(), String> {
    ml::downloader::delete_model(&model_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn separate_stems(
    file_path: String,
    output_dir: Option<String>,
    quality: Option<String>,
) -> Result<Vec<StemOutput>, String> {
    let high_quality = matches!(quality.as_deref(), Some("high"));
    tokio::task::spawn_blocking(move || {
        ml::separator::run_separation(&file_path, output_dir, high_quality)
    })
        .await
        .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn transcribe_stem_to_midi(
    stem_path: String,
    stem_name: String,
) -> Result<TranscriptionResult, String> {
    tokio::task::spawn_blocking(move || ml::transcriber::run_transcription(&stem_path, &stem_name))
        .await
        .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn import_midi_file(midi_path: String) -> Result<TranscriptionResult, String> {
    tokio::task::spawn_blocking(move || ml::transcriber::read_midi_file(&midi_path))
        .await
        .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_midi_file(
    notes: Vec<MidiNote>,
    bpm: f32,
    save_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || ml::transcriber::write_midi_file(&notes, bpm, &save_path))
        .await
        .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_midi_with_chords(
    notes: Vec<MidiNote>,
    chords: Vec<ChordEvent>,
    bpm: f32,
    save_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        ml::transcriber::write_multitrack_midi_with_chords(&notes, &chords, bpm, &save_path)
    })
    .await
    .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_musicxml_file(
    title: String,
    notes: Vec<MidiNote>,
    chords: Vec<ChordEvent>,
    bpm: f32,
    save_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        ml::musicxml::write_musicxml_file(&title, &notes, &chords, bpm, &save_path)
    })
    .await
    .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn extract_lyrics_with_relay(
    audio_path: String,
    use_whisper_endpoint: bool,
    config: LlmRelayConfig,
) -> Result<Vec<LyricLine>, String> {
    llm::lyrics::extract_lyrics(&audio_path, use_whisper_endpoint, &config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn import_lrc_file(file_path: String) -> Result<Vec<LyricLine>, String> {
    llm::lyrics::read_lrc_file(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_lrc_file(
    title: String,
    lines: Vec<LyricLine>,
    save_path: String,
) -> Result<String, String> {
    llm::lyrics::write_lrc_file(&title, &lines, &save_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_srt_file(
    lines: Vec<LyricLine>,
    save_path: String,
) -> Result<String, String> {
    llm::lyrics::write_srt_file(&lines, &save_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_project_file(project: StemScribeProject) -> Result<String, String> {
    project::save_project(&project).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_project_file(project_id: String) -> Result<StemScribeProject, String> {
    project::load_project(&project_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_saved_projects() -> Result<Vec<ProjectSummary>, String> {
    project::list_projects().map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_project_file(project_id: String) -> Result<Vec<ProjectSummary>, String> {
    project::delete_project(&project_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_project_file(project_id: String, new_name: String) -> Result<Vec<ProjectSummary>, String> {
    project::rename_project(&project_id, &new_name).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_practice_record(record: PracticeRecord) -> Result<Vec<PracticeRecord>, String> {
    project::practice_log::save_record(record).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_practice_records() -> Result<Vec<PracticeRecord>, String> {
    project::practice_log::list_records().map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_practice_record(record_id: String) -> Result<Vec<PracticeRecord>, String> {
    project::practice_log::delete_record(&record_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_practice_records_csv(save_path: String) -> Result<String, String> {
    project::practice_log::export_records_csv(&save_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_setlist(setlist: Setlist) -> Result<Vec<Setlist>, String> {
    project::setlist::save_setlist(setlist).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_setlists() -> Result<Vec<Setlist>, String> {
    project::setlist::list_setlists().map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_setlist(setlist_id: String) -> Result<Vec<Setlist>, String> {
    project::setlist::delete_setlist(&setlist_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_leadsheet_html(
    input: LeadSheetInput,
    save_path: String,
) -> Result<String, String> {
    project::leadsheet::export_leadsheet_html(&input, &save_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_practice_bundle(
    project: StemScribeProject,
    key_label: Option<String>,
    target_dir: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        project::export_practice_bundle(&project, key_label.as_deref(), &target_dir)
    })
    .await
    .map_err(|e| format!("后台任务异常终止（已写入崩溃日志）: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn test_llm_relay_connection(config: LlmRelayConfig) -> Result<String, String> {
    llm::test_relay_connection(&config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn advise_restoration(
    config: LlmRelayConfig,
    input: AdvisorInput,
) -> Result<AdvisorResult, String> {
    llm::advisor::advise_restoration(&config, &input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn analyze_arrangement_with_llm(
    audio_path: String,
    bpm: Option<f32>,
    slice_start_sec: Option<f64>,
    slice_end_sec: Option<f64>,
    config: LlmRelayConfig,
) -> Result<ArrangementAnalysis, String> {
    llm::analyze_arrangement(&audio_path, bpm, slice_start_sec, slice_end_sec, &config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn refine_midi_with_llm(
    audio_path: String,
    notes: Vec<MidiNote>,
    instrument: String,
    user_prompt: Option<String>,
    slice_start_sec: Option<f64>,
    slice_end_sec: Option<f64>,
    config: LlmRelayConfig,
) -> Result<RefinedScoreResponse, String> {
    llm::refine_midi_score(
        &audio_path,
        &notes,
        &instrument,
        user_prompt.as_deref(),
        slice_start_sec,
        slice_end_sec,
        &config,
    )
    .await
    .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(log_dir) =
            dirs::home_dir().map(|h| h.join("Library").join("Logs").join("StemScribe"))
        {
            if std::fs::create_dir_all(&log_dir).is_ok() {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let thread = std::thread::current();
                let thread_name = thread.name().unwrap_or("<unnamed>");
                let payload = info
                    .payload()
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| info.payload().downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "<unknown>".to_string());
                let location = info
                    .location()
                    .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                    .unwrap_or_else(|| "<unknown>".to_string());
                let backtrace = std::backtrace::Backtrace::force_capture();
                let entry = format!(
                    "=== StemScribe {} panic @ {ts} ===\nthread: {thread_name}\nmessage: {payload}\nlocation: {location}\nbacktrace:\n{backtrace}\n\n",
                    env!("CARGO_PKG_VERSION")
                );
                use std::io::Write;
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(log_dir.join("crash.log"))
                {
                    let _ = f.write_all(entry.as_bytes());
                }
            }
        }
        default_hook(info);
    }));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            menu::setup_macos_menu(app)?;
            // Resolve the bundled drum kit (packaged resource dir, with a
            // dev fallback handled by kit_dir()).
            if let Ok(rd) = app.path().resource_dir() {
                let kit = rd.join("resources/drums");
                if kit.join("kit.json").exists() {
                    audio::drum_hits::set_kit_dir(kit);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            inspect_audio_file,
            detect_bpm_local,
            detect_chords_local,
            reharmonize_chords_local,
            detect_key_local,
            detect_song_structure_local,
            detect_drum_hits_local,
            export_audio_slice_wav,
            export_mixed_wav,
            analyze_audio_quality,
            score_audio_quality,
            restore_audio,
            restore_compare,
            guess_stem_roles,
            import_stems_as_mix,
            export_restored_wav,
            save_recorded_take_wav,
            mix_take_with_stems_wav,
            list_midi_inputs,
            connect_midi_input,
            disconnect_midi_input,
            list_recorded_takes,
            delete_recorded_take,
            run_batch_job,
            get_system_diagnostics,
            get_model_status,
            list_onnx_models,
            download_onnx_model,
            import_onnx_model,
            delete_onnx_model,
            separate_stems,
            transcribe_stem_to_midi,
            import_midi_file,
            export_midi_file,
            export_midi_with_chords,
            export_musicxml_file,
            extract_lyrics_with_relay,
            import_lrc_file,
            export_lrc_file,
            export_srt_file,
            save_project_file,
            load_project_file,
            list_saved_projects,
            delete_project_file,
            rename_project_file,
            save_practice_record,
            list_practice_records,
            delete_practice_record,
            export_practice_records_csv,
            save_setlist,
            list_setlists,
            delete_setlist,
            export_leadsheet_html,
            export_practice_bundle,
            test_llm_relay_connection,
            analyze_arrangement_with_llm,
            refine_midi_with_llm,
            advise_restoration
        ])
        .run(tauri::generate_context!())
        .expect("error while running StemScribe");
}
