import React, { useEffect, useState } from "react";
import { Download, FolderOpen, HardDrive, Trash2, X } from "lucide-react";
import { t } from "../i18n";
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
  const [msgIsError, setMsgIsError] = useState(false);

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
    bytes > 0 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : t("models.notInstalled");

  const fmtMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  const handleDownload = async (id: string) => {
    setBusyId(id);
    setMsg("");
    setMsgIsError(false);
    try {
      const saved = await downloadOnnxModel(id, urls[id] ?? "");
      setMsg(t("models.ready", { path: saved }));
      await refresh();
      onModelsUpdated();
    } catch (err) {
      setMsg(t("models.dlFail", { err: String(err) }));
      setMsgIsError(true);
    } finally {
      setBusyId(null);
    }
  };

  const handleImportLocal = async (id: string) => {
    const sourcePath = await pickOnnxOpenPath();
    if (!sourcePath) return;
    setBusyId(id);
    setMsg("");
    setMsgIsError(false);
    try {
      const saved = await importOnnxModel(id, sourcePath);
      setMsg(t("models.imported", { path: saved }));
      await refresh();
      onModelsUpdated();
    } catch (err) {
      setMsg(t("models.importFail", { err: String(err) }));
      setMsgIsError(true);
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
            <HardDrive size={15} /> {t("models.title")}
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="muted" style={{ marginBottom: 12 }}>
          {t("models.dirHint", { dir: modelsDir })}
        </div>

        {models.map((m) => {
          const prog = progress[m.id];
          const currentUrl = (urls[m.id] ?? m.default_url).trim();
          return (
            <div key={m.id} className="section-pill" style={{ padding: 12 }}>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                <strong>{m.display_name}</strong>
                <span className={`badge ${m.installed ? "ok" : ""}`}>
                  {m.installed ? t("models.installed", { size: fmtSize(m.size_bytes) }) : t("models.notInstalled")}
                </span>
              </div>

              <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
                {m.recommended_source_hint}
              </div>

              <input
                className="input"
                placeholder={t("models.urlPlaceholder")}
                value={urls[m.id] ?? m.default_url}
                onChange={(e) => setUrls((prev) => ({ ...prev, [m.id]: e.target.value }))}
                style={{ marginBottom: 8, fontSize: 12 }}
              />

              {prog && busyId === m.id && (
                <div style={{ marginBottom: 8 }}>
                  <div className="muted" style={{ marginBottom: 4 }}>
                    {t("models.downloading", { pct: prog.percent.toFixed(1), dl: fmtMb(prog.downloaded_bytes), total: prog.total_bytes > 0 ? ` / ${fmtMb(prog.total_bytes)}` : "" })}
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
                  <Download size={13} /> {busyId === m.id ? t("models.busy") : m.installed ? t("models.redownload") : t("models.download")}
                </button>
                <button
                  className={`btn btn-sm ${!m.direct_download_ready ? "btn-primary" : ""}`}
                  disabled={busyId !== null}
                  onClick={() => handleImportLocal(m.id)}
                  title={t("models.importTip")}
                >
                  <FolderOpen size={13} /> {t("models.import")}
                </button>
                {m.installed && (
                  <button className="btn btn-sm" onClick={() => handleDelete(m.id)}>
                    <Trash2 size={13} /> {t("models.delete")}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {msg && (
          <div
            className="muted"
            style={{ marginTop: 10, color: msgIsError ? "var(--rose)" : "var(--accent)", fontSize: 12 }}
          >
            {msg}
          </div>
        )}
      </div>
    </div>
  );
};
