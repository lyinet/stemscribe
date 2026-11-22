import React, { useEffect, useState } from "react";
import { FolderOutput, ListMusic, Play, Plus, X } from "lucide-react";
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
            <ListMusic size={15} /> 多曲目批量分轨与转谱队列
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn btn-sm" onClick={handleAddFiles} disabled={running}>
            <Plus size={13} /> 添加音频文件
          </button>
          <button className="btn btn-sm" onClick={handlePickDir} disabled={running}>
            <FolderOutput size={13} /> 输出目录: {outputDir}
          </button>
        </div>

        <div className="row" style={{ marginBottom: 12, fontSize: 12.5 }}>
          <label className="row" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={exportMidi}
              onChange={(e) => setExportMidi(e.target.checked)}
            />
            自动转人声 MIDI
          </label>
          <label className="row" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={exportChords}
              onChange={(e) => setExportChords(e.target.checked)}
            />
            自动导出和弦 JSON
          </label>
        </div>

        <div style={{ maxHeight: 200, overflowY: "auto", marginBottom: 12 }}>
          {files.length === 0 ? (
            <div className="muted" style={{ padding: "18px 0", textAlign: "center" }}>
              点击「添加音频文件」可一次导入多首歌曲，在 Apple Silicon 上全自动顺序分轨并输出独立文件夹。
            </div>
          ) : (
            files.map((f, idx) => {
              const ev = logs[idx];
              return (
                <div key={f} className="section-pill" style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>{f.split("/").pop()}</span>
                  <span className="muted">
                    {ev ? `[${ev.status}] ${ev.message}` : "等待执行"}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted">
            {summary
              ? `批量完成：成功 ${summary.succeeded}/${summary.total}，失败 ${summary.failed}`
              : `队列中共有 ${files.length} 首音频`}
          </span>
          <button
            className="btn btn-primary"
            disabled={files.length === 0 || running}
            onClick={handleRun}
          >
            <Play size={14} /> {running ? "批量处理中..." : "开始批量队列"}
          </button>
        </div>
      </div>
    </div>
  );
};
