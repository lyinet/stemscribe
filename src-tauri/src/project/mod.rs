pub mod leadsheet;
pub mod practice_log;
pub mod setlist;

use crate::audio::chords::ChordEvent;
use crate::audio::AudioMetadata;
use crate::llm::lyrics::{write_lrc_file, write_srt_file, LyricLine};
use crate::llm::ArrangementAnalysis;
use crate::ml::musicxml::write_musicxml_file;
use crate::ml::separator::StemOutput;
use crate::ml::transcriber::{write_midi_file, write_multitrack_midi_with_chords, MidiNote};
use crate::project::leadsheet::{export_leadsheet_html, LeadSheetInput};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fmt::Write as FmtWrite;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionMarker {
    pub id: String,
    pub time_sec: f64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StemScribeProject {
    pub id: String,
    pub name: String,
    pub updated_at: String,
    pub audio_meta: AudioMetadata,
    pub stems: Vec<StemOutput>,
    pub chords: Vec<ChordEvent>,
    #[serde(default)]
    pub lyrics: Vec<LyricLine>,
    #[serde(default)]
    pub markers: Vec<SectionMarker>,
    pub active_stem_name: String,
    pub bpm: f32,
    pub transpose_semitones: i32,
    pub loop_a: f64,
    pub loop_b: f64,
    pub notes: Vec<MidiNote>,
    pub analysis: Option<ArrangementAnalysis>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub updated_at: String,
    pub file_path: String,
    pub note_count: usize,
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn projects_dir() -> Result<PathBuf> {
    let base = dirs::data_dir().context("Cannot locate macOS Application Support directory")?;
    let dir = base.join("StemScribe").join("projects");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn save_project(project: &StemScribeProject) -> Result<String> {
    let dir = projects_dir()?;
    let safe_id = sanitize_id(&project.id);
    let path = dir.join(format!("{safe_id}.stemscribe.json"));
    let json = serde_json::to_string_pretty(project)?;
    std::fs::write(&path, json)?;
    Ok(path.to_string_lossy().to_string())
}

pub fn load_project(project_id: &str) -> Result<StemScribeProject> {
    let safe_id = sanitize_id(project_id);
    let path = projects_dir()?.join(format!("{safe_id}.stemscribe.json"));
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("Cannot read project file: {}", path.display()))?;
    let parsed: StemScribeProject = serde_json::from_str(&raw)?;
    Ok(parsed)
}

pub fn delete_project(project_id: &str) -> Result<Vec<ProjectSummary>> {
    let safe_id = sanitize_id(project_id);
    let path = projects_dir()?.join(format!("{safe_id}.stemscribe.json"));
    if path.exists() {
        std::fs::remove_file(&path)
            .with_context(|| format!("Cannot delete project file: {}", path.display()))?;
    }
    list_projects()
}

pub fn rename_project(project_id: &str, new_name: &str) -> Result<Vec<ProjectSummary>> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("工程名称不能为空"));
    }
    let mut proj = load_project(project_id)?;
    proj.name = trimmed.to_string();
    save_project(&proj)?;
    list_projects()
}

pub fn list_projects() -> Result<Vec<ProjectSummary>> {
    let dir = projects_dir()?;
    let mut items = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(proj) = serde_json::from_str::<StemScribeProject>(&raw) {
                items.push(ProjectSummary {
                    id: proj.id,
                    name: proj.name,
                    updated_at: proj.updated_at,
                    file_path: path.to_string_lossy().to_string(),
                    note_count: proj.notes.len(),
                });
            }
        }
    }
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(items)
}

