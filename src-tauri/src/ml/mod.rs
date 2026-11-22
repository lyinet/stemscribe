pub mod downloader;
pub mod musicxml;
pub mod separator;
pub mod transcriber;

use anyhow::{Context, Result};
use ort::execution_providers::CoreMLExecutionProvider;
use ort::session::{builder::GraphOptimizationLevel, Session};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelStatus {
    pub models_dir: String,
    pub demucs_installed: bool,
    pub basic_pitch_installed: bool,
    pub coreml_enabled: bool,
}

pub fn models_dir() -> Result<PathBuf> {
    let base = dirs::data_dir().context("Cannot locate macOS Application Support directory")?;
    let dir = base.join("StemScribe").join("models");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn demucs_model_path() -> Result<PathBuf> {
    Ok(models_dir()?.join("htdemucs.onnx"))
}

pub fn basic_pitch_model_path() -> Result<PathBuf> {
    Ok(models_dir()?.join("basic_pitch.onnx"))
}

pub fn check_model_status() -> Result<ModelStatus> {
    let dir = models_dir()?;
    Ok(ModelStatus {
        models_dir: dir.to_string_lossy().to_string(),
        demucs_installed: demucs_model_path()?.exists(),
        basic_pitch_installed: basic_pitch_model_path()?.exists(),
        coreml_enabled: cfg!(target_os = "macos"),
    })
}

pub fn build_coreml_session(model_path: &PathBuf) -> Result<Session> {
    let mut builder = Session::builder()?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .with_intra_threads(4)?;

    #[cfg(target_os = "macos")]
    {
        builder = builder.with_execution_providers([
            CoreMLExecutionProvider::default()
                .with_subgraphs(true)
                .build(),
        ])?;
    }

    let session = builder
        .commit_from_file(model_path)
        .with_context(|| format!("Failed to load ONNX model at {}", model_path.display()))?;
    Ok(session)
}
