import React, { useEffect, useRef } from "react";
import { t } from "../i18n";
import { Pause, Play, Repeat, Scissors, Sliders, Sparkles, Timer, TrendingUp, Volume2, VolumeX } from "lucide-react";
import type { MasterEqState } from "../lib/audioEngine";
import type { StemMixerState, StemOutput } from "../types/music";

export type MixPresetId = "original" | "karaoke" | "no_drums" | "bass_focus" | "vocals_only";

interface Props {
  stems: StemOutput[];
  durationSec: number;
  currentTime: number;
  isPlaying: boolean;
  bpm: number;
  playbackRate: number;
  metronomeEnabled: boolean;
  countInEnabled: boolean;
  progressiveRampEnabled: boolean;
  transposeSemitones: number;
  loopEnabled: boolean;
  loopA: number;
  loopB: number;
  eq: MasterEqState;
  mixer: Record<string, StemMixerState>;
  transcribingStem: string | null;
  getFrequencyBins: (out: Uint8Array<ArrayBuffer>) => boolean;
  onTogglePlay: () => void;
  onSeek: (sec: number) => void;
  onBpmChange: (nextBpm: number) => void;
  onTapTempo: () => void;
  onRateChange: (rate: number) => void;
  onToggleMetronome: () => void;
  onToggleCountIn: () => void;
  onToggleProgressiveRamp: () => void;
  onTransposeChange: (semi: number) => void;
  onLoopToggle: () => void;
  onSetLoopA: (sec: number) => void;
  onSetLoopB: (sec: number) => void;
  onExportLoopSlice: () => void;
  onEqChange: (next: MasterEqState) => void;
  onApplyMixPreset: (preset: MixPresetId) => void;
  onMixerChange: (stemName: string, patch: Partial<StemMixerState>) => void;
  onTranscribeStem: (stem: StemOutput) => void;
}

const STEM_COLORS: Record<string, string> = {
  vocals: "#f43f5e",
  drums: "#f59e0b",
  bass: "#a855f7",
  other: "#3b82f6",
};

const MIX_PRESETS: Array<{ id: MixPresetId; label: string }> = [
  { id: "original", label: t("wave.p.original") },
  { id: "karaoke", label: t("wave.p.karaoke") },
  { id: "no_drums", label: t("wave.p.noDrums") },
  { id: "bass_focus", label: t("wave.p.bass") },
  { id: "vocals_only", label: t("wave.p.vocals") },
];

const SpectrumBarCanvas: React.FC<{
  isPlaying: boolean;
  getFrequencyBins: (out: Uint8Array<ArrayBuffer>) => boolean;
}> = ({ isPlaying, getFrequencyBins }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const bins = new Uint8Array(64);
    let raf = 0;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const hasData = isPlaying && getFrequencyBins(bins);
      const bars = 24;
      const bw = canvas.width / bars;
      for (let i = 0; i < bars; i++) {
        const val = hasData ? bins[i] / 255 : 0.06;
        const h = Math.max(2, val * (canvas.height - 2));
        ctx.fillStyle = val > 0.72 ? "#f43f5e" : val > 0.4 ? "#3b82f6" : "#22c55e";
        ctx.fillRect(i * bw + 1, canvas.height - h, Math.max(2, bw - 2), h);
      }
      if (isPlaying) {
        raf = requestAnimationFrame(draw);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, getFrequencyBins]);

  return (
    <canvas
      ref={ref}
      width={144}
      height={24}
      style={{ borderRadius: 4, background: "#0b0d12", border: "1px solid var(--border)" }}
    />
  );
};

function StemWaveformCanvas({
  peaks,
  color,
  durationSec,
  currentTime,
  loopEnabled,
  loopA,
  loopB,
  onSeek,
}: {
  peaks: number[];
  color: string;
  durationSec: number;
  currentTime: number;
  loopEnabled: boolean;
  loopA: number;
  loopB: number;
  onSeek: (sec: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (loopEnabled && durationSec > 0 && loopB > loopA) {
      const xA = (loopA / durationSec) * w;
      const xB = (loopB / durationSec) * w;
      ctx.fillStyle = "rgba(59, 130, 246, 0.18)";
      ctx.fillRect(xA, 0, xB - xA, h);
    }

    const n = peaks.length || 1;
    const barW = w / n;
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const amp = Math.max(0.04, peaks[i]);
      const barH = amp * (h - 8);
      const x = i * barW;
      const y = (h - barH) / 2;
      ctx.fillRect(x, y, Math.max(1.2, barW - 0.8), barH);
    }

    if (durationSec > 0) {
      const px = (currentTime / durationSec) * w;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    }
  }, [peaks, color, durationSec, currentTime, loopEnabled, loopA, loopB]);

  return (
    <canvas
      ref={canvasRef}
      width={620}
      height={46}
      style={{ width: "100%", height: 46, cursor: "pointer", borderRadius: 6 }}
      onClick={(e) => {
        if (durationSec <= 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        onSeek(ratio * durationSec);
      }}
    />
  );
}

