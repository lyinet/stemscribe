import React, { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Filter, Sparkles, Trash2, Wand2 } from "lucide-react";
import type { MidiNote } from "../types/music";

interface Props {
  notes: MidiNote[];
  bpm: number;
  currentTime: number;
  scalePitchClasses?: number[];
  onChange: (nextNotes: MidiNote[]) => void;
}

const KEY_W = 54;
const ROW_H = 16;
const PX_PER_SEC = 120;
const MIN_PITCH = 40;
const MAX_PITCH = 84;
const NUM_ROWS = MAX_PITCH - MIN_PITCH + 1;
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
const NOTE_LABELS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function midiLabel(pitch: number): string {
  const octave = Math.floor(pitch / 12) - 1;
  return `${NOTE_LABELS[pitch % 12]}${octave}`;
}

function playPreviewTone(midiPitch: number) {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = 440 * Math.pow(2, (midiPitch - 69) / 12);
    gain.gain.setValueAtTime(0.14, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.23);
    setTimeout(() => ctx.close().catch(() => {}), 300);
  } catch {
    // Ignore autoplay errors
  }
}

type DragMode =
  | { kind: "move"; idx: number; offsetSec: number; startPitch: number }
  | { kind: "resize"; idx: number };

export const PianoRollEditor: React.FC<Props> = ({
  notes,
  bpm,
  currentTime,
  scalePitchClasses,
  onChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [snapDiv, setSnapDiv] = useState<number>(4);
  const [highlightScale, setHighlightScale] = useState<boolean>(true);
  const dragRef = useRef<DragMode | null>(null);

  const scaleSet = new Set(scalePitchClasses ?? []);
  const maxEnd = Math.max(10, ...notes.map((n) => n.end_sec + 1.5));
  const canvasW = Math.ceil(KEY_W + maxEnd * PX_PER_SEC);
  const canvasH = NUM_ROWS * ROW_H;

  const snapTime = (sec: number): number => {
    if (snapDiv <= 0) return Math.max(0, sec);
    const step = 60 / Math.max(40, bpm) / snapDiv;
    return Math.max(0, Math.round(sec / step) * step);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvasW, canvasH);

    for (let p = MAX_PITCH; p >= MIN_PITCH; p--) {
      const row = MAX_PITCH - p;
      const y = row * ROW_H;
      const isBlack = BLACK_KEYS.has(p % 12);
      const inScale = scaleSet.size > 0 && scaleSet.has(p % 12);

      if (highlightScale && scaleSet.size > 0) {
        ctx.fillStyle = inScale ? "#1b2434" : "#101319";
      } else {
        ctx.fillStyle = isBlack ? "#12151b" : "#181c24";
      }
      ctx.fillRect(KEY_W, y, canvasW - KEY_W, ROW_H);
      ctx.strokeStyle = "#232936";
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(KEY_W, y + ROW_H);
      ctx.lineTo(canvasW, y + ROW_H);
      ctx.stroke();

      ctx.fillStyle = isBlack ? "#1f2430" : "#e5e7eb";
      ctx.fillRect(0, y, KEY_W - 1, ROW_H - 0.5);
      if (highlightScale && inScale) {
        ctx.fillStyle = "#22c55e";
        ctx.fillRect(KEY_W - 5, y + 3, 3, ROW_H - 6);
      }
      if (p % 12 === 0 || p === MIN_PITCH) {
        ctx.fillStyle = isBlack ? "#e5e7eb" : "#111827";
        ctx.font = "10px -apple-system, sans-serif";
        ctx.fillText(midiLabel(p), 6, y + ROW_H - 4);
      }
    }

    const beatSec = 60 / Math.max(40, bpm);
    const subDiv = snapDiv > 0 ? snapDiv : 2;
    const stepSec = beatSec / subDiv;
    for (let t = 0; t <= maxEnd; t += stepSec) {
      const x = KEY_W + t * PX_PER_SEC;
      const beatIdx = Math.round(t / stepSec);
      const isBar = beatIdx % (subDiv * 4) === 0;
      const isBeat = beatIdx % subDiv === 0;
      ctx.strokeStyle = isBar ? "#3f4a61" : isBeat ? "#2b3344" : "#1e2430";
      ctx.lineWidth = isBar ? 1.2 : 0.8;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvasH);
      ctx.stroke();
    }

    notes.forEach((n, idx) => {
      if (n.pitch < MIN_PITCH || n.pitch > MAX_PITCH) return;
      const x = KEY_W + n.start_sec * PX_PER_SEC;
      const w = Math.max(10, (n.end_sec - n.start_sec) * PX_PER_SEC);
      const y = (MAX_PITCH - n.pitch) * ROW_H + 1;
      const h = ROW_H - 2;
      const isSel = idx === selectedIdx;
      const outOfScale = highlightScale && scaleSet.size > 0 && !scaleSet.has(n.pitch % 12);

      ctx.fillStyle = isSel ? "#60a5fa" : outOfScale ? "#f59e0b" : "#3b82f6";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = isSel ? "#ffffff" : outOfScale ? "#b45309" : "#1d4ed8";
      ctx.lineWidth = isSel ? 1.4 : 1;
      ctx.strokeRect(x, y, w, h);

      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.fillRect(x + w - 4, y + 2, 3, h - 4);

      if (w >= 26) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "10px -apple-system, sans-serif";
        ctx.fillText(midiLabel(n.pitch), x + 4, y + h - 3);
      }
    });

    const px = KEY_W + currentTime * PX_PER_SEC;
    ctx.strokeStyle = "#f43f5e";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, canvasH);
    ctx.stroke();
  }, [notes, bpm, currentTime, selectedIdx, snapDiv, highlightScale, scalePitchClasses, canvasW, canvasH, maxEnd]);

  const coordsFromEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const sec = Math.max(0, (x - KEY_W) / PX_PER_SEC);
    const pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, MAX_PITCH - Math.floor(y / ROW_H)));
    return { x, y, sec, pitch };
  };

  const hitTestNote = (x: number, pitch: number): { idx: number; isRightEdge: boolean } | null => {
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.pitch !== pitch) continue;
      const nx = KEY_W + n.start_sec * PX_PER_SEC;
      const nw = Math.max(10, (n.end_sec - n.start_sec) * PX_PER_SEC);
      if (x >= nx && x <= nx + nw) {
        return { idx: i, isRightEdge: x >= nx + nw - 7 };
      }
    }
    return null;
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, sec, pitch } = coordsFromEvent(e);
    if (x < KEY_W) {
      playPreviewTone(pitch);
      return;
    }

    const hit = hitTestNote(x, pitch);
    if (hit) {
      if (e.button === 2) {
        onChange(notes.filter((_, i) => i !== hit.idx));
        setSelectedIdx(null);
        return;
      }
      setSelectedIdx(hit.idx);
      playPreviewTone(notes[hit.idx].pitch);
      dragRef.current = hit.isRightEdge
        ? { kind: "resize", idx: hit.idx }
        : {
            kind: "move",
            idx: hit.idx,
            offsetSec: sec - notes[hit.idx].start_sec,
            startPitch: notes[hit.idx].pitch,
          };
    } else {
      setSelectedIdx(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { sec, pitch } = coordsFromEvent(e);
    const target = notes[drag.idx];
    if (!target) return;

    const updated = [...notes];
    if (drag.kind === "move") {
      const dur = target.end_sec - target.start_sec;
      const newStart = snapTime(sec - drag.offsetSec);
      if (pitch !== target.pitch) playPreviewTone(pitch);
      updated[drag.idx] = { ...target, pitch, start_sec: newStart, end_sec: newStart + dur };
      onChange(updated);
    } else if (drag.kind === "resize") {
      const newEnd = Math.max(target.start_sec + 0.08, snapTime(sec));
      updated[drag.idx] = { ...target, end_sec: newEnd };
      onChange(updated);
    }
  };

  const handleMouseUp = () => {
    dragRef.current = null;
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, sec, pitch } = coordsFromEvent(e);
    if (x < KEY_W || hitTestNote(x, pitch)) return;
    const start = snapTime(sec);
    const beatDur = 60 / Math.max(40, bpm) / 2;
    playPreviewTone(pitch);
    const next = [
      ...notes,
      { pitch, start_sec: start, end_sec: start + beatDur, velocity: 96, confidence: 1.0 },
    ].sort((a, b) => a.start_sec - b.start_sec);
    onChange(next);
  };

  const handleQuantizeAll = () => {
    if (notes.length === 0) return;
    const div = snapDiv > 0 ? snapDiv : 4;
    const step = 60 / Math.max(40, bpm) / div;
    const next = notes
      .map((n) => {
        const start = Math.max(0, Math.round(n.start_sec / step) * step);
        const dur = Math.max(step, Math.round((n.end_sec - n.start_sec) / step) * step);
        return { ...n, start_sec: start, end_sec: start + dur };
      })
      .sort((a, b) => a.start_sec - b.start_sec);
    onChange(next);
  };

  const handleSnapAllToScale = () => {
    if (notes.length === 0 || scaleSet.size === 0) return;
    const next = notes.map((n) => {
      const pc = ((n.pitch % 12) + 12) % 12;
      if (scaleSet.has(pc)) return n;
      for (let d = 1; d <= 6; d++) {
        if (scaleSet.has((pc + d) % 12) && n.pitch + d <= MAX_PITCH) {
          return { ...n, pitch: n.pitch + d };
        }
        if (scaleSet.has((pc - d + 12) % 12) && n.pitch - d >= MIN_PITCH) {
          return { ...n, pitch: n.pitch - d };
        }
      }
      return n;
    });
    onChange(next);
  };

  const handleRemoveShortNoise = () => {
    if (notes.length === 0) return;
    const filtered = notes.filter((n) => n.end_sec - n.start_sec >= 0.08);
    if (filtered.length !== notes.length) {
      setSelectedIdx(null);
      onChange(filtered);
    }
  };

  const handleShiftOctave = (deltaOctaves: number) => {
    if (notes.length === 0) return;
    const shift = deltaOctaves * 12;
    const next = notes.map((n) => ({
      ...n,
      pitch: Math.max(21, Math.min(108, n.pitch + shift)),
    }));
    onChange(next);
  };

  const selectedNote = selectedIdx !== null ? notes[selectedIdx] ?? null : null;

  return (
    <div>
      <div className="row" style={{ marginBottom: 8, justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <span className="muted">吸附网格</span>
          <div className="seg">
            {[
              { label: "关闭", val: 0 },
              { label: "1/4", val: 1 },
              { label: "1/8", val: 2 },
              { label: "1/16", val: 4 },
            ].map((opt) => (
              <button
                key={opt.val}
                className={snapDiv === opt.val ? "on" : ""}
                onClick={() => setSnapDiv(opt.val)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {scaleSet.size > 0 && (
            <label className="muted" style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={highlightScale}
                onChange={(e) => setHighlightScale(e.target.checked)}
              />
              调内音阶高亮（橙色=调外音）
            </label>
          )}
        </div>

        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <button
            className="btn btn-sm"
            disabled={notes.length === 0}
            onClick={handleQuantizeAll}
            title="按当前网格（关闭时默认 1/16）批量量化所有音符起点与时值"
          >
            <Wand2 size={12} /> 量化全部
          </button>
          {scaleSet.size > 0 && (
            <button
              className="btn btn-sm"
              disabled={notes.length === 0}
              onClick={handleSnapAllToScale}
              title="将所有橙色调外音就近吸附到当前歌曲调内音阶"
            >
              <Sparkles size={12} /> 调内修正
            </button>
          )}
          <button
            className="btn btn-sm"
            disabled={notes.length === 0}
            onClick={handleRemoveShortNoise}
            title="批量删除时值短于 80ms 的 AI 误检短杂音"
          >
            <Filter size={12} /> 去杂音
          </button>
          <button
            className="btn btn-sm"
            disabled={notes.length === 0}
            onClick={() => handleShiftOctave(-1)}
            title="全部音符整体降一个八度"
          >
            <ArrowDown size={12} /> 8va
          </button>
          <button
            className="btn btn-sm"
            disabled={notes.length === 0}
            onClick={() => handleShiftOctave(1)}
            title="全部音符整体升一个八度"
          >
            <ArrowUp size={12} /> 8va
          </button>
          {selectedNote && selectedIdx !== null && (
            <label className="muted" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
              力度 {selectedNote.velocity}
              <input
                type="range"
                min={20}
                max={127}
                value={selectedNote.velocity}
                onChange={(e) => {
                  const vel = Number(e.target.value);
                  const next = [...notes];
                  next[selectedIdx] = { ...selectedNote, velocity: vel };
                  onChange(next);
                }}
                style={{ width: 64 }}
              />
            </label>
          )}
          <button
            className="btn btn-sm"
            disabled={selectedIdx === null}
            onClick={() => {
              if (selectedIdx === null) return;
              onChange(notes.filter((_, i) => i !== selectedIdx));
              setSelectedIdx(null);
            }}
          >
            <Trash2 size={12} /> 删除选中
          </button>
        </div>
      </div>

      <div
        style={{
          overflow: "auto",
          maxHeight: 310,
          borderRadius: 10,
          border: "1px solid var(--border)",
          background: "#0f1115",
        }}
      >
        <canvas
          ref={canvasRef}
          width={canvasW}
          height={canvasH}
          style={{ display: "block", cursor: "crosshair" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onDoubleClick={handleDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
    </div>
  );
};
