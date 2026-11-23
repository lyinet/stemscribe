import React, { useEffect, useState } from "react";
import { RotateCcw, Sliders, Sparkles, Volume2 } from "lucide-react";
import { t } from "../i18n";
import type { ReverbPreset } from "../lib/audioEngine";
import type { ReharmonizeStyle } from "../types/music";

interface Props {
  hasChords: boolean;
  canRestoreChords: boolean;
  activeReharmStyle: string | null;
  reverbPreset: ReverbPreset;
  reverbWet: number;
  isPlaying: boolean;
  getMasterPeak: () => number;
  onReharmonize: (style: ReharmonizeStyle) => void;
  onRestoreOriginalChords: () => void;
  onReverbChange: (preset: ReverbPreset, wet: number) => void;
}

const STYLES: Array<{ id: ReharmonizeStyle; labelKey: import("../i18n").I18nKey }> = [
  { id: "jazz_neosoul", labelKey: "fx.style.jazz" },
  { id: "folk_open", labelKey: "fx.style.folk" },
  { id: "cinematic_minor", labelKey: "fx.style.cinematic" },
  { id: "pop_beginner", labelKey: "fx.style.pop" },
];

export const StudioFxBar: React.FC<Props> = ({
  hasChords,
  canRestoreChords,
  activeReharmStyle,
  reverbPreset,
  reverbWet,
  isPlaying,
  getMasterPeak,
  onReharmonize,
  onRestoreOriginalChords,
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

  const vuPct = Math.min(100, Math.round(peak * 115));

  return (
    <div
      className="card"
      style={{
        padding: "10px 14px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      {/* Left: One-Click Offline Chord Reharmonizer */}
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        <Sparkles size={14} color="#a855f7" />
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t("fx.reharmTitle")}</span>
        {STYLES.map((st) => (
          <button
            key={st.id}
            className={`btn btn-sm ${activeReharmStyle === st.id ? "btn-active" : ""}`}
            disabled={!hasChords}
            onClick={() => onReharmonize(st.id)}
          >
            {t(st.labelKey)}
          </button>
        ))}
        {canRestoreChords && (
          <button
            className="btn btn-sm"
            onClick={onRestoreOriginalChords}
            title={t("fx.restoreTip")}
          >
            <RotateCcw size={12} /> {t("fx.restore")}
          </button>
        )}
      </div>

      {/* Right: Studio Space Reverb & Master VU Meter */}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <Sliders size={14} color="#38bdf8" />
        <span className="muted">{t("fx.reverb")}</span>
        <select
          className="select"
          style={{ width: 92, padding: "4px 8px" }}
          value={reverbPreset}
          onChange={(e) => onReverbChange(e.target.value as ReverbPreset, reverbWet)}
        >
          <option value="off">{t("fx.reverb.off")}</option>
          <option value="studio">{t("fx.reverb.studio")}</option>
          <option value="hall">{t("fx.reverb.hall")}</option>
        </select>
        {reverbPreset !== "off" && (
          <input
            type="range"
            min={0.05}
            max={0.6}
            step={0.05}
            value={reverbWet}
            onChange={(e) => onReverbChange(reverbPreset, Number(e.target.value))}
            style={{ width: 68 }}
            title={t("fx.wetTip", { pct: Math.round(reverbWet * 100) })}
          />
        )}

        <div className="row" style={{ gap: 6, marginLeft: 4 }}>
          <Volume2 size={13} color="#9aa3b2" />
          <div
            style={{
              width: 78,
              height: 8,
              borderRadius: 4,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              overflow: "hidden",
            }}
            title={t("fx.vuTip")}
          >
            <div
              style={{
                width: `${vuPct}%`,
                height: "100%",
                background:
                  vuPct > 85
                    ? "#f43f5e"
                    : vuPct > 65
                    ? "#f59e0b"
                    : "linear-gradient(90deg, #22c55e, #38bdf8)",
                transition: "width 0.05s linear",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
