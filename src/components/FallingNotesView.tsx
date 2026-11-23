import React, { useEffect, useRef, useState } from "react";

import { t } from "../i18n";
import { NOTE_NAMES_FLAT, NOTE_NAMES_SHARP } from "../lib/musicTheory";
import type { MidiNote } from "../types/music";

interface Props {
  notes: MidiNote[];
  currentTime: number;
  bpm: number;
  pressedHardwareNotes: number[];
  scalePitchClasses?: number[];
  useFlats?: boolean;
  onAuditionNote: (midiPitch: number) => void;
}

const MIN_MIDI = 48; // C3
const MAX_MIDI = 95; // B6
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);

type HandFilter = "both" | "right" | "left";

export const FallingNotesView: React.FC<Props> = ({
  notes,
  currentTime,
  bpm,
  pressedHardwareNotes,
  scalePitchClasses,
  useFlats,
  onAuditionNote,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [lookaheadSec, setLookaheadSec] = useState<number>(4);
  const [showLabels, setShowLabels] = useState<boolean>(true);
  const [handSplitMode, setHandSplitMode] = useState<boolean>(true);
  const [splitMidi, setSplitMidi] = useState<number>(60); // Middle C (C4)
  const [handFilter, setHandFilter] = useState<HandFilter>("both");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const keyH = 74;
    const laneH = H - keyH;

    // Background
    const bg = ctx.createLinearGradient(0, 0, 0, laneH);
    bg.addColorStop(0, "#090d16");
    bg.addColorStop(1, "#111827");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Precompute key X positions for C3..B6 (28 white keys)
    const whiteKeys: number[] = [];
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      if (!BLACK_PCS.has(m % 12)) whiteKeys.push(m);
    }
    const whiteW = W / whiteKeys.length;
    const keyGeom = new Map<number, { x: number; w: number; isBlack: boolean }>();

    let wIdx = 0;
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      const isBlack = BLACK_PCS.has(m % 12);
      if (!isBlack) {
        keyGeom.set(m, { x: wIdx * whiteW, w: whiteW, isBlack: false });
        wIdx++;
      } else {
        const bw = whiteW * 0.62;
        keyGeom.set(m, { x: wIdx * whiteW - bw / 2, w: bw, isBlack: true });
      }
    }

    // Subtle octave grid lines
    ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
    ctx.lineWidth = 1;
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      if (m % 12 === 0) {
        const g = keyGeom.get(m);
        if (g) {
          ctx.beginPath();
          ctx.moveTo(g.x, 0);
          ctx.lineTo(g.x, laneH);
          ctx.stroke();
        }
      }
    }

    // Left / Right hand split guide line
    if (handSplitMode) {
      const sg = keyGeom.get(splitMidi);
      if (sg) {
        ctx.save();
        ctx.strokeStyle = "rgba(16, 185, 129, 0.45)";
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(sg.x, 0);
        ctx.lineTo(sg.x, laneH);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Horizontal beat grid lines
    const beatSec = 60 / Math.max(40, bpm);
    const firstBeat = Math.ceil(currentTime / beatSec);
    const lastBeat = Math.floor((currentTime + lookaheadSec) / beatSec);
    for (let b = firstBeat; b <= lastBeat; b++) {
      const t = b * beatSec;
      const y = laneH - ((t - currentTime) / lookaheadSec) * laneH;
      ctx.strokeStyle = b % 4 === 0 ? "rgba(96, 165, 250, 0.22)" : "rgba(148, 163, 184, 0.08)";
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    const scaleSet = new Set(scalePitchClasses ?? []);
    const activeMidiSet = new Set<number>();

    // Render falling note bars
    for (const n of notes) {
      if (n.end_sec < currentTime - 0.1 || n.start_sec > currentTime + lookaheadSec) continue;
      const isLeftHand = n.pitch < splitMidi;
      if (handFilter === "left" && !isLeftHand) continue;
      if (handFilter === "right" && isLeftHand) continue;

      const g = keyGeom.get(n.pitch);
      if (!g) continue;

      const yBottom = laneH - ((n.start_sec - currentTime) / lookaheadSec) * laneH;
      const yTop = laneH - ((n.end_sec - currentTime) / lookaheadSec) * laneH;
      const top = Math.max(0, yTop);
      const bottom = Math.min(laneH, yBottom);
      const h = Math.max(6, bottom - top);

      const isHitting = currentTime >= n.start_sec && currentTime <= n.end_sec + 0.06;
      if (isHitting) activeMidiSet.add(n.pitch);

      const inScale = scaleSet.size === 0 || scaleSet.has(n.pitch % 12);
      let fill: string;
      if (isHitting) {
        fill = isLeftHand && handSplitMode ? "#34d399" : "#38bdf8";
      } else if (handSplitMode) {
        if (isLeftHand) {
          fill = g.isBlack ? "#059669" : "#10b981";
        } else {
          fill = g.isBlack ? "#818cf8" : "#3b82f6";
        }
      } else {
        fill = g.isBlack ? "#818cf8" : inScale ? "#3b82f6" : "#f59e0b";
      }

      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(g.x + 1.5, top, Math.max(4, g.w - 3), h, 4);
      ctx.fill();

      if (isHitting) {
        ctx.shadowColor = isLeftHand && handSplitMode ? "#34d399" : "#38bdf8";
        ctx.shadowBlur = 14;
        ctx.fillRect(g.x + 1, laneH - 4, g.w - 2, 4);
        ctx.shadowBlur = 0;
      }

      if (showLabels && h >= 18) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "600 10px -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText((useFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP)[n.pitch % 12], g.x + g.w / 2, bottom - 5);
      }
    }

    // Glowing strike line
    ctx.fillStyle = "rgba(56, 189, 248, 0.55)";
    ctx.fillRect(0, laneH - 2, W, 2);

    const hwSet = new Set(pressedHardwareNotes);

    // Draw bottom piano keyboard (whites first, then blacks)
    for (const m of whiteKeys) {
      const g = keyGeom.get(m)!;
      const isHw = hwSet.has(m);
      const isHit = activeMidiSet.has(m);
      ctx.fillStyle = isHw
        ? "#22c55e"
        : isHit
        ? m < splitMidi && handSplitMode
          ? "#34d399"
          : "#38bdf8"
        : "#f8fafc";
      ctx.fillRect(g.x, laneH, g.w - 1, keyH);
      ctx.strokeStyle = "#94a3b8";
      ctx.strokeRect(g.x, laneH, g.w - 1, keyH);
      if (m % 12 === 0) {
        ctx.fillStyle = isHw || isHit ? "#fff" : "#475569";
        ctx.font = "700 10px -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(`C${Math.floor(m / 12) - 1}`, g.x + g.w / 2, H - 8);
      }
    }

    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      if (!BLACK_PCS.has(m % 12)) continue;
      const g = keyGeom.get(m)!;
      const isHw = hwSet.has(m);
      const isHit = activeMidiSet.has(m);
      ctx.fillStyle = isHw
        ? "#16a34a"
        : isHit
        ? m < splitMidi && handSplitMode
          ? "#059669"
          : "#2563eb"
        : "#1e293b";
      ctx.fillRect(g.x, laneH, g.w, keyH * 0.62);
      ctx.strokeStyle = "#0f172a";
      ctx.strokeRect(g.x, laneH, g.w, keyH * 0.62);
    }
  }, [
    notes,
    currentTime,
    bpm,
    pressedHardwareNotes,
    scalePitchClasses,
    useFlats,
    lookaheadSec,
    showLabels,
    handSplitMode,
    splitMidi,
    handFilter,
  ]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const whiteKeys: number[] = [];
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      if (!BLACK_PCS.has(m % 12)) whiteKeys.push(m);
    }
    const idx = Math.max(
      0,
      Math.min(whiteKeys.length - 1, Math.floor(relX / (canvas.width / whiteKeys.length)))
    );
    onAuditionNote(whiteKeys[idx]);
  };

  return (
    <div className="card">
      <div className="card-header" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="card-title" title={t("falling.titleTip")}>
          {t("falling.title")}
          <span className="badge">{t("common.notes", { count: notes.length })}</span>
        </div>

        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <button
            className={`btn btn-sm ${handSplitMode ? "btn-active" : ""}`}
            onClick={() => setHandSplitMode((v) => !v)}
            title={t("falling.splitTip")}
          >
            {t("falling.split")}
          </button>
          <select
            className="select"
            value={splitMidi}
            onChange={(e) => setSplitMidi(Number(e.target.value))}
            style={{ width: 92, height: 24, padding: "0 20px 0 8px", fontSize: 11 }}
            title={t("falling.splitKeyTip")}
          >
            <option value={55}>{t("falling.splitAt", { note: "G3" })}</option>
            <option value={60}>{t("falling.splitAt", { note: "C4" })}</option>
            <option value={64}>{t("falling.splitAt", { note: "E4" })}</option>
          </select>
          <div className="seg">
            {(
              [
                { id: "both", label: t("falling.both") },
                { id: "right", label: t("falling.rightOnly") },
                { id: "left", label: t("falling.leftOnly") },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                className={handFilter === opt.id ? "on" : ""}
                onClick={() => setHandFilter(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <span className="muted">{t("falling.view")}</span>
          <div className="seg">
            {[2, 4, 6].map((sec) => (
              <button
                key={sec}
                className={lookaheadSec === sec ? "on" : ""}
                onClick={() => setLookaheadSec(sec)}
              >
                {sec}s
              </button>
            ))}
          </div>
          <button
            className={`btn btn-sm ${showLabels ? "btn-active" : ""}`}
            onClick={() => setShowLabels((v) => !v)}
          >
            {t("falling.noteNames")}
          </button>
        </div>
      </div>

      <canvas
        ref={canvasRef}
        width={920}
        height={320}
        onClick={handleCanvasClick}
        style={{
          width: "100%",
          height: 300,
          borderRadius: 10,
          border: "1px solid var(--border)",
          cursor: "pointer",
          display: "block",
        }}
      />
      <div className="muted" style={{ marginTop: 6 }}>
        {t("falling.hint")}
      </div>
    </div>
  );
};
