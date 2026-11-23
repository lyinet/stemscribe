import React, { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { Circle, Download, HardDrive, Layers, Mic, Square, Trash2 } from "lucide-react";
import {
  OverdubTakeRecorder,
  uint8ToBase64,
  type RecordedTake,
} from "../lib/takeRecorder";
import type { SavedTakeInfo } from "../types/music";

interface Props {
  songName: string;
  hasStems: boolean;
  isPlaying: boolean;
  playbackRate: number;
  archivedTakes: SavedTakeInfo[];
  onStartBackingPlayback: () => void;
  onStopBackingPlayback: () => void;
  onArchiveTake: (songName: string, label: string, wavBase64: string) => Promise<string>;
  onDeleteArchivedTake: (fileName: string) => Promise<void>;
  onBounceCoverWav: (
    label: string,
    wavBase64: string,
    takeGain: number,
    takeOffsetMs: number
  ) => Promise<string | null>;
}

export const CoverStudioView: React.FC<Props> = ({
  songName,
  hasStems,
  isPlaying,
  playbackRate,
  archivedTakes,
  onStartBackingPlayback,
  onStopBackingPlayback,
  onArchiveTake,
  onDeleteArchivedTake,
  onBounceCoverWav,
}) => {
  const recorderRef = useRef<OverdubTakeRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState<number>(0);
  const [useCountdown, setUseCountdown] = useState<boolean>(true);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [syncWithBacking, setSyncWithBacking] = useState(true);
  const [takeGain, setTakeGain] = useState(1.1);
  const [takeOffsetMs, setTakeOffsetMs] = useState(0);
  const [takes, setTakes] = useState<RecordedTake[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [bouncingId, setBouncingId] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) {
      setElapsedSec(0);
      return;
    }
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setElapsedSec((Date.now() - startedAt) / 1000);
    }, 100);
    return () => window.clearInterval(id);
  }, [recording]);

  const fmtTimer = (sec: number) => {
    const m = Math.floor(sec / 60).toString().padStart(2, "0");
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    const d = Math.floor((sec % 1) * 10);
    return `${m}:${s}.${d}`;
  };

  const handleStartRec = async () => {
    setErrorMsg("");
    if (useCountdown) {
      for (let c = 3; c >= 1; c--) {
        setCountdown(c);
        await new Promise((r) => setTimeout(r, 650));
      }
      setCountdown(0);
    }
    try {
      if (!recorderRef.current) recorderRef.current = new OverdubTakeRecorder();
      await recorderRef.current.start();
      setRecording(true);
      if (syncWithBacking && hasStems && !isPlaying) {
        onStartBackingPlayback();
      }
    } catch (err) {
      setErrorMsg(String(err));
      setRecording(false);
    }
  };

  const handleStopRec = async () => {
    if (!recorderRef.current) return;
    try {
      const label = `Take_${takes.length + 1}`;
      const take = await recorderRef.current.stop(label, playbackRate);
      setTakes((prev) => [take, ...prev]);
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setRecording(false);
      if (syncWithBacking && isPlaying) {
        onStopBackingPlayback();
      }
    }
  };

  const handleDownloadTake = (t: RecordedTake) => {
    const a = document.createElement("a");
    a.href = t.blobUrl;
    a.download = `${(songName || "cover").replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_")}_${t.label}.wav`;
    a.click();
  };

  const handleArchiveToDisk = async (tk: RecordedTake) => {
    setSavingId(tk.id);
    try {
      const b64 = uint8ToBase64(tk.wavBytes);
      const savedPath = await onArchiveTake(songName || "cover", tk.label, b64);
      setTakes((prev) => prev.map((x) => (x.id === tk.id ? { ...x, savedPath } : x)));
    } catch (err) {
      setErrorMsg(t("cover.archiveFail", { err: String(err) }));
    } finally {
      setSavingId(null);
    }
  };

  const handleBounceFinalCover = async (tk: RecordedTake) => {
    setBouncingId(tk.id);
    setErrorMsg("");
    try {
      const b64 = uint8ToBase64(tk.wavBytes);
      await onBounceCoverWav(tk.label, b64, takeGain, takeOffsetMs);
    } catch (err) {
      setErrorMsg(t("cover.bounceFail", { err: String(err) }));
    } finally {
      setBouncingId(null);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title" title={t("cover.titleTip")}>
          <Mic size={14} color="#f43f5e" />
          <span>{t("cover.title")}</span>
          {countdown > 0 && (
            <span className="badge" style={{ color: "#fbbf24", borderColor: "#f59e0b", fontWeight: 700 }}>
              {t("cover.countdown", { n: countdown })}
            </span>
          )}
          {recording && (
            <span className="badge" style={{ color: "#fda4af", borderColor: "#f43f5e" }}>
              ● {t("cover.recording", { time: fmtTimer(elapsedSec) })}
            </span>
          )}
        </div>

        <div className="row" style={{ flexWrap: "wrap" }}>
          <label className="muted" style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={useCountdown}
              onChange={(e) => setUseCountdown(e.target.checked)}
            />
            {t("cover.count3")}
          </label>
          <label className="row muted" style={{ cursor: "pointer", gap: 5 }}>
            <input
              type="checkbox"
              checked={syncWithBacking}
              onChange={(e) => setSyncWithBacking(e.target.checked)}
            />
            {t("cover.linkBacking")}
          </label>
          {!recording ? (
            <button
              className="btn btn-primary"
              style={{ background: "#e11d48", borderColor: "#e11d48" }}
              onClick={handleStartRec}
            >
              <Circle size={13} fill="currentColor" /> {t("cover.record")}
            </button>
          ) : (
            <button className="btn" onClick={handleStopRec}>
              <Square size={13} fill="currentColor" /> {t("cover.stop")}
            </button>
          )}
        </div>
      </div>

      {/* Mixdown Gain & Latency Compensation Controls */}
      <div
        className="row"
        style={{
          flexWrap: "wrap",
          gap: 16,
          padding: "8px 12px",
          borderRadius: 8,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          marginBottom: 12,
        }}
      >
        <div className="row" style={{ gap: 6 }}>
          <span className="muted">{t("cover.gain")}</span>
          <input
            type="range"
            min={0.5}
            max={1.6}
            step={0.05}
            value={takeGain}
            onChange={(e) => setTakeGain(Number(e.target.value))}
            style={{ width: 90 }}
          />
          <span className="badge">{Math.round(takeGain * 100)}%</span>
        </div>

        <div className="row" style={{ gap: 6 }}>
          <span className="muted">{t("cover.latency")}</span>
          <input
            type="range"
            min={-150}
            max={150}
            step={10}
            value={takeOffsetMs}
            onChange={(e) => setTakeOffsetMs(Number(e.target.value))}
            style={{ width: 100 }}
          />
          <span className="badge">
            {takeOffsetMs >= 0 ? `+${takeOffsetMs}ms` : `${takeOffsetMs}ms`}
          </span>
        </div>
      </div>

      {errorMsg && (
        <div className="section-pill" style={{ borderColor: "var(--rose)", color: "#fda4af" }}>
          {errorMsg}
        </div>
      )}

      {takes.length === 0 ? (
        <div className="muted" style={{ padding: "8px 0" }}>
          {t("cover.hint")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {takes.map((tk) => (
            <div
              key={tk.id}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "10px 12px",
                borderRadius: 10,
                background: "var(--bg)",
                border: "1px solid var(--border)",
              }}
            >
              <div>
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="input"
                    value={tk.label}
                    onChange={(e) =>
                      setTakes((prev) =>
                        prev.map((x) => (x.id === tk.id ? { ...x, label: e.target.value } : x))
                      )
                    }
                    style={{ width: 120, padding: "2px 6px", fontSize: 12.5, fontWeight: 600 }}
                    title={t("cover.renameTip")}
                  />
                  <span className="muted" style={{ fontSize: 12 }}>{tk.durationSec.toFixed(1)}s</span>
                  {tk.savedPath && <span className="badge ok">{t("cover.archived")}</span>}
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {t("cover.recordedMeta", { at: tk.createdAt, pct: Math.round(tk.playbackRate * 100) })}
                </div>
              </div>

              <audio controls src={tk.blobUrl} style={{ height: 32, maxWidth: 230 }} />

              <div className="row" style={{ flexWrap: "wrap" }}>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={!hasStems || bouncingId === tk.id}
                  onClick={() => handleBounceFinalCover(tk)}
                  title={t("cover.bounceTip")}
                >
                  <Layers size={12} /> {bouncingId === tk.id ? t("cover.bouncing") : t("cover.bounce")}
                </button>
                <button
                  className="btn btn-sm"
                  disabled={savingId === tk.id}
                  onClick={() => handleArchiveToDisk(tk)}
                  title={t("cover.archiveTip")}
                >
                  <HardDrive size={12} /> {savingId === tk.id ? t("cover.archiving") : t("cover.archive")}
                </button>
                <button
                  className="btn btn-sm btn-active"
                  onClick={() => handleDownloadTake(tk)}
                >
                  <Download size={12} /> {t("cover.dryWav")}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    URL.revokeObjectURL(tk.blobUrl);
                    setTakes((prev) => prev.filter((x) => x.id !== tk.id));
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {archivedTakes.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ marginBottom: 6 }}>
            {t("cover.archivedTitle", { count: archivedTakes.length })}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {archivedTakes.slice(0, 8).map((a) => (
              <span key={a.file_path} className="badge" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span>{a.file_name} ({(a.size_bytes / 1024).toFixed(0)} KB)</span>
                <Trash2
                  size={11}
                  style={{ cursor: "pointer", opacity: 0.7 }}
                  onClick={() => onDeleteArchivedTake(a.file_name)}
                >
                  <title>{t("cover.deleteTip")}</title>
                </Trash2>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
