import React, { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Drum, Sparkles, Trash2 } from "lucide-react";
import type { DrumHit } from "../types/music";

interface Props {
  hits: DrumHit[];
  bpm: number;
  currentTime: number;
  durationSec: number;
  hasDrumStem: boolean;
  loading: boolean;
  onDetectDrums: () => void;
  onChangeHits: (next: DrumHit[]) => void;
  onExportDrumMidi: () => void;
}

const MIDI_MAP: Record<"hihat" | "snare" | "kick", number> = {
  hihat: 42,
  snare: 38,
  kick: 36,
};

const GROOVE_PRESETS: Array<{
  id: string;
  label: string;
  kick: number[];
  snare: number[];
  hihat: number[];
}> = [
  {
    id: "pop",
    label: "Pop 8-Beat",
    kick: [0, 8, 10],
    snare: [4, 12],
    hihat: [0, 2, 4, 6, 8, 10, 12, 14],
  },
  {
    id: "rock",
    label: "Rock Backbeat",
    kick: [0, 6, 8],
    snare: [4, 12],
    hihat: [0, 2, 4, 6, 8, 10, 12, 14],
  },
  {
    id: "lofi",
    label: "Lo-Fi Boom Bap",
    kick: [0, 7, 10],
    snare: [4, 12],
    hihat: [0, 2, 4, 6, 8, 10, 12, 14, 15],
  },
];

function playDrumSynth(ctx: AudioContext, kind: "hihat" | "snare" | "kick") {
  const now = ctx.currentTime;
  if (kind === "kick") {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.12);
    gain.gain.setValueAtTime(0.45, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.18);
    return;
  }

  const len = Math.floor(ctx.sampleRate * (kind === "snare" ? 0.14 : 0.05));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, kind === "snare" ? 2.2 : 3.5);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const filter = ctx.createBiquadFilter();
  filter.type = kind === "snare" ? "bandpass" : "highpass";
  filter.frequency.value = kind === "snare" ? 1800 : 7500;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(kind === "snare" ? 0.3 : 0.16, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + (kind === "snare" ? 0.14 : 0.05));

  src.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  src.start(now);
}

