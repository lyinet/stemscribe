use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetlistItem {
    pub project_id: String,
    pub song_name: String,
    pub bpm: f32,
    pub key_label: String,
    pub capo_fret: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Setlist {
    pub id: String,
    pub name: String,
    pub updated_at: String,
    pub items: Vec<SetlistItem>,
}

fn setlists_path() -> Result<PathBuf> {
    let base = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("StemScribe");
    fs::create_dir_all(&base)?;
    Ok(base.join("setlists.json"))
}

pub fn list_setlists() -> Result<Vec<Setlist>> {
    let path = setlists_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)?;
    let list: Vec<Setlist> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(list)
}

pub fn upsert_setlist(mut list: Vec<Setlist>, setlist: Setlist) -> Vec<Setlist> {
    if let Some(existing) = list.iter_mut().find(|s| s.id == setlist.id) {
        *existing = setlist;
    } else {
        list.insert(0, setlist);
    }
    list
}

pub fn save_setlist(setlist: Setlist) -> Result<Vec<Setlist>> {
    let path = setlists_path()?;
    let existing = list_setlists().unwrap_or_default();
    let updated = upsert_setlist(existing, setlist);
    fs::write(&path, serde_json::to_string_pretty(&updated)?)?;
    Ok(updated)
}

pub fn delete_setlist(setlist_id: &str) -> Result<Vec<Setlist>> {
    let path = setlists_path()?;
    let mut list = list_setlists().unwrap_or_default();
    list.retain(|s| s.id != setlist_id);
    fs::write(&path, serde_json::to_string_pretty(&list)?)?;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_upsert_setlist_replaces_existing_id() {
        let s1 = Setlist {
            id: "gig_1".into(),
            name: "周五演出".into(),
            updated_at: "2026-11-19".into(),
            items: vec![],
        };
        let list = upsert_setlist(vec![], s1);
        assert_eq!(list.len(), 1);

        let s1_updated = Setlist {
            id: "gig_1".into(),
            name: "周五 Livehouse 最终版".into(),
            updated_at: "2026-11-20".into(),
            items: vec![SetlistItem {
                project_id: "p1".into(),
                song_name: "星海漫游".into(),
                bpm: 120.0,
                key_label: "C 大调".into(),
                capo_fret: 2,
            }],
        };
        let list2 = upsert_setlist(list, s1_updated);
        assert_eq!(list2.len(), 1);
        assert_eq!(list2[0].items.len(), 1);
        assert_eq!(list2[0].name, "周五 Livehouse 最终版");
    }
}
