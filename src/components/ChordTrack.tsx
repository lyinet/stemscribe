import React, { useState } from "react";
import { Music, Plus, Trash2, Volume2 } from "lucide-react";
import { chordToRomanNumeral, parseChordSymbol, transposeChordSymbol } from "../lib/musicTheory";
import type { ChordEvent } from "../types/music";

interface Props {
  chords: ChordEvent[];
  durationSec: number;
  currentTime: number;
  transposeSemitones: number;
  useFlats?: boolean;
  keyTonic?: string;
  keyMode?: string;
  detecting: boolean;
  onDetectChords: () => void;
  onChordsChange: (next: ChordEvent[]) => void;
  onSeek: (sec: number) => void;
  onAuditionChord?: (symbol: string) => void;
}

const GUITAR_SHAPES: Record<string, number[]> = {
  C: [-1, 3, 2, 0, 1, 0],
  Cm: [-1, 3, 5, 5, 4, 3],
  C7: [-1, 3, 2, 3, 1, 0],
  Cmaj7: [-1, 3, 2, 0, 0, 0],
  D: [-1, -1, 0, 2, 3, 2],
  Dm: [-1, -1, 0, 2, 3, 1],
  D7: [-1, -1, 0, 2, 1, 2],
  Dm7: [-1, -1, 0, 2, 1, 1],
  E: [0, 2, 2, 1, 0, 0],
  Em: [0, 2, 2, 0, 0, 0],
  E7: [0, 2, 0, 1, 0, 0],
  Em7: [0, 2, 0, 0, 0, 0],
  F: [1, 3, 3, 2, 1, 1],
  Fm: [1, 3, 3, 1, 1, 1],
  F7: [1, 3, 1, 2, 1, 1],
  Fmaj7: [-1, -1, 3, 2, 1, 0],
  G: [3, 2, 0, 0, 0, 3],
  Gm: [3, 5, 5, 3, 3, 3],
  G7: [3, 2, 0, 0, 0, 1],
  A: [-1, 0, 2, 2, 2, 0],
  Am: [-1, 0, 2, 2, 1, 0],
  A7: [-1, 0, 2, 0, 2, 0],
  Am7: [-1, 0, 2, 0, 1, 0],
  B: [-1, 2, 4, 4, 4, 2],
  Bm: [-1, 2, 4, 4, 3, 2],
  B7: [-1, 2, 1, 2, 0, 2],
  Bb: [-1, 1, 3, 3, 3, 1],
  Eb: [-1, -1, 1, 3, 4, 3],
  Ab: [4, 6, 6, 5, 4, 4],
  "F#": [2, 4, 4, 3, 2, 2],
  "F#m": [2, 4, 4, 2, 2, 2],
  "C#m": [-1, 4, 6, 6, 5, 4],
};

// Lookup keyed by pitch-class + suffix so flat spellings (Bb, Eb, Db...) resolve too.
const SHAPES_BY_PC: Record<string, number[]> = {};
for (const [sym, frets] of Object.entries(GUITAR_SHAPES)) {
  const p = parseChordSymbol(sym);
  if (p) SHAPES_BY_PC[`${p.rootPc}${p.suffix}`] = frets;
}

function lookupGuitarShape(symbol: string): number[] | undefined {
  const p = parseChordSymbol(symbol);
  if (!p) return GUITAR_SHAPES[symbol];
  return SHAPES_BY_PC[`${p.rootPc}${p.suffix}`];
}

const GuitarChordSvg: React.FC<{ symbol: string }> = ({ symbol }) => {
  const frets = lookupGuitarShape(symbol);
  if (!frets) return null;

  const positive = frets.filter((f) => f > 0);
  const minFret = positive.length > 0 ? Math.min(...positive) : 1;
  const maxFret = positive.length > 0 ? Math.max(...positive) : 4;
  const baseFret = maxFret > 4 ? minFret : 1;

  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "4px 8px",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        minWidth: 74,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{symbol}</div>
      <svg width="58" height="62" viewBox="0 0 58 62">
        <line
          x1="8"
          y1="14"
          x2="48"
          y2="14"
          stroke="#e5e7eb"
          strokeWidth={baseFret === 1 ? 2.4 : 1}
        />
        {baseFret > 1 && (
          <text x="50" y="23" fontSize="8" fill="#9aa3b2">
            {baseFret}f
          </text>
        )}
        {[1, 2, 3, 4].map((f) => (
          <line
            key={f}
            x1="8"
            y1={14 + f * 11}
            x2="48"
            y2={14 + f * 11}
            stroke="#4b5563"
            strokeWidth="0.9"
          />
        ))}
        {[0, 1, 2, 3, 4, 5].map((s) => (
          <line
            key={s}
            x1={8 + s * 8}
            y1="14"
            x2={8 + s * 8}
            y2="58"
            stroke="#6b7280"
            strokeWidth="0.9"
          />
        ))}
        {frets.map((fret, sIdx) => {
          const x = 8 + sIdx * 8;
          if (fret < 0) {
            return (
              <text key={sIdx} x={x} y="10" textAnchor="middle" fontSize="8" fill="#9aa3b2">
                x
              </text>
            );
          }
          if (fret === 0) {
            return (
              <circle
                key={sIdx}
                cx={x}
                cy="7"
                r="2.5"
                fill="none"
                stroke="#93c5fd"
                strokeWidth="1"
              />
            );
          }
          const rel = fret - baseFret + 1;
          if (rel >= 1 && rel <= 4) {
            return (
              <circle key={sIdx} cx={x} cy={14 + rel * 11 - 5.5} r="3.2" fill="#3b82f6" />
            );
          }
          return null;
        })}
      </svg>
    </div>
  );
};

