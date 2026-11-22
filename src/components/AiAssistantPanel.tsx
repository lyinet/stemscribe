import React, { useState } from "react";
import { Bot, Settings2, Wand2 } from "lucide-react";
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

const REFINE_PRESETS: Array<{ label: string; instrument: string; prompt: string }> = [
  { label: "吉他把位", instrument: "电吉他 / 木吉他", prompt: "过滤离调杂音，合并碎片音符，并给出顺手的吉他把位建议。" },
  { label: "钢琴织体", instrument: "钢琴（双手）", prompt: "整理主旋律与左手伴奏声部，修正错位八度与重叠短杂音。" },
  { label: "贝斯律动", instrument: "电贝斯 (4弦)", prompt: "突出根音与经过音律动，清理高于 G3 的误检高频杂音。" },
  { label: "人声清洗", instrument: "主唱人声旋律", prompt: "去除气口与滑音碎音符，合并连音使主旋律更清晰易唱。" },
];

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
  const [instrument, setInstrument] = useState("电吉他 / 木吉他");
  const [customPrompt, setCustomPrompt] = useState(
    "过滤离调杂音，合并碎片音符，并给出顺手的吉他把位建议。"
  );
  const [useLoopSlice, setUseLoopSlice] = useState(true);
  return (
    <>
      {!configured && (
        <div className="ai-setup-hint">
          <Settings2 size={15} />
          <div>
            <b>尚未配置 AI 服务</b>
            <span>编曲分析与智能修谱需要先填写大模型接口</span>
          </div>
          <button className="btn btn-sm btn-primary" onClick={onOpenSettings}>
            去设置
          </button>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Bot size={15} /> 多模态编曲拆解与智能修谱
          </div>
        </div>

        <label className="row" style={{ marginBottom: 10, fontSize: 12.5, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={useLoopSlice}
            onChange={(e) => setUseLoopSlice(e.target.checked)}
          />
          <span>
            优先仅上传 A-B 选区片段
            {loopEnabled
              ? ` (${loopA.toFixed(1)}s - ${loopB.toFixed(1)}s)`
              : "（未开 A-B 循环时传前 90s）"}
          </span>
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            className="btn btn-primary"
            disabled={!hasAudio || loading}
            onClick={() => onAnalyzeArrangement(useLoopSlice && loopEnabled)}
          >
            <Bot size={14} /> {loading ? "模型分析中..." : "编曲与和声拆解"}
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
            <div className="muted" style={{ marginBottom: 4 }}>目标乐器（用于智能修谱与指法）</div>
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
              <Wand2 size={14} /> 结合音频智能修谱 ({notes.length} 音符)
            </button>
          </div>
        </div>
      </div>

      {analysis && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>
            编曲分析结果
          </div>
          <div className="muted" style={{ marginBottom: 8 }}>
            调性：{analysis.key_signature} · 风格：{analysis.genre_and_mood}
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
            智能修谱反馈
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
