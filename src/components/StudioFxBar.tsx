import React, { useEffect, useState } from "react";
import { RotateCcw, Sliders, Sparkles, Volume2 } from "lucide-react";
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

const STYLES: Array<{ id: ReharmonizeStyle; label: string }> = [
  { id: "jazz_neosoul", label: "爵士 / City Pop" },
  { id: "folk_open", label: "民谣指弹" },
  { id: "cinematic_minor", label: "暗黑电影感" },
  { id: "pop_beginner", label: "新手极简" },
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
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>和弦风格重配</span>
        {STYLES.map((st) => (
          <button
            key={st.id}
            className={`btn btn-sm ${activeReharmStyle === st.id ? "btn-active" : ""}`}
            disabled={!hasChords}
            onClick={() => onReharmonize(st.id)}
          >
            {st.label}
          </button>
        ))}
        {canRestoreChords && (
          <button
            className="btn btn-sm"
            onClick={onRestoreOriginalChords}
            title="还原到风格重配前的原始和弦"
          >
            <RotateCcw size={12} /> 还原原版
          </button>
        )}
      </div>

      {/* Right: Studio Space Reverb & Master VU Meter */}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <Sliders size={14} color="#38bdf8" />
        <span className="muted">空间混响</span>
        <select
          className="select"
          style={{ width: 92, padding: "4px 8px" }}
          value={reverbPreset}
          onChange={(e) => onReverbChange(e.target.value as ReverbPreset, reverbWet)}
        >
          <option value="off">关闭</option>
          <option value="studio">录音室</option>
          <option value="hall">音乐厅</option>
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
            title={`混响干湿比 ${Math.round(reverbWet * 100)}%`}
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
            title="主总线实时峰值电平 (VU)"
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
