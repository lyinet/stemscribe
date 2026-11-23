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

const BASIC_PITCH_URL: &str =
    "https://github.com/spotify/basic-pitch/raw/main/basic_pitch/saved_models/icassp_2022/nmp.onnx";
const HTDEMUCS_URL: &str = "https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx";
const HTDEMUCS_FT_VOCALS_URL: &str = "https://huggingface.co/StemSplitio/htdemucs-ft-onnx/resolve/main/htdemucs_ft_vocals_fp16weights.onnx";
const AUDIOBOX_AES_URL: &str =
    "https://huggingface.co/Microck/audiobox-aesthetics-onnx/resolve/main/aes.int8.onnx";

fn default_url(model_id: &str) -> &'static str {
    match model_id {
        "basic_pitch" => BASIC_PITCH_URL,
        "htdemucs" => HTDEMUCS_URL,
        "htdemucs_ft_vocals" => HTDEMUCS_FT_VOCALS_URL,
        "audiobox_aes" => AUDIOBOX_AES_URL,
        _ => "",
    }
}

/// Rejects files that are clearly not ONNX models (HTML error pages, auth
/// failures, truncated downloads). An ONNX ModelProto always starts with
/// field 1 (`ir_version`, varint) => first byte 0x08.
pub fn validate_onnx_file(path: &Path) -> Result<()> {
    use std::io::Read;
    let len = std::fs::metadata(path)?.len();
    let mut head = [0u8; 1];
    std::fs::File::open(path)?.read_exact(&mut head).ok();
    if len < 64 * 1024 || head[0] != 0x08 {
        let preview = std::fs::read(path)
            .map(|b| String::from_utf8_lossy(&b[..b.len().min(80)]).trim().to_string())
            .unwrap_or_default();
        return Err(anyhow!(
            "下载/导入的文件不是有效的 ONNX 模型（{len} 字节{}），请更换下载地址或检查网络代理",
            if preview.is_empty() { String::new() } else { format!("，内容: {preview}") }
        ));
    }
    Ok(())
}

fn resolve_model_filename(model_id: &str) -> Result<&'static str> {
    match model_id {
        "basic_pitch" => Ok("basic_pitch.onnx"),
        "htdemucs" => Ok("htdemucs.onnx"),
        "htdemucs_ft_vocals" => Ok("htdemucs_ft_vocals.onnx"),
        "audiobox_aes" => Ok("audiobox_aes.onnx"),
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
            BASIC_PITCH_URL,
            "Spotify 官方 Basic Pitch 模型（约 230 KB），可一键下载或离线导入。",
            true,
        ),
        (
            "htdemucs",
            "HTDemucs 4-Stem (人声/鼓/贝斯/伴奏)",
            "htdemucs.onnx",
            HTDEMUCS_URL,
            "Meta HTDemucs 4 轨分离模型 ONNX 版（约 166 MB），可一键下载，也可填入镜像地址或离线导入。",
            true,
        ),
        (
            "htdemucs_ft_vocals",
            "HTDemucs-FT 人声专家（高质量分轨，可选）",
            "htdemucs_ft_vocals.onnx",
            HTDEMUCS_FT_VOCALS_URL,
            "人声分离更干净，分轨时间约为标准的 2 倍。",
            true,
        ),
        (
            "audiobox_aes",
            "Audiobox 音质评委（可选）",
            "audiobox_aes.onnx",
            AUDIOBOX_AES_URL,
            "本地给音质打分（Meta，CC-BY 4.0），约 126 MB。",
            true,
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

    let url = match custom_url.trim() {
        "" => default_url(model_id),
        u => u,
    };

    let dest: PathBuf = models_dir()?.join(file_name);
    let tmp_dest: PathBuf = models_dir()?.join(format!("{file_name}.part"));

    let client = Client::new();
    let resp = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("无法连接到模型下载地址: {url}"))?;

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
    if let Err(e) = validate_onnx_file(&tmp_dest) {
        let _ = tokio::fs::remove_file(&tmp_dest).await;
        return Err(e);
    }
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
    validate_onnx_file(src)?;

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

        let fake = std::env::temp_dir().join("stemscribe_fake_model.onnx");
        std::fs::write(&fake, b"Invalid username or password.").unwrap();
        assert!(validate_onnx_file(&fake).is_err());
        let _ = std::fs::remove_file(fake);
    }
}