export const DrumPatternView: React.FC<Props> = ({
  hits,
  bpm,
  currentTime,
  durationSec,
  hasDrumStem,
  loading,
  onDetectDrums,
  onChangeHits,
  onExportDrumMidi,
}) => {
  const [barIndex, setBarIndex] = useState(0);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const stepSec = 60 / Math.max(40, bpm) / 4;
  const barSec = stepSec * 16;
  const maxTime = Math.max(durationSec, ...hits.map((h) => h.time_sec + 0.1), barSec);
  const totalBars = Math.max(1, Math.ceil(maxTime / barSec));
  const safeBar = Math.min(barIndex, totalBars - 1);

  const currentGlobalStep = Math.floor(currentTime / stepSec);
  const activePlayStep =
    currentGlobalStep >= safeBar * 16 && currentGlobalStep < (safeBar + 1) * 16
      ? currentGlobalStep - safeBar * 16
      : -1;

  const rows: Array<{ kind: "hihat" | "snare" | "kick"; label: string; color: string }> = [
    { kind: "hihat", label: "踩镲 (HH)", color: "#f59e0b" },
    { kind: "snare", label: "军鼓 (SD)", color: "#3b82f6" },
    { kind: "kick", label: "底鼓 (BD)", color: "#f43f5e" },
  ];

  const activeCells = new Set<string>();
  for (const h of hits) {
    const step = Math.round(h.time_sec / stepSec) - safeBar * 16;
    if (step >= 0 && step < 16) {
      activeCells.add(`${h.kind}:${step}`);
    }
  }

  const audition = (kind: "hihat" | "snare" | "kick") => {
    try {
      if (!audioCtxRef.current) {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtxRef.current = new Ctx();
      }
      if (audioCtxRef.current.state === "suspended") {
        audioCtxRef.current.resume().catch(() => {});
      }
      playDrumSynth(audioCtxRef.current, kind);
    } catch {
      // ignore Web Audio errors
    }
  };

  const toggleCell = (kind: "hihat" | "snare" | "kick", step: number) => {
    const globalStep = safeBar * 16 + step;
    const key = `${kind}:${step}`;
    audition(kind);
    if (activeCells.has(key)) {
      const next = hits.filter(
        (h) => !(h.kind === kind && Math.round(h.time_sec / stepSec) === globalStep)
      );
      onChangeHits(next);
    } else {
      const next: DrumHit[] = [
        ...hits,
        {
          time_sec: Number((globalStep * stepSec).toFixed(4)),
          kind,
          midi_note: MIDI_MAP[kind],
          velocity: kind === "hihat" ? 86 : 108,
        },
      ].sort((a, b) => a.time_sec - b.time_sec);
      onChangeHits(next);
    }
  };

  const applyPresetToBar = (presetId: string) => {
    const preset = GROOVE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const barStartStep = safeBar * 16;
    const barEndStep = barStartStep + 16;
    const kept = hits.filter((h) => {
      const s = Math.round(h.time_sec / stepSec);
      return s < barStartStep || s >= barEndStep;
    });
    const added: DrumHit[] = [];
    const addSteps = (kind: "hihat" | "snare" | "kick", steps: number[], vel: number) => {
      for (const st of steps) {
        added.push({
          time_sec: Number(((barStartStep + st) * stepSec).toFixed(4)),
          kind,
          midi_note: MIDI_MAP[kind],
          velocity: vel,
        });
      }
    };
    addSteps("kick", preset.kick, 112);
    addSteps("snare", preset.snare, 106);
    addSteps("hihat", preset.hihat, 84);
    audition("kick");
    onChangeHits([...kept, ...added].sort((a, b) => a.time_sec - b.time_sec));
  };

  const clearCurrentBar = () => {
    const barStartStep = safeBar * 16;
    const barEndStep = barStartStep + 16;
    onChangeHits(
      hits.filter((h) => {
        const s = Math.round(h.time_sec / stepSec);
        return s < barStartStep || s >= barEndStep;
      })
    );
  };

  return (
    <div className="card">
      <div className="card-header" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="card-title" title="16 步鼓机编辑器 (BD / SD / HH)">
          <Drum size={14} /> 鼓组
          {hits.length > 0 && <span className="badge">{hits.length} 打击点</span>}
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <div className="row" style={{ gap: 4 }}>
            <button
              className="btn btn-sm"
              disabled={safeBar <= 0}
              onClick={() => setBarIndex((b) => Math.max(0, b - 1))}
              title="上一小节"
            >
              <ChevronLeft size={12} />
            </button>
            <span className="muted" style={{ fontSize: 11.5, minWidth: 68, textAlign: "center" }}>
              第 {safeBar + 1} / {totalBars} 小节
            </span>
            <button
              className="btn btn-sm"
              disabled={safeBar >= totalBars - 1}
              onClick={() => setBarIndex((b) => Math.min(totalBars - 1, b + 1))}
              title="下一小节"
            >
              <ChevronRight size={12} />
            </button>
          </div>
          <button
            className="btn btn-sm"
            disabled={!hasDrumStem || loading}
            onClick={onDetectDrums}
          >
            {loading ? "识别中..." : "识别鼓组节奏"}
          </button>
          <button className="btn btn-sm" onClick={clearCurrentBar} title="清空当前小节鼓点">
            <Trash2 size={12} /> 清空本节
          </button>
          <button
            className="btn btn-sm btn-primary"
            disabled={hits.length === 0}
            onClick={onExportDrumMidi}
          >
            <Download size={12} /> 导出鼓组 .mid
          </button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
        <Sparkles size={12} color="#a855f7" />
        <span className="muted" style={{ fontSize: 11.5 }}>本小节一键律动模板：</span>
        {GROOVE_PRESETS.map((p) => (
          <button
            key={p.id}
            className="btn btn-sm"
            onClick={() => applyPresetToBar(p.id)}
          >
            {p.label}
          </button>
        ))}
        <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
          点击任意步进格开关鼓点并实时试听
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r) => (
          <div
            key={r.kind}
            style={{
              display: "grid",
              gridTemplateColumns: "82px repeat(16, 1fr)",
              gap: 4,
              alignItems: "center",
            }}
          >
            <button
              className="btn btn-sm"
              style={{ justifyContent: "flex-start", padding: "3px 6px", fontSize: 11 }}
              onClick={() => audition(r.kind)}
              title={`点击试听${r.label}`}
            >
              {r.label}
            </button>
            {Array.from({ length: 16 }, (_, step) => {
              const hit = activeCells.has(`${r.kind}:${step}`);
              const isCursor = step === activePlayStep;
              return (
                <button
                  key={step}
                  onClick={() => toggleCell(r.kind, step)}
                  title={`第 ${safeBar + 1} 小节 Step ${step + 1} · 点击开关`}
                  style={{
                    height: 22,
                    borderRadius: 4,
                    cursor: "pointer",
                    background: hit ? r.color : step % 4 === 0 ? "#242b38" : "#151922",
                    border: isCursor ? "1.5px solid #ffffff" : "1px solid var(--border)",
                    boxShadow: isCursor ? "0 0 8px rgba(255,255,255,0.45)" : "none",
                    opacity: hit ? 0.96 : 0.72,
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};
