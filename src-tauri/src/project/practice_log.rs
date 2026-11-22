use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fmt::Write as FmtWrite;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PracticeRecord {
    pub id: String,
    pub song_name: String,
    pub timestamp: String,
    pub accuracy_pct: f32,
    pub max_combo: u32,
    pub playback_rate: f32,
    pub rank: String, // "S" | "A" | "B" | "C"
    pub duration_sec: f64,
}

fn practice_log_path() -> Result<PathBuf> {
    let base = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("StemScribe");
    fs::create_dir_all(&base)?;
    Ok(base.join("practice_logs.json"))
}

pub fn compute_rank(accuracy_pct: f32) -> &'static str {
    if accuracy_pct >= 92.0 {
        "S"
    } else if accuracy_pct >= 80.0 {
        "A"
    } else if accuracy_pct >= 65.0 {
        "B"
    } else {
        "C"
    }
}

pub fn save_record(mut record: PracticeRecord) -> Result<Vec<PracticeRecord>> {
    if record.rank.trim().is_empty() {
        record.rank = compute_rank(record.accuracy_pct).to_string();
    }
    let path = practice_log_path()?;
    let mut list = list_records().unwrap_or_default();
    list.insert(0, record);
    if list.len() > 100 {
        list.truncate(100);
    }
    let json = serde_json::to_string_pretty(&list)?;
    fs::write(&path, json)?;
    Ok(list)
}

pub fn list_records() -> Result<Vec<PracticeRecord>> {
    let path = practice_log_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)?;
    let list: Vec<PracticeRecord> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(list)
}

pub fn delete_record(record_id: &str) -> Result<Vec<PracticeRecord>> {
    let path = practice_log_path()?;
    let mut list = list_records().unwrap_or_default();
    list.retain(|r| r.id != record_id);
    let json = serde_json::to_string_pretty(&list)?;
    fs::write(&path, json)?;
    Ok(list)
}

fn escape_csv(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// Format practice records as UTF-8 CSV (with BOM for Excel/Numbers Chinese compatibility).
pub fn format_records_csv(records: &[PracticeRecord]) -> String {
    let mut out = String::from("\u{FEFF}时间,曲目,评级,准确度(%),最高连击,练习倍速(%),时长(秒)\n");
    for r in records {
        let _ = writeln!(
            out,
            "{},{},{},{:.1},{},{:.0},{:.1}",
            escape_csv(&r.timestamp),
            escape_csv(&r.song_name),
            escape_csv(&r.rank),
            r.accuracy_pct,
            r.max_combo,
            r.playback_rate * 100.0,
            r.duration_sec
        );
    }
    out
}

pub fn export_records_csv(save_path: &str) -> Result<String> {
    let records = list_records().unwrap_or_default();
    let csv = format_records_csv(&records);
    let path = Path::new(save_path);
    fs::write(path, csv)?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_rank_thresholds() {
        assert_eq!(compute_rank(96.5), "S");
        assert_eq!(compute_rank(85.0), "A");
        assert_eq!(compute_rank(70.0), "B");
        assert_eq!(compute_rank(42.0), "C");
    }

    #[test]
    fn test_format_practice_csv_rows() {
        let records = vec![PracticeRecord {
            id: "rec_1".to_string(),
            song_name: "星海漫游, Demo".to_string(),
            timestamp: "2026-11-20 12:00".to_string(),
            accuracy_pct: 94.5,
            max_combo: 28,
            playback_rate: 0.85,
            rank: "S".to_string(),
            duration_sec: 42.0,
        }];
        let csv = format_records_csv(&records);
        assert!(csv.starts_with('\u{FEFF}'));
        assert!(csv.contains("\"星海漫游, Demo\""));
        assert!(csv.contains(",S,94.5,28,85,42.0"));
    }
}
