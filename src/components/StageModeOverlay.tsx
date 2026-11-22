import React, { useEffect, useMemo, useState } from "react";
import { Pause, Play, Repeat, SkipBack, SkipForward, X } from "lucide-react";
import { transposeChordSymbol } from "../lib/musicTheory";
import type { ChordEvent, LyricLine, Setlist, SongStructureSegment } from "../types/music";

interface Props {
  open: boolean;
  songTitle: string;
  isPlaying: boolean;
  currentTime: number;
  durationSec: number;
  bpm: number;
  playbackRate: number;
  transposeSemitones: number;
  capoFret: number;
  loopEnabled: boolean;
  chords: ChordEvent[];
  lyrics: LyricLine[];
  structure: SongStructureSegment[];
  activeSetlist: Setlist | null;
  activeSetlistIndex: number;
  onClose: () => void;
  onTogglePlay: () => void;
  onRateChange: (r: number) => void;
  onCapoChange: (fret: number) => void;
  onToggleLoop: () => void;
  onJumpSetlistSong: (nextIndex: number) => void;
}

export const StageModeOverlay: React.FC<Props> = ({
  open,
  songTitle,
  isPlaying,
  currentTime,
  durationSec,
  bpm,
  playbackRate,
  transposeSemitones,
  capoFret,
  loopEnabled,
  chords,
  lyrics,
  structure,
  activeSetlist,
  activeSetlistIndex,
  onClose,
  onTogglePlay,
  onRateChange,
  onCapoChange,
  onToggleLoop,
  onJumpSetlistSong,
}) => {
  const [textScale, setTextScale] = useState<number>(1.0);
  const [mirrorMode, setMirrorMode] = useState<boolean>(false);
  const activeChordIdx = useMemo(
    () => chords.findIndex((c) => currentTime >= c.start_sec && currentTime < c.end_sec),
    [chords, currentTime]
  );
  const currentChord = activeChordIdx >= 0 ? chords[activeChordIdx] : chords[0] ?? null;
  const nextChord =
    activeChordIdx >= 0 && activeChordIdx + 1 < chords.length
      ? chords[activeChordIdx + 1]
      : null;

  const activeLyricIdx = useMemo(
    () => lyrics.findIndex((l) => currentTime >= l.start_sec && currentTime <= l.end_sec),
    [lyrics, currentTime]
  );

  const activeSection = useMemo(
    () => structure.find((s) => currentTime >= s.start_sec && currentTime < s.end_sec),
    [structure, currentTime]
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft" && activeSetlist && activeSetlistIndex > 0) {
        onJumpSetlistSong(activeSetlistIndex - 1);
      } else if (
        e.key === "ArrowRight" &&
        activeSetlist &&
        activeSetlistIndex >= 0 &&
        activeSetlistIndex + 1 < activeSetlist.items.length
      ) {
        onJumpSetlistSong(activeSetlistIndex + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, activeSetlist, activeSetlistIndex, onJumpSetlistSong]);

  if (!open) return null;

  const beatPhase = bpm > 0 ? Math.floor(currentTime / (60 / bpm)) % 4 : 0;
  const displayChord = (sym: string) => {
    const sounding = transposeChordSymbol(sym, transposeSemitones);
    return capoFret > 0 ? transposeChordSymbol(sounding, -capoFret) : sounding;
  };
  const chordProgress =
    currentChord && currentChord.end_sec > currentChord.start_sec
      ? Math.max(
          0,
          Math.min(
            1,
            (currentTime - currentChord.start_sec) /
              (currentChord.end_sec - currentChord.start_sec)
          )
        )
      : 0;

  const hasPrevSong = Boolean(activeSetlist && activeSetlistIndex > 0);
  const hasNextSong = Boolean(
    activeSetlist && activeSetlistIndex >= 0 && activeSetlistIndex + 1 < activeSetlist.items.length
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "radial-gradient(circle at 50% 20%, #1e293b 0%, #090b10 72%)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "28px 40px",
        color: "#f8fafc",
      }}
    >
      {/* Top Stage Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="row" style={{ gap: 12 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: 1.5,
              textTransform: "uppercase",
              color: "#60a5fa",
            }}
          >
            STAGE MODE · 演出提词器
          </span>
          <span style={{ fontSize: 16, fontWeight: 600 }}>{songTitle || "未命名曲目"}</span>
          {activeSetlist && activeSetlist.items.length > 0 && (
            <span className="badge ok">
              歌单：{activeSetlist.name} ({activeSetlistIndex + 1}/{activeSetlist.items.length})
            </span>
          )}
          {activeSection && (
            <span
              style={{
                padding: "4px 12px",
                borderRadius: 999,
                background: "rgba(244, 63, 94, 0.2)",
                border: "1px solid rgba(244, 63, 94, 0.55)",
                color: "#fda4af",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {activeSection.label}
            </span>
          )}
        </div>

        <div className="row" style={{ gap: 14 }}>
          <div className="row" style={{ gap: 6 }}>
            {[0, 1, 2, 3].map((b) => (
              <div
                key={b}
                style={{
                  width: b === 0 ? 14 : 11,
                  height: b === 0 ? 14 : 11,
                  borderRadius: "50%",
                  background:
                    isPlaying && beatPhase === b
                      ? b === 0
                        ? "#f43f5e"
                        : "#38bdf8"
                      : "rgba(255,255,255,0.16)",
                  boxShadow:
                    isPlaying && beatPhase === b
                      ? `0 0 14px ${b === 0 ? "#f43f5e" : "#38bdf8"}`
                      : "none",
                  transition: "all 0.08s",
                }}
              />
            ))}
            <span className="muted" style={{ marginLeft: 4 }}>
              {bpm.toFixed(0)} BPM
            </span>
          </div>

          <div className="row" style={{ gap: 6 }}>
            <button
              className="btn btn-sm"
              onClick={() => setTextScale((s) => Math.max(0.8, Number((s - 0.1).toFixed(1))))}
              title="缩小提词字号"
            >
              A-
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setTextScale((s) => Math.min(1.3, Number((s + 0.1).toFixed(1))))}
              title="放大提词字号"
            >
              A+
            </button>
            <button
              className={`btn btn-sm ${mirrorMode ? "btn-active" : ""}`}
              onClick={() => setMirrorMode((v) => !v)}
              title="实体玻璃提词器水平镜像翻转"
            >
              镜像
            </button>
          </div>

          <button className="btn" onClick={onClose} title="退出演出模式 (F / Esc)">
            <X size={16} /> 退出演出模式
          </button>
        </div>
      </div>

      {/* Center Stage: Giant Chord + Next Chord + Karaoke Lyrics */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 28,
          maxWidth: 960,
          width: "100%",
          transform: `${mirrorMode ? "scaleX(-1) " : ""}scale(${textScale})`,
          transition: "transform 0.15s ease",
          margin: "0 auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
          <div
            style={{
              minWidth: 260,
              padding: "28px 44px",
              borderRadius: 20,
              background: "rgba(59, 130, 246, 0.14)",
              border: "2px solid rgba(96, 165, 250, 0.65)",
              textAlign: "center",
              boxShadow: "0 20px 50px rgba(37, 99, 235, 0.22)",
            }}
          >
            <div style={{ fontSize: 13, color: "#93c5fd", marginBottom: 6 }}>
              当前和弦 {capoFret > 0 ? `（变调夹 ${capoFret} 品指法）` : ""}
            </div>
            <div style={{ fontSize: 84, fontWeight: 800, lineHeight: 1.05, letterSpacing: -1 }}>
              {currentChord ? displayChord(currentChord.symbol) : "—"}
            </div>
            <div
              style={{
                marginTop: 16,
                height: 6,
                borderRadius: 3,
                background: "rgba(255,255,255,0.12)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${Math.round(chordProgress * 100)}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, #38bdf8, #3b82f6)",
                }}
              />
            </div>
          </div>

          <div
            style={{
              minWidth: 160,
              padding: "20px 28px",
              borderRadius: 16,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.12)",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>下一个和弦</div>
            <div style={{ fontSize: 42, fontWeight: 700, color: "#cbd5e1" }}>
              {nextChord ? displayChord(nextChord.symbol) : "结束"}
            </div>
          </div>
        </div>

        <div
          style={{
            width: "100%",
            textAlign: "center",
            minHeight: 140,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 12,
          }}
        >
          {lyrics.length === 0 ? (
            <div style={{ fontSize: 20, color: "#64748b" }}>
              暂无歌词时间轴 · 可在主界面「歌词」页签一键提取人声歌词
            </div>
          ) : (
            <>
              <div style={{ fontSize: 18, color: "#64748b", minHeight: 26 }}>
                {activeLyricIdx > 0 ? lyrics[activeLyricIdx - 1].text : ""}
              </div>
              <div
                style={{
                  fontSize: 34,
                  fontWeight: 700,
                  color: "#ffffff",
                  textShadow: "0 4px 24px rgba(59, 130, 246, 0.45)",
                  lineHeight: 1.35,
                }}
              >
                {activeLyricIdx >= 0 ? lyrics[activeLyricIdx].text : lyrics[0].text}
              </div>
              <div style={{ fontSize: 20, color: "#94a3b8", minHeight: 28 }}>
                {activeLyricIdx >= 0 && activeLyricIdx + 1 < lyrics.length
                  ? lyrics[activeLyricIdx + 1].text
                  : activeLyricIdx < 0 && lyrics.length > 1
                  ? lyrics[1].text
                  : ""}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Bottom Transport HUD */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 20px",
          borderRadius: 14,
          background: "rgba(15, 23, 42, 0.85)",
          border: "1px solid rgba(255,255,255,0.12)",
        }}
      >
        <div className="row" style={{ gap: 10 }}>
          {activeSetlist && (
            <button
              className="btn btn-sm"
              disabled={!hasPrevSong}
              onClick={() => onJumpSetlistSong(activeSetlistIndex - 1)}
            >
              <SkipBack size={14} /> 上一首
            </button>
          )}
          <button className="btn btn-primary" onClick={onTogglePlay}>
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            {isPlaying ? "暂停 (Space)" : "开始演奏 (Space)"}
          </button>
          {activeSetlist && (
            <button
              className="btn btn-sm"
              disabled={!hasNextSong}
              onClick={() => onJumpSetlistSong(activeSetlistIndex + 1)}
            >
              下一首 <SkipForward size={14} />
            </button>
          )}
          <span className="muted" style={{ fontSize: 14, color: "#e2e8f0" }}>
            {currentTime.toFixed(1)}s / {durationSec.toFixed(1)}s
          </span>
        </div>

        <div className="row" style={{ gap: 12 }}>
          <button
            className={`btn btn-sm ${loopEnabled ? "btn-active" : ""}`}
            onClick={onToggleLoop}
          >
            <Repeat size={13} /> A-B 循环
          </button>
          <span className="muted">倍速</span>
          {[0.75, 0.85, 1.0].map((r) => (
            <button
              key={r}
              className={`btn btn-sm ${Math.abs(playbackRate - r) < 0.01 ? "btn-active" : ""}`}
              onClick={() => onRateChange(r)}
            >
              {Math.round(r * 100)}%
            </button>
          ))}
          <span className="muted">变调夹</span>
          <button
            className="btn btn-sm"
            onClick={() => onCapoChange(Math.max(0, capoFret - 1))}
          >
            -
          </button>
          <span style={{ minWidth: 36, textAlign: "center", fontWeight: 600 }}>
            {capoFret}品
          </span>
          <button
            className="btn btn-sm"
            onClick={() => onCapoChange(Math.min(9, capoFret + 1))}
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
};