/// Export a complete practice & transcription bundle folder containing:
/// - Single-track & 2-track (melody + chords) MIDI
/// - MusicXML 4.0 score
/// - LRC lyrics & SRT video subtitles
/// - Printable A4 Lead Sheet HTML
/// - Markdown arrangement & chords report
pub fn export_practice_bundle(
    project: &StemScribeProject,
    key_label: Option<&str>,
    target_dir: &str,
) -> Result<String> {
    let safe_name = sanitize_id(&project.name);
    let folder_prefix = if safe_name.trim_matches('_').is_empty() {
        "StemScribe_Song".to_string()
    } else {
        safe_name
    };
    let bundle_dir = PathBuf::from(target_dir).join(format!("{folder_prefix}_StemScribe_Bundle"));
    std::fs::create_dir_all(&bundle_dir)?;

    if !project.notes.is_empty() {
        let mid_path = bundle_dir.join("transcribed.mid");
        write_midi_file(&project.notes, project.bpm, &mid_path.to_string_lossy())?;

        if !project.chords.is_empty() {
            let dual_mid_path = bundle_dir.join("arrangement_2track.mid");
            write_multitrack_midi_with_chords(
                &project.notes,
                &project.chords,
                project.bpm,
                &dual_mid_path.to_string_lossy(),
            )?;
        }

        let xml_path = bundle_dir.join("score.musicxml");
        write_musicxml_file(
            &project.name,
            &project.notes,
            &project.chords,
            project.bpm,
            &xml_path.to_string_lossy(),
        )?;
    }

    if !project.lyrics.is_empty() {
        let lrc_path = bundle_dir.join("lyrics.lrc");
        write_lrc_file(&project.name, &project.lyrics, &lrc_path.to_string_lossy())?;

        let srt_path = bundle_dir.join("subtitles.srt");
        write_srt_file(&project.lyrics, &srt_path.to_string_lossy())?;
    }

    if !project.chords.is_empty() || !project.lyrics.is_empty() {
        let html_path = bundle_dir.join("leadsheet_A4.html");
        let input = LeadSheetInput {
            title: project.name.clone(),
            key_label: key_label.unwrap_or("未检测").to_string(),
            bpm: project.bpm,
            capo_fret: 0,
            chords: project.chords.clone(),
            lyrics: project.lyrics.clone(),
            structure: Vec::new(),
        };
        export_leadsheet_html(&input, &html_path.to_string_lossy())?;
    }

    let mut md = String::new();
    writeln!(md, "# {} — 扒带练琴报告\n", project.name)?;
    writeln!(md, "- **估算速度**：{:.1} BPM", project.bpm)?;
    writeln!(md, "- **检测调性**：{}", key_label.unwrap_or("未检测"))?;
    writeln!(md, "- **当前移调**：{} 半音", project.transpose_semitones)?;
    writeln!(md, "- **转录音符数**：{}\n", project.notes.len())?;

    if !project.markers.is_empty() {
        writeln!(md, "## 段落书签")?;
        for m in &project.markers {
            writeln!(md, "- **{:.1}s** — {}", m.time_sec, m.label)?;
        }
        writeln!(md)?;
    }

    if !project.chords.is_empty() {
        writeln!(md, "## 和弦走向")?;
        for c in &project.chords {
            writeln!(md, "- `{:.1}s - {:.1}s`: **{}**", c.start_sec, c.end_sec, c.symbol)?;
        }
        writeln!(md)?;
    }

    if let Some(an) = &project.analysis {
        writeln!(md, "## 多模态大模型编曲拆解\n")?;
        writeln!(md, "{}\n", an.raw_markdown)?;
    }

    std::fs::write(bundle_dir.join("arrangement_report.md"), md)?;
    Ok(bundle_dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_project_bundle_generates_all_files() {
        let tmp = std::env::temp_dir().join("stemscribe_bundle_test_v097");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let proj = StemScribeProject {
            id: "test_proj".to_string(),
            name: "Starlight".to_string(),
            updated_at: "2026-11-20".to_string(),
            audio_meta: AudioMetadata {
                file_path: "demo.wav".to_string(),
                file_name: "demo.wav".to_string(),
                sample_rate: 44100,
                channels: 2,
                duration_sec: 16.0,
                waveform_peaks: vec![0.5; 16],
            },
            stems: Vec::new(),
            chords: vec![ChordEvent {
                start_sec: 0.0,
                end_sec: 4.0,
                symbol: "Cmaj7".to_string(),
                confidence: 0.95,
            }],
            lyrics: vec![LyricLine {
                start_sec: 0.5,
                end_sec: 3.5,
                text: "星海漫游".to_string(),
            }],
            markers: vec![SectionMarker {
                id: "m1".to_string(),
                time_sec: 0.0,
                label: "前奏".to_string(),
            }],
            active_stem_name: "other".to_string(),
            bpm: 120.0,
            transpose_semitones: 0,
            loop_a: 0.0,
            loop_b: 8.0,
            notes: vec![MidiNote {
                pitch: 60,
                start_sec: 0.0,
                end_sec: 0.5,
                velocity: 96,
                confidence: 0.95,
            }],
            analysis: None,
        };

        let out = export_practice_bundle(&proj, Some("C Major"), tmp.to_str().unwrap()).unwrap();
        let out_dir = PathBuf::from(&out);
        assert!(out_dir.join("transcribed.mid").exists());
        assert!(out_dir.join("arrangement_2track.mid").exists());
        assert!(out_dir.join("score.musicxml").exists());
        assert!(out_dir.join("lyrics.lrc").exists());
        assert!(out_dir.join("subtitles.srt").exists());
        assert!(out_dir.join("leadsheet_A4.html").exists());
        assert!(out_dir.join("arrangement_report.md").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
