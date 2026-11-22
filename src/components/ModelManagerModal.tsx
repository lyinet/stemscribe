import React, { useEffect, useState } from "react";
import { Download, FolderOpen, HardDrive, Trash2, X } from "lucide-react";
import {
  deleteOnnxModel,
  downloadOnnxModel,
  importOnnxModel,
  listOnnxModels,
  onModelDownloadProgress,
  pickOnnxOpenPath,
} from "../lib/tauriApi";
import type { DownloadProgressEvent, ModelItemInfo } from "../types/music";

interface Props {
  open: boolean;
  modelsDir: string;
  onClose: () => void;
  onModelsUpdated: () => void;
}

export const ModelManagerModal: React.FC<Props> = ({
  open,
  modelsDir,
  onClose,
  onModelsUpdated,
}) => {
  const [models, setModels] = useState<ModelItemInfo[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, DownloadProgressEvent>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const refresh = async () => {
    const list = await listOnnxModels();
    setModels(list);
    setUrls((prev) => {
      const next = { ...prev };
      for (const m of list) {
        if (!(m.id in next)) next[m.id] = m.default_url;
      }
      return next;
    });
  };

  useEffect(() => {
    if (!open) return;
    refresh().catch(() => {});
    let unlisten: (() => void) | null = null;
    onModelDownloadProgress((evt) => {
      setProgress((prev) => ({ ...prev, [evt.model_id]: evt }));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [open]);

  if (!open) return null;

  const fmtSize = (bytes: number) =>
    bytes > 0 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : "未安装";

  const handleDownload = async (id: string) => {
    setBusyId(id);
    setMsg("");
    try {
      const saved = await downloadOnnxModel(id, urls[id] ?? "");
      setMsg(`模型已就绪：${saved}`);
      await refresh();
      onModelsUpdated();
    } catch (err) {
      setMsg(`下载失败：${String(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleImportLocal = async (id: string) => {
    const sourcePath = await pickOnnxOpenPath();
    if (!sourcePath) return;
    setBusyId(id);
    setMsg("");
    try {
      const saved = await importOnnxModel(id, sourcePath);
      setMsg(`已离线导入本地模型：${saved}`);
      await refresh();
      onModelsUpdated();
    } catch (err) {
      setMsg(`本地导入失败：${String(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    await deleteOnnxModel(id);
    await refresh();
    onModelsUpdated();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div className="card" style={{ width: 650, maxWidth: "92vw" }}>
        <div className="card-header">
          <div className="card-title">
            <HardDrive size={15} /> 本地 CoreML / ONNX 模型管理器
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="muted" style={{ marginBottom: 12 }}>
          本地缓存目录：{modelsDir}（未安装 ONNX 模型时，所有分轨与转谱功能仍可通过内置离线 DSP 引擎正常运行）
        </div>

        {models.map((m) => {
          const prog = progress[m.id];
          const currentUrl = (urls[m.id] ?? m.default_url).trim();
          return (
            <div key={m.id} className="section-pill" style={{ padding: 12 }}>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                <strong>{m.display_name}</strong>
                <span className={`badge ${m.installed ? "ok" : ""}`}>
                  {m.installed ? `已安装 · ${fmtSize(m.size_bytes)}` : "未安装"}
                </span>
              </div>

              <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
                {m.recommended_source_hint}
              </div>

              <input
                className="input"
                placeholder="输入可直连的 .onnx 下载链接（留空则直接点击下方「从本地导入 .onnx」）"
                value={urls[m.id] ?? m.default_url}
                onChange={(e) => setUrls((prev) => ({ ...prev, [m.id]: e.target.value }))}
                style={{ marginBottom: 8, fontSize: 12 }}
              />

              {prog && busyId === m.id && (
                <div style={{ marginBottom: 8 }}>
                  <div className="muted" style={{ marginBottom: 4 }}>
                    下载中：{prog.percent.toFixed(1)}% ({fmtSize(prog.downloaded_bytes)})
                  </div>
                  <div style={{ height: 6, background: "#232936", borderRadius: 4, overflow: "hidden" }}>
                    <div
                      style={{
                        width: `${Math.min(100, prog.percent)}%`,
                        height: "100%",
                        background: "var(--accent)",
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                <button
                  className={`btn btn-sm ${m.direct_download_ready ? "btn-primary" : ""}`}
                  disabled={busyId !== null || !currentUrl}
                  onClick={() => handleDownload(m.id)}
                >
                  <Download size={13} /> {busyId === m.id ? "处理中..." : m.installed ? "重新下载" : "在线下载"}
                </button>
                <button
                  className={`btn btn-sm ${!m.direct_download_ready ? "btn-primary" : ""}`}
                  disabled={busyId !== null}
                  onClick={() => handleImportLocal(m.id)}
                  title="选择本地已下载或由 scripts/export_models_onnx.py 导出的 .onnx 文件"
                >
                  <FolderOpen size={13} /> 从本地导入 .onnx
                </button>
                {m.installed && (
                  <button className="btn btn-sm" onClick={() => handleDelete(m.id)}>
                    <Trash2 size={13} /> 删除缓存
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {msg && (
          <div className="muted" style={{ marginTop: 10, color: "var(--accent)", fontSize: 12 }}>
            {msg}
          </div>
        )}
      </div>
    </div>
  );
};
