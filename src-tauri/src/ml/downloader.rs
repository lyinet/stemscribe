use crate::ml::models_dir;
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelItemInfo {
    pub id: String,
    pub display_name: String,
    pub file_name: String,
    pub default_url: String,
    pub recommended_source_hint: String,
    pub direct_download_ready: bool,
    pub installed: bool,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgressEvent {
    pub model_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: f32,
    pub status: String,
}

fn resolve_model_filename(model_id: &str) -> Result<&'static str> {
    match model_id {
        "basic_pitch" => Ok("basic_pitch.onnx"),
        "htdemucs" => Ok("htdemucs.onnx"),
        other => Err(anyhow!("未知模型 ID: {other}")),
    }
}

pub fn list_models() -> Result<Vec<ModelItemInfo>> {
    let dir = models_dir()?;
    let specs = [
        (
            "basic_pitch",
            "Basic Pitch (音频转 MIDI)",
            "basic_pitch.onnx",
            "https://huggingface.co/spaces/spotify/basic-pitch/resolve/main/basic_pitch/saved_models/icassp_2022/nmp.onnx",
            "支持一键在线下载官方 Spotify ONNX 模型，或替换为国内 HF 镜像 / 离线导入。",
            true,
        ),
        (
            "htdemucs",
            "HTDemucs 4-Stem (人声/鼓/贝斯/伴奏)",
            "htdemucs.onnx",
            "",
            "请运行 scripts/export_models_onnx.py 本地导出后点击「从本地导入 .onnx」，或填入自建镜像 URL；未安装时自动使用内置 4 轨 DSP 引擎。",
            false,
        ),
    ];

    let mut items = Vec::new();
    for (id, name, fname, url, hint, ready) in specs {
        let path = dir.join(fname);
        let meta = std::fs::metadata(&path).ok();
        items.push(ModelItemInfo {
            id: id.to_string(),
            display_name: name.to_string(),
            file_name: fname.to_string(),
            default_url: url.to_string(),
            recommended_source_hint: hint.to_string(),
            direct_download_ready: ready,
            installed: meta.is_some(),
            size_bytes: meta.map(|m| m.len()).unwrap_or(0),
        });
    }
    Ok(items)
}

pub async fn download_model_with_progress(
    app: &AppHandle,
    model_id: &str,
    custom_url: &str,
) -> Result<String> {
    let file_name = resolve_model_filename(model_id)?;

    if custom_url.trim().is_empty() {
        return Err(anyhow!("请先填写可用的 .onnx 下载地址，或直接点击「从本地导入 .onnx」"));
    }

    let dest: PathBuf = models_dir()?.join(file_name);
    let tmp_dest: PathBuf = models_dir()?.join(format!("{file_name}.part"));

    let client = Client::new();
    let resp = client
        .get(custom_url.trim())
        .send()
        .await
        .with_context(|| format!("无法连接到模型下载地址: {custom_url}"))?;

    if !resp.status().is_success() {
        return Err(anyhow!("模型下载失败，HTTP 状态码: {}", resp.status()));
    }

    let total_bytes = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&tmp_dest).await?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        file.write_all(&bytes).await?;
        downloaded += bytes.len() as u64;

        let percent = if total_bytes > 0 {
            ((downloaded as f64 / total_bytes as f64) * 100.0) as f32
        } else {
            0.0
        };
        let _ = app.emit(
            "model-download-progress",
            DownloadProgressEvent {
                model_id: model_id.to_string(),
                downloaded_bytes: downloaded,
                total_bytes,
                percent,
                status: "downloading".to_string(),
            },
        );
    }

    file.flush().await?;
    drop(file);
    tokio::fs::rename(&tmp_dest, &dest).await?;

    let _ = app.emit(
        "model-download-progress",
        DownloadProgressEvent {
            model_id: model_id.to_string(),
            downloaded_bytes: downloaded,
            total_bytes: downloaded,
            percent: 100.0,
            status: "completed".to_string(),
        },
    );

    Ok(dest.to_string_lossy().to_string())
}

/// Offline import of a locally exported or mirrored `.onnx` model file into StemScribe's model directory.
pub fn import_local_model(model_id: &str, source_path: &str) -> Result<String> {
    let file_name = resolve_model_filename(model_id)?;
    let src = Path::new(source_path.trim());
    if !src.exists() || !src.is_file() {
        return Err(anyhow!("本地模型文件不存在: {source_path}"));
    }
    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "onnx" {
        return Err(anyhow!("仅支持导入 .onnx 格式的模型文件（当前文件: {source_path}）"));
    }
    let meta = std::fs::metadata(src)?;
    if meta.len() == 0 {
        return Err(anyhow!("所选 .onnx 模型文件为空，请检查导出是否完整"));
    }

    let dest: PathBuf = models_dir()?.join(file_name);
    if src.canonicalize().ok() != dest.canonicalize().ok() {
        std::fs::copy(src, &dest)
            .with_context(|| format!("复制模型文件失败: {} -> {}", src.display(), dest.display()))?;
    }
    Ok(dest.to_string_lossy().to_string())
}

pub fn delete_model(model_id: &str) -> Result<()> {
    let file_name = resolve_model_filename(model_id)?;
    let path = models_dir()?.join(file_name);
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_import_local_model_validation() {
        assert!(import_local_model("unknown_id", "/tmp/foo.onnx").is_err());
        assert!(import_local_model("basic_pitch", "/tmp/does_not_exist_12345.onnx").is_err());

        let tmp_txt = std::env::temp_dir().join("stemscribe_not_onnx.txt");
        std::fs::write(&tmp_txt, b"hello").unwrap();
        assert!(import_local_model("basic_pitch", tmp_txt.to_str().unwrap()).is_err());
        let _ = std::fs::remove_file(tmp_txt);
    }
}
