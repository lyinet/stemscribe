import React, { useState } from "react";
import { Bookmark, Plus, Repeat, X } from "lucide-react";
import { t, type I18nKey } from "../i18n";
import type { SectionMarker } from "../types/music";

interface Props {
  markers: SectionMarker[];
  currentTime: number;
  durationSec: number;
  hasAudio: boolean;
  onAddMarker: (label: string, timeSec: number) => void;
  onDeleteMarker: (id: string) => void;
  onSeek: (sec: number) => void;
  onLoopSection: (startSec: number, endSec: number, label: string) => void;
}

const PRESET_KEYS: I18nKey[] = [
  "cue.preset.intro",
  "cue.preset.verse",
  "cue.preset.chorus",
  "cue.preset.solo",
  "cue.preset.bridge",
  "cue.preset.outro",
];

export const CueMarkerBar: React.FC<Props> = ({
  markers,
  currentTime,
  durationSec,
  hasAudio,
  onAddMarker,
  onDeleteMarker,
  onSeek,
  onLoopSection,
}) => {
  const [presetKey, setPresetKey] = useState<I18nKey>("cue.preset.chorus");

  return (
    <div className="card" style={{ padding: "8px 14px" }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div className="row">
          <span className="card-title" style={{ fontSize: 13 }}>
            <Bookmark size={13} /> {t("cue.title")}
          </span>
          <select
            className="select"
            value={presetKey}
            onChange={(e) => setPresetKey(e.target.value as I18nKey)}
            style={{ width: 108, padding: "4px 6px", fontSize: 12 }}
          >
            {PRESET_KEYS.map((k) => (
              <option key={k} value={k}>
                {t(k)}
              </option>
            ))}
          </select>
          <button
            className="btn btn-sm"
            disabled={!hasAudio}
            onClick={() => onAddMarker(t(presetKey), currentTime)}
          >
            <Plus size={12} /> {t("cue.mark", { t: currentTime.toFixed(1) })}
          </button>
        </div>

        <div className="row" style={{ flexWrap: "wrap" }}>
          {markers.length === 0 ? (
            <span className="muted">{t("cue.hint")}</span>
          ) : (
            markers.map((m, idx) => {
              const nextTime =
                idx + 1 < markers.length
                  ? markers[idx + 1].time_sec
                  : Math.max(m.time_sec + 4, durationSec || m.time_sec + 8);
              return (
                <span
                  key={m.id}
                  className="badge"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    cursor: "pointer",
                    padding: "4px 8px",
                  }}
                >
                  <span onClick={() => onSeek(m.time_sec)} title={t("cue.jumpTip")}>
                    {m.label} · {m.time_sec.toFixed(1)}s
                  </span>
                  <Repeat
                    size={11}
                    style={{ opacity: 0.85, color: "#38bdf8" }}
                    onClick={() => onLoopSection(m.time_sec, nextTime, m.label)}
                  >
                    <title>{t("cue.loopTip", { label: m.label, a: m.time_sec.toFixed(1), b: nextTime.toFixed(1) })}</title>
                  </Repeat>
                  <X
                    size={11}
                    style={{ opacity: 0.7 }}
                    onClick={() => onDeleteMarker(m.id)}
                  />
                </span>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
