import React, { useState } from "react";
import { Bot, Settings2, Wand2 } from "lucide-react";
import { t } from "../i18n";
import type { ArrangementAnalysis, MidiNote } from "../types/music";

interface Props {
  configured: boolean;
  onOpenSettings: () => void;
  hasAudio: boolean;
  loopEnabled: boolean;
  loopA: number;
  loopB: number;
  notes: MidiNote[];
  loading: boolean;
  analysis: ArrangementAnalysis | null;
  refineSummary: string;
  fingeringTips: string[];
  onAnalyzeArrangement: (useLoopSlice: boolean) => void;
  onRefineMidi: (instrument: string, prompt: string, useLoopSlice: boolean) => void;
}

export const AiAssistantPanel: React.FC<Props> = ({
  configured,
  onOpenSettings,
  hasAudio,
  loopEnabled,
  loopA,
  loopB,
  notes,
  loading,
  analysis,
  refineSummary,
  fingeringTips,
  onAnalyzeArrangement,
  onRefineMidi,
}) => {
  const REFINE_PRESETS: Array<{ label: string; instrument: string; prompt: string }> = [
    { label: t("ai.preset.guitar"), instrument: t("ai.preset.guitar.inst"), prompt: t("ai.preset.guitar.prompt") },
    { label: t("ai.preset.piano"), instrument: t("ai.preset.piano.inst"), prompt: t("ai.preset.piano.prompt") },
    { label: t("ai.preset.bass"), instrument: t("ai.preset.bass.inst"), prompt: t("ai.preset.bass.prompt") },
    { label: t("ai.preset.vocal"), instrument: t("ai.preset.vocal.inst"), prompt: t("ai.preset.vocal.prompt") },
  ];
  const [instrument, setInstrument] = useState(t("ai.preset.guitar.inst"));
  const [customPrompt, setCustomPrompt] = useState(t("ai.preset.guitar.prompt"));
  const [useLoopSlice, setUseLoopSlice] = useState(true);
  return (
    <>
      {!configured && (
        <div className="ai-setup-hint">
          <Settings2 size={15} />
          <div>
            <b>{t("ai.notConfigured")}</b>
            <span>{t("ai.notConfiguredHint")}</span>
          </div>
          <button className="btn btn-sm btn-primary" onClick={onOpenSettings}>
            {t("ai.goSettings")}
          </button>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Bot size={15} /> {t("ai.title")}
          </div>
        </div>

        <label className="row" style={{ marginBottom: 10, fontSize: 12.5, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={useLoopSlice}
            onChange={(e) => setUseLoopSlice(e.target.checked)}
          />
          <span>
            {t("ai.loopSlice")}
            {loopEnabled
              ? ` (${loopA.toFixed(1)}s - ${loopB.toFixed(1)}s)`
              : t("ai.loopSliceFallback")}
          </span>
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            className="btn btn-primary"
            disabled={!hasAudio || loading}
            onClick={() => onAnalyzeArrangement(useLoopSlice && loopEnabled)}
          >
            <Bot size={14} /> {loading ? t("ai.analyzing") : t("ai.analyze")}
          </button>

          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 4 }}>
            <div className="row" style={{ flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
              {REFINE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className="btn btn-sm"
                  style={{ fontSize: 11, padding: "2px 7px" }}
                  onClick={() => {
                    setInstrument(p.instrument);
                    setCustomPrompt(p.prompt);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="muted" style={{ marginBottom: 4 }}>{t("ai.targetInstrument")}</div>
            <input
              className="input"
              value={instrument}
              onChange={(e) => setInstrument(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            <textarea
              className="textarea"
              rows={2}
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            <button
              className="btn"
              style={{ width: "100%", justifyContent: "center" }}
              disabled={!hasAudio || notes.length === 0 || loading}
              onClick={() => onRefineMidi(instrument, customPrompt, useLoopSlice && loopEnabled)}
            >
              <Wand2 size={14} /> {t("ai.refine", { count: notes.length })}
            </button>
          </div>
        </div>
      </div>

      {analysis && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>
            {t("ai.resultTitle")}
          </div>
          <div className="muted" style={{ marginBottom: 8 }}>
            {t("ai.resultMeta", { key: analysis.key_signature, genre: analysis.genre_and_mood })}
          </div>
          {analysis.sections.length > 0 ? (
            analysis.sections.map((s, idx) => (
              <div key={idx} className="section-pill">
                <strong>{s.label}</strong> ({s.time_range}) — {s.chords}
                <div className="muted">{s.arrangement_note}</div>
              </div>
            ))
          ) : (
            <div className="section-pill" style={{ whiteSpace: "pre-wrap" }}>
              {analysis.raw_markdown}
            </div>
          )}
        </div>
      )}

      {refineSummary && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 6 }}>
            {t("ai.refineTitle")}
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 8 }}>{refineSummary}</div>
          {fingeringTips.map((tip, i) => (
            <div key={i} className="section-pill">
              • {tip}
            </div>
          ))}
        </div>
      )}
    </>
  );
};
