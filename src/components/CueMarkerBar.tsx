import React, { useState } from "react";
import { Bookmark, Plus, Repeat, X } from "lucide-react";
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

const PRESETS = ["前奏", "主歌", "副歌", "间奏 Solo", "桥段", "尾奏"];

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
  const [label, setLabel] = useState("副歌");

  return (
    <div className="card" style={{ padding: "8px 14px" }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div className="row">
          <span className="card-title" style={{ fontSize: 13 }}>
            <Bookmark size={13} /> 段落书签 (K)
          </span>
          <select
            className="select"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            style={{ width: 108, padding: "4px 6px", fontSize: 12 }}
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            className="btn btn-sm"
            disabled={!hasAudio}
            onClick={() => onAddMarker(label, currentTime)}
          >
            <Plus size={12} /> 标记 {currentTime.toFixed(1)}s
          </button>
        </div>

        <div className="row" style={{ flexWrap: "wrap" }}>
          {markers.length === 0 ? (
            <span className="muted">播放时按 K 键可快速打段落书签，点击即跳或一键 A-B 循环该段</span>
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
                  <span onClick={() => onSeek(m.time_sec)} title="点击跳转到该段落">
                    {m.label} · {m.time_sec.toFixed(1)}s
                  </span>
                  <Repeat
                    size={11}
                    style={{ opacity: 0.85, color: "#38bdf8" }}
                    onClick={() => onLoopSection(m.time_sec, nextTime, m.label)}
                  >
                    <title>{`一键 A-B 循环「${m.label}」(${m.time_sec.toFixed(1)}s - ${nextTime.toFixed(1)}s)`}</title>
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
