import React, { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { RotateCcw } from "lucide-react";
import type { MasterEqState, ReverbPreset } from "../../lib/audioEngine";

export type MixPresetId = "original" | "karaoke" | "no_drums" | "bass_focus" | "vocals_only";

const MIX_PRESETS: Array<{ id: MixPresetId; label: string; hint: string }> = [
  { id: "original", label: t("mixer.p.original"), hint: t("mixer.p.original.hint") },
  { id: "karaoke", label: t("mixer.p.karaoke"), hint: t("mixer.p.karaoke.hint") },
  { id: "no_drums", label: t("mixer.p.noDrums"), hint: t("mixer.p.noDrums.hint") },
  { id: "bass_focus", label: t("mixer.p.bass"), hint: t("mixer.p.bass.hint") },
  { id: "vocals_only", label: t("mixer.p.vocals"), hint: t("mixer.p.vocals.hint") },
];

interface Props {
  hasStems: boolean;
  isPlaying: boolean;
  eq: MasterEqState;
  reverbPreset: ReverbPreset;
  reverbWet: number;
  getMasterPeak: () => number;
  getFrequencyBins: (out: Uint8Array<ArrayBuffer>) => boolean;
  onApplyMixPreset: (preset: MixPresetId) => void;
  onEqChange: (next: MasterEqState) => void;
  onReverbChange: (preset: ReverbPreset, wet: number) => void;
}

function Spectrum({
  isPlaying,
  getFrequencyBins,
}: {
  isPlaying: boolean;
  getFrequencyBins: (out: Uint8Array<ArrayBuffer>) => boolean;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const bins = new Uint8Array(64);
    let raf = 0;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const has = isPlaying && getFrequencyBins(bins);
      const bars = 32;
      const bw = canvas.width / bars;
      for (let i = 0; i < bars; i++) {
        const v = has ? bins[i] / 255 : 0.04;
        const h = Math.max(2, v * (canvas.height - 4));
        ctx.fillStyle = v > 0.75 ? "#f43f5e" : v > 0.45 ? "#f59e0b" : "#22c55e";
        ctx.fillRect(i * bw + 1, canvas.height - h, bw - 2, h);
      }
      if (isPlaying) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, getFrequencyBins]);
  return <canvas ref={ref} width={320} height={84} className="mixer-spectrum" />;
}

function EqKnob({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="eq-band">
      <span className="eq-value">{value > 0 ? `+${value}` : value} dB</span>
      <input
        className="eq-fader"
        type="range"
        min={-12}
        max={12}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(0)}
        title={t("mixer.resetTip")}
      />
      <span className="eq-label">{label}</span>
    </div>
  );
}

export const MixerPanel: React.FC<Props> = ({
  hasStems,
  isPlaying,
  eq,
  reverbPreset,
  reverbWet,
  getMasterPeak,
  getFrequencyBins,
  onApplyMixPreset,
  onEqChange,
  onReverbChange,
}) => {
  const [peak, setPeak] = useState(0);
  useEffect(() => {
    if (!isPlaying) {
      setPeak(0);
      return;
    }
    let raf = 0;
    const loop = () => {
      setPeak(getMasterPeak());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, getMasterPeak]);
  const vu = Math.min(100, Math.round(peak * 115));

  return (
    <div className="mixer">
      <section className="mixer-section">
        <h4>{t("mixer.scenes")}</h4>
        <p className="mixer-hint">{hasStems ? t("mixer.scenesHint") : t("mixer.scenesHintNo")}</p>
        <div className="preset-grid">
          {MIX_PRESETS.map((p) => (
            <button
              key={p.id}
              className="preset-btn"
              disabled={!hasStems}
              onClick={() => onApplyMixPreset(p.id)}
              title={p.hint}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      <section className="mixer-section">
        <h4>
          {t("mixer.eq")}
          <button className="icon-btn" onClick={() => onEqChange({ lowDb: 0, midDb: 0, highDb: 0 })} title={t("mixer.eqResetTip")}>
            <RotateCcw size={12} />
          </button>
        </h4>
        <div className="eq-row">
          <EqKnob label={t("mixer.eqLow")} value={eq.lowDb} onChange={(v) => onEqChange({ ...eq, lowDb: v })} />
          <EqKnob label={t("mixer.eqMid")} value={eq.midDb} onChange={(v) => onEqChange({ ...eq, midDb: v })} />
          <EqKnob label={t("mixer.eqHigh")} value={eq.highDb} onChange={(v) => onEqChange({ ...eq, highDb: v })} />
        </div>
      </section>

      <section className="mixer-section">
        <h4>{t("mixer.reverb")}</h4>
        <div className="seg-control">
          {(
            [
              ["off", t("fx.reverb.off")],
              ["studio", t("fx.reverb.studio")],
              ["hall", t("fx.reverb.hall")],
            ] as Array<[ReverbPreset, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              className={reverbPreset === id ? "on" : ""}
              onClick={() => onReverbChange(id, reverbWet)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="mixer-slider">
          <span>{t("mixer.wet", { pct: Math.round(reverbWet * 100) })}</span>
          <input
            type="range"
            min={0.05}
            max={0.6}
            step={0.05}
            value={reverbWet}
            disabled={reverbPreset === "off"}
            onChange={(e) => onReverbChange(reverbPreset, Number(e.target.value))}
          />
        </label>
      </section>

      <section className="mixer-section grow">
        <h4>{t("mixer.output")}</h4>
        <Spectrum isPlaying={isPlaying} getFrequencyBins={getFrequencyBins} />
        <div className="vu" title={t("mixer.vuTip")}>
          <div className={`vu-fill ${vu > 85 ? "hot" : vu > 65 ? "warm" : ""}`} style={{ width: `${vu}%` }} />
        </div>
      </section>
    </div>
  );
};