export const ChordTrack: React.FC<Props> = ({
  chords,
  durationSec,
  currentTime,
  transposeSemitones,
  useFlats,
  keyTonic,
  keyMode,
  detecting,
  onDetectChords,
  onChordsChange,
  onSeek,
  onAuditionChord,
}) => {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [draftSymbol, setDraftSymbol] = useState("");
  const [showRoman, setShowRoman] = useState(true);

  const activeChord = chords.find((c) => currentTime >= c.start_sec && currentTime < c.end_sec);
  const displayActive = activeChord
    ? transposeChordSymbol(activeChord.symbol, transposeSemitones, useFlats)
    : chords.length > 0
      ? transposeChordSymbol(chords[0].symbol, transposeSemitones, useFlats)
      : "";

  const commitEdit = (idx: number) => {
    const cleaned = draftSymbol.trim();
    if (cleaned) {
      const next = [...chords];
      next[idx] = { ...next[idx], symbol: cleaned };
      onChordsChange(next);
    }
    setEditingIdx(null);
  };

  return (
    <div className="card" style={{ padding: "10px 14px" }}>
      <div className="card-header" style={{ marginBottom: 8 }}>
        <div className="card-title" title="和弦轨与吉他指法图">
          <Music size={14} /> 和弦
          {displayActive && (
            <span className="badge ok" style={{ fontSize: 12, fontWeight: 600 }}>
              当前：{displayActive}
            </span>
          )}
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {displayActive && onAuditionChord && (
            <button
              className="btn btn-sm"
              onClick={() => onAuditionChord(displayActive)}
              title={`扫弦试听当前和弦 ${displayActive}`}
            >
              <Volume2 size={12} /> 试听 {displayActive}
            </button>
          )}
          {keyTonic && chords.length > 0 && (
            <button
              className={`btn btn-sm ${showRoman ? "btn-active" : ""}`}
              onClick={() => setShowRoman((v) => !v)}
              title="切换显示罗马数字级数（I / IV / V / vi）"
            >
              级数 (I–vi)
            </button>
          )}
          <button
            className="btn btn-sm"
            disabled={durationSec <= 0}
            onClick={() => {
              const start = Number(Math.max(0, currentTime).toFixed(2));
              const end = Number(Math.min(durationSec || start + 4, start + 4).toFixed(2));
              const next = [...chords, { start_sec: start, end_sec: Math.max(start + 0.5, end), symbol: "C", confidence: 1.0 }]
                .sort((a, b) => a.start_sec - b.start_sec);
              onChordsChange(next);
            }}
            title="在当前播放位置插入一个新和弦"
          >
            <Plus size={12} /> 加和弦
          </button>
          <button
            className="btn btn-sm"
            disabled={detecting || durationSec <= 0}
            onClick={onDetectChords}
          >
            {detecting ? "识别和弦中..." : chords.length > 0 ? "重新识别" : "识别全曲和弦"}
          </button>
        </div>
      </div>

      {chords.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          点击「识别全曲和弦」，无需联网即可用 Rust DSP 分析每段和弦走向，并实时显示对应的吉他指法图（支持双击手动修正）。
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {displayActive && <GuitarChordSvg symbol={displayActive} />}
          <div style={{ display: "flex", gap: 4, overflowX: "auto", paddingBottom: 4, flex: 1 }}>
            {chords.map((c, idx) => {
              const isNow = currentTime >= c.start_sec && currentTime < c.end_sec;
              const widthPct =
                durationSec > 0 ? ((c.end_sec - c.start_sec) / durationSec) * 100 : 12;
              const shown = transposeChordSymbol(c.symbol, transposeSemitones, useFlats);

              if (editingIdx === idx) {
                return (
                  <input
                    key={idx}
                    autoFocus
                    className="input"
                    value={draftSymbol}
                    onChange={(e) => setDraftSymbol(e.target.value)}
                    onBlur={() => commitEdit(idx)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(idx);
                      if (e.key === "Escape") setEditingIdx(null);
                    }}
                    style={{ width: 76, padding: "4px 6px", fontSize: 13 }}
                  />
                );
              }

              const roman = showRoman ? chordToRomanNumeral(c.symbol, keyTonic, keyMode) : "";
              return (
                <div
                  key={idx}
                  onClick={() => {
                    onSeek(c.start_sec);
                    onAuditionChord?.(shown);
                  }}
                  onDoubleClick={() => {
                    setEditingIdx(idx);
                    setDraftSymbol(c.symbol);
                  }}
                  title="单击跳转并试听 · 双击修改和弦名"
                  style={{
                    flex: `1 0 ${Math.max(64, Math.round(widthPct * 6))}px`,
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: isNow ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: isNow ? "var(--accent-soft)" : "var(--bg)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    position: "relative",
                  }}
                >
                  <div className="row" style={{ justifyContent: "space-between", gap: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{shown}</span>
                    {roman && (
                      <span style={{ fontSize: 10.5, color: "#38bdf8", fontWeight: 600 }}>
                        {roman}
                      </span>
                    )}
                  </div>
                  <div className="row" style={{ justifyContent: "space-between", marginTop: 2 }}>
                    <span className="muted" style={{ fontSize: 10.5 }}>
                      {c.start_sec.toFixed(1)}s
                    </span>
                    <Trash2
                      size={10}
                      style={{ opacity: 0.45 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onChordsChange(chords.filter((_, i) => i !== idx));
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
