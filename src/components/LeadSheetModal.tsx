import React, { useMemo } from "react";
import { Download, FileText, Printer, X } from "lucide-react";
import { transposeChordSymbol } from "../lib/musicTheory";
import type {
  ChordEvent,
  KeyEstimate,
  LeadSheetInput,
  LyricLine,
  SongStructureSegment,
} from "../types/music";

interface Props {
  open: boolean;
  songName: string;
  bpm: number;
  keyEst: KeyEstimate | null;
  transposeSemitones: number;
  capoFret: number;
  chords: ChordEvent[];
  lyrics: LyricLine[];
  structure: SongStructureSegment[];
  onClose: () => void;
  onExportHtml: (input: LeadSheetInput) => void;
}

export const LeadSheetModal: React.FC<Props> = ({
  open,
  songName,
  bpm,
  keyEst,
  transposeSemitones,
  capoFret,
  chords,
  lyrics,
  structure,
  onClose,
  onExportHtml,
}) => {
  const adjustedChords = useMemo(
    () =>
      chords.map((c) => {
        const sounding = transposeChordSymbol(c.symbol, transposeSemitones);
        const shape = capoFret > 0 ? transposeChordSymbol(sounding, -capoFret) : sounding;
        return { ...c, symbol: shape };
      }),
    [chords, transposeSemitones, capoFret]
  );

  const uniqueChords = useMemo(
    () => Array.from(new Set(adjustedChords.map((c) => c.symbol))),
    [adjustedChords]
  );

  if (!open) return null;

  const cleanTitle = (songName || "StemScribe 弹唱谱").replace(/\.(wav|mp3|flac|m4a|ogg)$/i, "");
  const keyLabel = keyEst?.label ?? "未检测调性";

  const payload: LeadSheetInput = {
    title: cleanTitle,
    key_label: keyLabel,
    bpm,
    capo_fret: capoFret,
    chords: adjustedChords,
    lyrics,
    structure,
  };

  let lastSectionId = "";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 155,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 820, maxWidth: "95vw", maxHeight: "90vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <div className="card-title">
            <FileText size={16} /> A4 吉他弹唱谱 / 和弦歌词谱排版预览
          </div>
          <div className="row">
            <button className="btn btn-sm" onClick={() => window.print()}>
              <Printer size={13} /> 直接打印 / 存为 PDF
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => onExportHtml(payload)}>
              <Download size={13} /> 导出独立 A4 HTML 谱纸
            </button>
            <button className="btn btn-sm" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Printable A4 Sheet Preview */}
        <div
          style={{
            background: "#ffffff",
            color: "#111827",
            borderRadius: 10,
            padding: "28px 34px",
            boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
          }}
        >
          <div
            style={{
              borderBottom: "2px solid #111827",
              paddingBottom: 12,
              marginBottom: 16,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
            }}
          >
            <div>
              <h2 style={{ margin: 0, fontSize: 22 }}>{cleanTitle}</h2>
              <div style={{ fontSize: 12.5, color: "#4b5563", marginTop: 4 }}>
                调性：{keyLabel} · 速度：{bpm.toFixed(0)} BPM ·{" "}
                {capoFret > 0 ? `变调夹夹 ${capoFret} 品（以下为夹后指法和弦）` : "原调不夹 (Capo 0)"}
              </div>
            </div>
            <span style={{ fontSize: 12, color: "#6b7280" }}>StemScribe A4 弹唱谱</span>
          </div>

          {uniqueChords.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
              {uniqueChords.map((sym) => (
                <span
                  key={sym}
                  style={{
                    padding: "4px 12px",
                    borderRadius: 6,
                    border: "1px solid #d1d5db",
                    background: "#f3f4f6",
                    fontWeight: 700,
                    fontSize: 13.5,
                  }}
                >
                  {sym}
                </span>
              ))}
            </div>
          )}

          {lyrics.length === 0 ? (
            <div>
              <div
                style={{
                  display: "inline-block",
                  padding: "2px 10px",
                  borderRadius: 999,
                  background: "#e0e7ff",
                  color: "#3730a3",
                  fontSize: 12,
                  fontWeight: 700,
                  marginBottom: 10,
                }}
              >
                全曲和弦走向（暂无歌词，可在「歌词」页签一键提取后自动对齐）
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 15, fontWeight: 700, color: "#2563eb" }}>
                {adjustedChords.map((c, idx) => (
                  <span key={idx}>
                    [{c.symbol}] <span style={{ fontWeight: 400, color: "#6b7280", fontSize: 12 }}>{c.start_sec.toFixed(0)}s</span>
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div>
              {lyrics.map((line, idx) => {
                const seg = structure.find(
                  (s) => line.start_sec >= s.start_sec && line.start_sec < s.end_sec
                );
                const showSegHeader = Boolean(seg && seg.id !== lastSectionId);
                if (seg) lastSectionId = seg.id;

                const lineChords = adjustedChords.filter(
                  (c) => c.end_sec > line.start_sec && c.start_sec < line.end_sec
                );

                return (
                  <div key={idx} style={{ marginBottom: 12 }}>
                    {showSegHeader && seg && (
                      <div
                        style={{
                          display: "inline-block",
                          padding: "2px 10px",
                          borderRadius: 999,
                          background: "#e0e7ff",
                          color: "#3730a3",
                          fontSize: 12,
                          fontWeight: 700,
                          margin: "8px 0 6px",
                        }}
                      >
                        {seg.label}
                      </div>
                    )}
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#2563eb", minHeight: 18 }}>
                      {lineChords.map((c) => `[${c.symbol}]`).join("   ")}
                    </div>
                    <div style={{ fontSize: 15.5, color: "#111827" }}>{line.text}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
