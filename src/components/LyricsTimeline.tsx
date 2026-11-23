import React, { useState } from "react";
import { Clock, Download, FileText, FolderOpen, Mic, Plus, Trash2 } from "lucide-react";
import { t } from "../i18n";
import type { LyricLine } from "../types/music";

interface Props {
  lyrics: LyricLine[];
  currentTime: number;
  hasAudio: boolean;
  loading: boolean;
  onExtractLyrics: (useWhisper: boolean) => void;
  onChangeLyrics: (next: LyricLine[]) => void;
  onSeek: (sec: number) => void;
  onImportLrc: () => void;
  onExportLrc: () => void;
  onExportSrt: () => void;
}

export const LyricsTimeline: React.FC<Props> = ({
  lyrics,
  currentTime,
  hasAudio,
  loading,
  onExtractLyrics,
  onChangeLyrics,
  onSeek,
  onImportLrc,
  onExportLrc,
  onExportSrt,
}) => {
  const [useWhisper, setUseWhisper] = useState(true);

  const fmt = (s: number) => {
    const clamped = Math.max(0, s);
    const m = Math.floor(clamped / 60);
    const rem = (clamped % 60).toFixed(1).padStart(4, "0");
    return `${m}:${rem}`;
  };

  const shiftAll = (deltaSec: number) => {
    if (lyrics.length === 0) return;
    const next = lyrics.map((line) => {
      const start_sec = Math.max(0, Number((line.start_sec + deltaSec).toFixed(2)));
      const end_sec = Math.max(start_sec + 0.5, Number((line.end_sec + deltaSec).toFixed(2)));
      return { ...line, start_sec, end_sec };
    });
    onChangeLyrics(next);
  };

  const addLineAtCurrent = () => {
    const start_sec = Number(Math.max(0, currentTime).toFixed(2));
    const end_sec = Number((start_sec + 3.0).toFixed(2));
    const next = [...lyrics, { start_sec, end_sec, text: t("lyrics.newLine") }].sort(
      (a, b) => a.start_sec - b.start_sec
    );
    onChangeLyrics(next);
  };

  const stampCurrentTime = (idx: number) => {
    const start_sec = Number(Math.max(0, currentTime).toFixed(2));
    const next = [...lyrics];
    const prevEnd = next[idx].end_sec;
    next[idx] = {
      ...next[idx],
      start_sec,
      end_sec: prevEnd > start_sec + 0.3 ? prevEnd : Number((start_sec + 3.0).toFixed(2)),
    };
    next.sort((a, b) => a.start_sec - b.start_sec);
    onChangeLyrics(next);
  };

  const removeLine = (idx: number) => {
    onChangeLyrics(lyrics.filter((_, i) => i !== idx));
  };

  return (
    <div className="card">
      <div className="card-header" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="card-title" title={t("lyrics.titleTip")}>
          <Mic size={14} /> {t("lyrics.title")}
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <label className="muted" style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={useWhisper}
              onChange={(e) => setUseWhisper(e.target.checked)}
            />
            {t("lyrics.whisper")}
          </label>
          <button
            className="btn btn-sm"
            disabled={!hasAudio || loading}
            onClick={() => onExtractLyrics(useWhisper)}
          >
            {loading ? t("lyrics.transcribing") : t("lyrics.extract")}
          </button>
          <button className="btn btn-sm" onClick={onImportLrc} title={t("lyrics.importTip")}>
            <FolderOpen size={12} /> {t("lyrics.import")}
          </button>
          <button className="btn btn-sm" onClick={addLineAtCurrent} title={t("lyrics.addTip")}>
            <Plus size={12} /> {t("lyrics.add")}
          </button>
          {lyrics.length > 0 && (
            <>
              <button className="btn btn-sm" onClick={() => shiftAll(-0.5)} title={t("lyrics.earlierTip")}>
                -0.5s
              </button>
              <button className="btn btn-sm" onClick={() => shiftAll(0.5)} title={t("lyrics.laterTip")}>
                +0.5s
              </button>
            </>
          )}
          <button
            className="btn btn-sm btn-primary"
            disabled={lyrics.length === 0}
            onClick={onExportLrc}
          >
            <Download size={12} /> .lrc
          </button>
          <button
            className="btn btn-sm"
            disabled={lyrics.length === 0}
            onClick={onExportSrt}
            title={t("lyrics.srtTip")}
          >
            <FileText size={12} /> {t("lyrics.srt")}
          </button>
        </div>
      </div>

      {lyrics.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {t("lyrics.empty")}
        </div>
      ) : (
        <div style={{ maxHeight: 185, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
          {lyrics.map((line, idx) => {
            const active = currentTime >= line.start_sec && currentTime <= line.end_sec;
            return (
              <div
                key={idx}
                className="row"
                style={{
                  padding: "5px 8px",
                  borderRadius: 8,
                  border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                  background: active ? "var(--accent-soft)" : "var(--bg)",
                  gap: 6,
                }}
              >
                <button
                  className="btn btn-sm"
                  style={{ minWidth: 56, justifyContent: "center" }}
                  onClick={() => onSeek(line.start_sec)}
                  title={t("lyrics.jumpTip")}
                >
                  {fmt(line.start_sec)}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => stampCurrentTime(idx)}
                  title={t("lyrics.stampTip")}
                  style={{ padding: "3px 6px" }}
                >
                  <Clock size={12} />
                </button>
                <input
                  className="input"
                  value={line.text}
                  onChange={(e) => {
                    const next = [...lyrics];
                    next[idx] = { ...line, text: e.target.value };
                    onChangeLyrics(next);
                  }}
                  style={{ background: "transparent", border: "none", padding: "2px 6px" }}
                />
                <button
                  className="btn btn-sm"
                  onClick={() => removeLine(idx)}
                  title={t("lyrics.deleteTip")}
                  style={{ padding: "3px 6px" }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
