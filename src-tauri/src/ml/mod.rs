pub mod downloader;
pub mod musicxml;
pub mod separator;
pub mod transcriber;

use anyhow::{Context, Result};
#[cfg(target_os = "macos")]
use ort::execution_providers::CoreMLExecutionProvider;
use ort::session::{builder::GraphOptimizationLevel, Session};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelStatus {
    pub models_dir: String,
    pub demucs_installed: bool,
    pub demucs_ft_vocals_installed: bool,
    pub basic_pitch_installed: bool,
    pub critic_installed: bool,
    pub coreml_enabled: bool,
}

pub fn models_dir() -> Result<PathBuf> {
    let base = dirs::data_dir().context("Cannot locate macOS Application Support directory")?;
    let dir = base.join("StemScribe").join("models");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Per-song stems directory: `StemScribe/stems/<hash(path|size|mtime)>/`.
/// Stable for an unchanged file, so a completed separation there doubles
/// as a cache (see `run_separation`).
pub fn stems_dir_for(source_path: &str) -> Result<PathBuf> {
    let p = std::path::Path::new(source_path);
    let md = std::fs::metadata(p)
        .with_context(|| format!("无法读取源文件 {source_path}"))?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let key = format!("{source_path}|{}|{mtime}", md.len());
    let mut h = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&key, &mut h);
    let digest = format!("{:016x}", std::hash::Hasher::finish(&h));
    let base = dirs::data_dir().context("Cannot locate macOS Application Support directory")?;
    Ok(base.join("StemScribe").join("stems").join(digest))
}

pub fn demucs_model_path() -> Result<PathBuf> {
    Ok(models_dir()?.join("htdemucs.onnx"))
}

pub fn demucs_ft_vocals_model_path() -> Result<PathBuf> {
    Ok(models_dir()?.join("htdemucs_ft_vocals.onnx"))
}

pub fn basic_pitch_model_path() -> Result<PathBuf> {
    Ok(models_dir()?.join("basic_pitch.onnx"))
}

pub fn audiobox_aes_model_path() -> Result<PathBuf> {
    Ok(models_dir()?.join("audiobox_aes.onnx"))
}

pub fn check_model_status() -> Result<ModelStatus> {
    let dir = models_dir()?;
    Ok(ModelStatus {
        models_dir: dir.to_string_lossy().to_string(),
        demucs_installed: demucs_model_path()?.exists(),
        demucs_ft_vocals_installed: demucs_ft_vocals_model_path()?.exists(),
        basic_pitch_installed: basic_pitch_model_path()?.exists(),
        critic_installed: audiobox_aes_model_path()?.exists(),
        coreml_enabled: cfg!(target_os = "macos"),
    })
}

pub fn build_coreml_session(model_path: &PathBuf) -> Result<Session> {
    build_session(model_path, true)
}

pub fn build_cpu_session(model_path: &PathBuf) -> Result<Session> {
    build_session(model_path, false)
}

fn build_session(model_path: &PathBuf, use_coreml: bool) -> Result<Session> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = Session::builder()?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        // The pre-planned memory pattern reserves one arena sized to the
        // model's worst-case concurrent tensors (~2.5 GB for HTDemucs);
        // per-op arena allocation peaks much lower for chunked inference.
        .with_memory_pattern(false)?
        .with_intra_threads(threads)?;

    #[cfg(target_os = "macos")]
    if use_coreml {
        builder = builder.with_execution_providers([CoreMLExecutionProvider::default().with_subgraphs(true).build()])?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = use_coreml;

    let session = builder
        .commit_from_file(model_path)
        .with_context(|| format!("Failed to load ONNX model at {}", model_path.display()))?;
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::stems_dir_for;
    use std::io::Write;

    #[test]
    fn stems_dir_stable_and_source_specific() {
        let dir = std::env::temp_dir().join(format!("ss_stemsdir_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("song_a.wav");
        let b = dir.join("song_b.wav");
        std::fs::File::create(&a).unwrap().write_all(b"aaaa").unwrap();
        std::fs::File::create(&b).unwrap().write_all(b"bbbb").unwrap();

        let da1 = stems_dir_for(a.to_str().unwrap()).unwrap();
        let da2 = stems_dir_for(a.to_str().unwrap()).unwrap();
        let db = stems_dir_for(b.to_str().unwrap()).unwrap();
        assert_eq!(da1, da2, "same file -> same stems dir");
        assert_ne!(da1, db, "different files -> different stems dirs");
        assert!(da1.ends_with("stems") || da1.parent().unwrap().ends_with("stems"));

        // mtime/body change -> new dir (no silent reuse of stale stems)
        std::fs::File::create(&a).unwrap().write_all(b"aaaa-changed").unwrap();
        let da3 = stems_dir_for(a.to_str().unwrap()).unwrap();
        assert_ne!(da1, da3);
    }
}
