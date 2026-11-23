import React from "react";
import { BookmarkPlus, Repeat, Sparkles, Waves } from "lucide-react";
import { t } from "../i18n";
import type { SongStructureSegment } from "../types/music";

interface Props {
  segments: SongStructureSegment[];
  durationSec: number;
  currentTime: number;
  detecting: boolean;
  hasAudio: boolean;
  onDetectStructure: () => void;
  onSeek: (sec: number) => void;
  onLoopSection: (seg: SongStructureSegment) => void;
  onConvertToMarkers?: (segments: SongStructureSegment[]) => void;
}

const KIND_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  intro: { bg: "rgba(56, 189, 248, 0.16)", border: "rgba(56, 189, 248, 0.45)", text: "#7dd3fc" },
  verse: { bg: "rgba(99, 102, 241, 0.16)", border: "rgba(99, 102, 241, 0.45)", text: "#a5b4fc" },
  chorus: { bg: "rgba(244, 63, 94, 0.2)", border: "rgba(244, 63, 94, 0.55)", text: "#fda4af" },
  bridge: { bg: "rgba(168, 85, 247, 0.18)", border: "rgba(168, 85, 247, 0.5)", text: "#d8b4fe" },
  outro: { bg: "rgba(34, 197, 94, 0.15)", border: "rgba(34, 197, 94, 0.45)", text: "#86efac" },
};

export const SongStructureBar: React.FC<Props> = ({
  segments,
  durationSec,
  currentTime,
  detecting,
  hasAudio,
  onDetectStructure,
  onSeek,
  onLoopSection,
  onConvertToMarkers,
}) => {
  const activeSeg = segments.find(
    (s) => currentTime >= s.start_sec && currentTime < s.end_sec
  );

  return (
    <div className="card" style={{ padding: "10px 14px" }}>
      <div className="card-header" style={{ marginBottom: segments.length > 0 ? 10 : 0, flexWrap: "wrap", gap: 6 }}>
        <div className="card-title">
          <Waves size={15} />
          <span>{t("structure.title")}</span>
          {activeSeg && (
            <span className="badge ok">{t("structure.current", { label: activeSeg.label })}</span>
          )}
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {activeSeg && (
            <button
              className="btn btn-sm"
              onClick={() => onLoopSection(activeSeg)}
              title={t("structure.loopTip")}
            >
              <Repeat size={12} /> {t("structure.loop")}
            </button>
          )}
          {segments.length > 0 && onConvertToMarkers && (
            <button
              className="btn btn-sm"
              onClick={() => onConvertToMarkers(segments)}
              title={t("structure.markAllTip")}
            >
              <BookmarkPlus size={12} /> {t("structure.markAll")}
            </button>
          )}
          <button
            className="btn btn-sm"
            disabled={!hasAudio || detecting}
            onClick={onDetectStructure}
          >
            <Sparkles size={12} />
            {detecting ? t("structure.detecting") : t("structure.detect")}
          </button>
        </div>
      </div>

      {segments.length === 0 ? (
        <div className="muted" style={{ marginTop: 6 }}>
          {t("structure.empty")}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, width: "100%", overflowX: "auto" }}>
          {segments.map((seg) => {
            const widthPct =
              durationSec > 0
                ? Math.max(10, ((seg.end_sec - seg.start_sec) / durationSec) * 100)
                : 100 / segments.length;
            const palette = KIND_COLORS[seg.kind] ?? KIND_COLORS.verse;
            const isActive = activeSeg?.id === seg.id;
            return (
              <div
                key={seg.id}
                onClick={() => onSeek(seg.start_sec)}
                onDoubleClick={() => onLoopSection(seg)}
                title={t("structure.segTip", { label: seg.label, a: seg.start_sec.toFixed(1), b: seg.end_sec.toFixed(1) })}
                style={{
                  flex: `1 1 ${widthPct}%`,
                  minWidth: 96,
                  cursor: "pointer",
                  padding: "7px 10px",
                  borderRadius: 8,
                  background: palette.bg,
                  border: `1px solid ${isActive ? "#fff" : palette.border}`,
                  boxShadow: isActive ? "0 0 0 1px rgba(255,255,255,0.45)" : "none",
                  transition: "transform 0.12s, border-color 0.15s",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 12,
                    fontWeight: 600,
                    color: palette.text,
                  }}
                >
                  <span>{seg.label}</span>
                  <span style={{ fontSize: 10, opacity: 0.85 }}>
                    {seg.start_sec.toFixed(0)}s
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 5,
                    height: 4,
                    borderRadius: 2,
                    background: "rgba(255,255,255,0.1)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, Math.round(seg.energy * 100))}%`,
                      height: "100%",
                      background: palette.text,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
