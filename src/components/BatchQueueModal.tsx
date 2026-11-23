import React, { useEffect, useState } from "react";
import { FolderOutput, ListMusic, Play, Plus, X } from "lucide-react";
import { t } from "../i18n";
import {
  onBatchJobProgress,
  pickAudioFilesMultiple,
  pickDirectory,
  runBatchJob,
} from "../lib/tauriApi";
import type { BatchJobSummary, BatchProgressEvent } from "../types/music";

interface Props {
  open: boolean;
  onClose: () => void;
}

export const BatchQueueModal: React.FC<Props> = ({ open, onClose }) => {
  const [files, setFiles] = useState<string[]>([]);
  const [outputDir, setOutputDir] = useState("~/Desktop/StemScribe_Batch");
  const [exportMidi, setExportMidi] = useState(true);
  const [exportChords, setExportChords] = useState(true);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<Record<number, BatchProgressEvent>>({});
  const [summary, setSummary] = useState<BatchJobSummary | null>(null);

  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | null = null;
    onBatchJobProgress((evt) => {
      setLogs((prev) => ({ ...prev, [evt.index]: evt }));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [open]);

  if (!open) return null;

  const handleAddFiles = async () => {
    const picked = await pickAudioFilesMultiple();
    if (picked.length > 0) {
      setFiles((prev) => Array.from(new Set([...prev, ...picked])));
    }
  };

  const handlePickDir = async () => {
    const dir = await pickDirectory();
    if (dir) setOutputDir(dir);
  };

  const handleRun = async () => {
    if (files.length === 0) return;
    setRunning(true);
    setLogs({});
    setSummary(null);
    try {
      const res = await runBatchJob({
        file_paths: files,
        output_root: outputDir,
        export_midi_for_vocals: exportMidi,
        export_chords_json: exportChords,
      });
      setSummary(res);
    } finally {
      setRunning(false);
    }
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
      <div className="card" style={{ width: 640, maxWidth: "92vw" }}>
        <div className="card-header">
          <div className="card-title">
            <ListMusic size={15} /> {t("batch.title")}
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn btn-sm" onClick={handleAddFiles} disabled={running}>
            <Plus size={13} /> {t("batch.addFiles")}
          </button>
          <button className="btn btn-sm" onClick={handlePickDir} disabled={running}>
            <FolderOutput size={13} /> {t("batch.outDir", { dir: outputDir })}
          </button>
        </div>

        <div className="row" style={{ marginBottom: 12, fontSize: 12.5 }}>
          <label className="row" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={exportMidi}
              onChange={(e) => setExportMidi(e.target.checked)}
            />
            {t("batch.autoMidi")}
          </label>
          <label className="row" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={exportChords}
              onChange={(e) => setExportChords(e.target.checked)}
            />
            {t("batch.autoChords")}
          </label>
        </div>

        <div style={{ maxHeight: 200, overflowY: "auto", marginBottom: 12 }}>
          {files.length === 0 ? (
            <div className="muted" style={{ padding: "18px 0", textAlign: "center" }}>
              {t("batch.empty")}
            </div>
          ) : (
            files.map((f, idx) => {
              const ev = logs[idx];
              return (
                <div key={f} className="section-pill" style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>{f.split("/").pop()}</span>
                  <span className="muted">
                    {ev ? `[${ev.status}] ${ev.message}` : t("batch.pending")}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted">
            {summary
              ? t("batch.done", { ok: summary.succeeded, total: summary.total, failed: summary.failed })
              : t("batch.count", { count: files.length })}
          </span>
          <button
            className="btn btn-primary"
            disabled={files.length === 0 || running}
            onClick={handleRun}
          >
            <Play size={14} /> {running ? t("batch.running") : t("batch.run")}
          </button>
        </div>
      </div>
    </div>
  );
};
