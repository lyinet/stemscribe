import React, { useState } from "react";
import { t } from "../../i18n";
import { Pause, Play, Repeat, SkipBack, Square, Timer, TrendingUp } from "lucide-react";

interface Props {
  canPlay: boolean;
  isPlaying: boolean;
  currentTime: number;
  durationSec: number;
  bpm: number;
  keyLabel: string | null;
  playbackRate: number;
  transposeSemitones: number;
  loopEnabled: boolean;
  progressiveRampEnabled: boolean;
  metronomeEnabled: boolean;
  countInEnabled: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  onRewind: () => void;
  onToggleLoop: () => void;
  onToggleProgressiveRamp: () => void;
  onToggleMetronome: () => void;
  onToggleCountIn: () => void;
  onBpmChange: (bpm: number) => void;
  onTapTempo: () => void;
  onRateChange: (rate: number) => void;
  onTransposeChange: (semi: number) => void;
}

const RATES = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 1.0, 1.1, 1.25];

export function formatClock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

export function formatBarBeat(sec: number, bpm: number): string {
  const beatLen = 60 / Math.max(1, bpm);
  const totalBeats = Math.max(0, sec) / beatLen;
  const bar = Math.floor(totalBeats / 4) + 1;
  const beat = Math.floor(totalBeats % 4) + 1;
  return `${bar}.${beat}`;
}

export const TransportBar: React.FC<Props> = ({
  canPlay,
  isPlaying,
  currentTime,
  durationSec,
  bpm,
  keyLabel,
  playbackRate,
  transposeSemitones,
  loopEnabled,
  progressiveRampEnabled,
  metronomeEnabled,
  countInEnabled,
  onTogglePlay,
  onStop,
  onRewind,
  onToggleLoop,
  onToggleProgressiveRamp,
  onToggleMetronome,
  onToggleCountIn,
  onBpmChange,
  onTapTempo,
  onRateChange,
  onTransposeChange,
}) => {
  const [editingBpm, setEditingBpm] = useState<string | null>(null);

  const commitBpm = () => {
    if (editingBpm === null) return;
    const v = Number(editingBpm);
    if (Number.isFinite(v) && v >= 40 && v <= 240) onBpmChange(Math.round(v * 2) / 2);
    setEditingBpm(null);
  };

  return (
    <div className="transport">
      <div className="tp-pill">
        <button className="tp-btn" disabled={!canPlay} onClick={onRewind} title={t("transport.rewind")}>
          <SkipBack size={15} />
        </button>
        <button
          className={`tp-btn tp-play ${isPlaying ? "on" : ""}`}
          disabled={!canPlay}
          onClick={onTogglePlay}
          title={t("transport.playPause")}
        >
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button className="tp-btn" disabled={!canPlay} onClick={onStop} title={t("transport.stop")}>
          <Square size={13} />
        </button>
        <button
          className={`tp-btn ${loopEnabled ? "on" : ""}`}
          disabled={!canPlay}
          onClick={onToggleLoop}
          title={t("transport.loopTip")}
        >
          <Repeat size={15} />
        </button>
      </div>

      <div className="lcd-display">
        <div className="lcd-seg" title={t("transport.positionTip")}>
          <div className="lcd-main">{formatClock(currentTime)}</div>
          <div className="lcd-sub">
            <span>{formatBarBeat(currentTime, bpm)}</span>
            <span className="lcd-dim">/ {formatClock(durationSec)}</span>
          </div>
        </div>
        <div className="lcd-seg lcd-seg-center" title={t("transport.bpmTip")}>
          {editingBpm === null ? (
            <button className="lcd-value" onClick={() => setEditingBpm(String(bpm))}>
              {bpm.toFixed(bpm % 1 === 0 ? 0 : 1)}
            </button>
          ) : (
            <input
              autoFocus
              className="lcd-input"
              value={editingBpm}
              onChange={(e) => setEditingBpm(e.target.value)}
              onBlur={commitBpm}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitBpm();
                if (e.key === "Escape") setEditingBpm(null);
              }}
            />
          )}
          <div className="lcd-label">
            BPM
            <button className="lcd-link" onClick={onTapTempo} title={t("transport.tapTip")}>
              Tap
            </button>
          </div>
        </div>
        <div className="lcd-seg lcd-seg-center" title={t("transport.keyTip")}>
          <div className="lcd-value">{keyLabel ?? "—"}</div>
          <div className="lcd-label">Key</div>
        </div>
      </div>

      <div className="tp-controls">
        <label className="tp-field" title={t("transport.rateTip")}>
          <span>{t("transport.rate")}</span>
          <select value={playbackRate} onChange={(e) => onRateChange(Number(e.target.value))}>
            {RATES.map((r) => (
              <option key={r} value={r}>
                {Math.round(r * 100)}%
              </option>
            ))}
          </select>
        </label>
        <div className="tp-field" title={t("transport.transposeTip")}>
          <span>{t("transport.transpose")}</span>
          <button className="tp-mini" onClick={() => onTransposeChange(Math.max(-6, transposeSemitones - 1))}>
            −
          </button>
          <b className="tp-num">{transposeSemitones > 0 ? `+${transposeSemitones}` : transposeSemitones}</b>
          <button className="tp-mini" onClick={() => onTransposeChange(Math.min(6, transposeSemitones + 1))}>
            +
          </button>
        </div>
      </div>

      <div className="tp-controls">
        <button className={`tp-btn ${metronomeEnabled ? "on" : ""}`} onClick={onToggleMetronome} title={t("transport.metronome")}>
          <Timer size={15} />
        </button>
        <button
          className={`tp-btn tp-text ${countInEnabled ? "on" : ""}`}
          onClick={onToggleCountIn}
          title={t("transport.countInTip")}
        >
          1234
        </button>
        <button
          className={`tp-btn ${progressiveRampEnabled ? "on" : ""}`}
          onClick={onToggleProgressiveRamp}
          title={t("transport.rampTip")}
        >
          <TrendingUp size={15} />
        </button>
      </div>
    </div>
  );
};