export const WaveformPlayer: React.FC<Props> = ({
  stems,
  durationSec,
  currentTime,
  isPlaying,
  bpm,
  playbackRate,
  metronomeEnabled,
  countInEnabled,
  progressiveRampEnabled,
  transposeSemitones,
  loopEnabled,
  loopA,
  loopB,
  eq,
  mixer,
  transcribingStem,
  getFrequencyBins,
  onTogglePlay,
  onSeek,
  onBpmChange,
  onTapTempo,
  onRateChange,
  onToggleMetronome,
  onToggleCountIn,
  onToggleProgressiveRamp,
  onTransposeChange,
  onLoopToggle,
  onSetLoopA,
  onSetLoopB,
  onExportLoopSlice,
  onEqChange,
  onApplyMixPreset,
  onMixerChange,
  onTranscribeStem,
}) => {
  const fmt = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(1).padStart(4, "0");
    return `${m}:${s}`;
  };

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">{t("wave.title")}</div>
        <div className="row">
          <SpectrumBarCanvas isPlaying={isPlaying} getFrequencyBins={getFrequencyBins} />
          <span className="muted">
            {fmt(currentTime)} / {fmt(durationSec)} · {(playbackRate * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      <div className="transport-bar">
        <button className="btn btn-primary" onClick={onTogglePlay} disabled={stems.length === 0}>
          {isPlaying ? <Pause size={15} /> : <Play size={15} />}
          {isPlaying ? t("wave.pause") : t("wave.play")}
        </button>

        <button
          className={`btn btn-sm ${countInEnabled ? "btn-active" : ""}`}
          onClick={onToggleCountIn}
        >
          {t("wave.countIn")}
        </button>

        <button
          className={`btn btn-sm ${metronomeEnabled ? "btn-active" : ""}`}
          onClick={onToggleMetronome}
        >
          <Timer size={13} /> {t("wave.metronome")}
        </button>

        <div className="row">
          <span className="muted">BPM</span>
          <input
            type="number"
            min={40}
            max={240}
            step={0.5}
            value={bpm}
            onChange={(e) => onBpmChange(Number(e.target.value) || 120)}
            className="input"
            style={{ width: 62, padding: "4px 6px", fontSize: 12 }}
          />
          <button className="btn btn-sm" onClick={onTapTempo}>
            Tap
          </button>
        </div>

        <div className="row">
          <span className="muted">{t("wave.transpose")}</span>
          <button
            className="btn btn-sm"
            onClick={() => onTransposeChange(Math.max(-6, transposeSemitones - 1))}
          >
            -1
          </button>
          <span style={{ fontSize: 12.5, minWidth: 26, textAlign: "center" }}>
            {transposeSemitones > 0 ? `+${transposeSemitones}` : transposeSemitones}
          </span>
          <button
            className="btn btn-sm"
            onClick={() => onTransposeChange(Math.min(6, transposeSemitones + 1))}
          >
            +1
          </button>
        </div>

        <div className="row">
          {[0.5, 0.7, 0.85, 1.0].map((r) => (
            <button
              key={r}
              className={`btn btn-sm ${Math.abs(playbackRate - r) < 0.01 ? "btn-active" : ""}`}
              onClick={() => onRateChange(r)}
            >
              {r}x
            </button>
          ))}
        </div>

        <div className="row" style={{ marginLeft: "auto" }}>
          <button
            className={`btn btn-sm ${loopEnabled ? "btn-active" : ""}`}
            onClick={onLoopToggle}
          >
            <Repeat size={13} /> A-B
          </button>
          <button
            className={`btn btn-sm ${progressiveRampEnabled ? "btn-active" : ""}`}
            onClick={onToggleProgressiveRamp}
            title={t("wave.rampTip")}
          >
            <TrendingUp size={12} /> {t("wave.ramp")}
          </button>
          <button className="btn btn-sm" onClick={() => onSetLoopA(currentTime)}>
            A ({fmt(loopA)})
          </button>
          <button className="btn btn-sm" onClick={() => onSetLoopB(currentTime)}>
            B ({fmt(loopB)})
          </button>
          <button
            className="btn btn-sm"
            disabled={durationSec <= 0 || loopB <= loopA + 0.05}
            onClick={onExportLoopSlice}
          >
            <Scissors size={12} /> {t("wave.slice")}
          </button>
        </div>
      </div>

      <div
        className="row"
        style={{
          marginBottom: 10,
          padding: "6px 10px",
          borderRadius: 8,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div className="row" style={{ flexWrap: "wrap" }}>
          <span className="muted">{t("wave.presets")}</span>
          {MIX_PRESETS.map((p) => (
            <button
              key={p.id}
              className="btn btn-sm"
              disabled={stems.length === 0}
              onClick={() => onApplyMixPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="row" style={{ flexWrap: "wrap" }}>
          <span className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Sliders size={12} /> EQ
          </span>
          <span className="muted">{t("wave.eqLow", { db: eq.lowDb })}</span>
          <input
            type="range"
            min={-12}
            max={12}
            step={1}
            value={eq.lowDb}
            onChange={(e) => onEqChange({ ...eq, lowDb: Number(e.target.value) })}
            style={{ width: 54 }}
          />
          <span className="muted">{t("wave.eqMid", { db: eq.midDb })}</span>
          <input
            type="range"
            min={-12}
            max={12}
            step={1}
            value={eq.midDb}
            onChange={(e) => onEqChange({ ...eq, midDb: Number(e.target.value) })}
            style={{ width: 54 }}
          />
          <span className="muted">{t("wave.eqHigh", { db: eq.highDb })}</span>
          <input
            type="range"
            min={-12}
            max={12}
            step={1}
            value={eq.highDb}
            onChange={(e) => onEqChange({ ...eq, highDb: Number(e.target.value) })}
            style={{ width: 54 }}
          />
          <button
            className="btn btn-sm"
            onClick={() => onEqChange({ lowDb: 0, midDb: 0, highDb: 0 })}
          >
            {t("wave.reset")}
          </button>
        </div>
      </div>

      {stems.length === 0 ? (
        <div className="muted" style={{ padding: "18px 0", textAlign: "center" }}>
          {t("wave.dropHint")}
        </div>
      ) : (
        stems.map((stem) => {
          const st = mixer[stem.name] ?? { muted: false, solo: false, gain: 1.0, pan: 0 };
          return (
            <div key={stem.name} className="stem-row" style={{ gridTemplateColumns: "200px 1fr 90px" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 5 }}>
                  {stem.label_zh} <span className="muted">({stem.name})</span>
                </div>
                <div className="stem-controls" style={{ marginBottom: 4 }}>
                  <button
                    className={`btn btn-sm ${st.muted ? "btn-active" : ""}`}
                    onClick={() => onMixerChange(stem.name, { muted: !st.muted })}
                    title={t("wave.mute")}
                  >
                    {st.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                  </button>
                  <button
                    className={`btn btn-sm ${st.solo ? "btn-active" : ""}`}
                    onClick={() => onMixerChange(stem.name, { solo: !st.solo })}
                    title={t("wave.solo")}
                  >
                    S
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={st.gain}
                    title={t("wave.volume")}
                    onChange={(e) => onMixerChange(stem.name, { gain: Number(e.target.value) })}
                    style={{ width: 62 }}
                  />
                  <span className="muted" style={{ fontSize: 10.5 }}>L/R</span>
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.1}
                    value={st.pan ?? 0}
                    title={t("wave.pan")}
                    onChange={(e) => onMixerChange(stem.name, { pan: Number(e.target.value) })}
                    style={{ width: 48 }}
                  />
                </div>
              </div>

              <StemWaveformCanvas
                peaks={stem.waveform_peaks}
                color={STEM_COLORS[stem.name] ?? "#3b82f6"}
                durationSec={durationSec || stem.duration_sec}
                currentTime={currentTime}
                loopEnabled={loopEnabled}
                loopA={loopA}
                loopB={loopB}
                onSeek={onSeek}
              />

              <button
                className="btn btn-sm"
                disabled={transcribingStem !== null}
                onClick={() => onTranscribeStem(stem)}
              >
                <Sparkles size={13} />
                {transcribingStem === stem.name ? t("wave.transcribing") : t("wave.toMidi")}
              </button>
            </div>
          );
        })
      )}
    </div>
  );
};
