import React, { useState } from "react";
import { Bot, PlugZap, Settings2, Wand2 } from "lucide-react";
import type {
  ArrangementAnalysis,
  LlmRelayConfig,
  MidiNote,
  RelayProtocol,
} from "../types/music";

interface Props {
  config: LlmRelayConfig;
  onConfigChange: (next: LlmRelayConfig) => void;
  hasAudio: boolean;
  loopEnabled: boolean;
  loopA: number;
  loopB: number;
  notes: MidiNote[];
  loading: boolean;
  analysis: ArrangementAnalysis | null;
  refineSummary: string;
  fingeringTips: string[];
  onTestRelay: () => Promise<string>;
  onAnalyzeArrangement: (useLoopSlice: boolean) => void;
  onRefineMidi: (instrument: string, prompt: string, useLoopSlice: boolean) => void;
}

const REFINE_PRESETS: Array<{ label: string; instrument: string; prompt: string }> = [
  { label: "吉他把位", instrument: "电吉他 / 木吉他", prompt: "过滤离调杂音，合并碎片音符，并给出顺手的吉他把位建议。" },
  { label: "钢琴织体", instrument: "钢琴（双手）", prompt: "整理主旋律与左手伴奏声部，修正错位八度与重叠短杂音。" },
  { label: "贝斯律动", instrument: "电贝斯 (4弦)", prompt: "突出根音与经过音律动，清理高于 G3 的误检高频杂音。" },
  { label: "人声清洗", instrument: "主唱人声旋律", prompt: "去除气口与滑音碎音符，合并连音使主旋律更清晰易唱。" },
];

const RELAY_TEMPLATES: Array<{ label: string; protocol: RelayProtocol; model: string }> = [
  { label: "New API (Gemini)", protocol: "openai_input_audio", model: "gemini-2.5-pro" },
  { label: "Qwen-Omni 音频", protocol: "openai_audio_url", model: "qwen2.5-omni-7b" },
  { label: "Gemini 原生中转", protocol: "gemini_compatible", model: "gemini-2.5-pro" },
  { label: "纯文本修谱", protocol: "text_only_midi", model: "deepseek-chat" },
];

export const AiAssistantPanel: React.FC<Props> = ({
  config,
  onConfigChange,
  hasAudio,
  loopEnabled,
  loopA,
  loopB,
  notes,
  loading,
  analysis,
  refineSummary,
  fingeringTips,
  onTestRelay,
  onAnalyzeArrangement,
  onRefineMidi,
}) => {
  const [showSettings, setShowSettings] = useState(true);
  const [instrument, setInstrument] = useState("电吉他 / 木吉他");
  const [customPrompt, setCustomPrompt] = useState(
    "过滤离调杂音，合并碎片音符，并给出顺手的吉他把位建议。"
  );
  const [useLoopSlice, setUseLoopSlice] = useState(true);
  const [testResult, setTestResult] = useState("");
  const [testing, setTesting] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    setTestResult("正在测试中转连通性...");
    try {
      const msg = await onTestRelay();
      setTestResult(msg);
    } catch (err) {
      setTestResult(String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-header" style={{ marginBottom: showSettings ? 10 : 0 }}>
          <div className="card-title">
            <Settings2 size={15} /> 第三方中转平台配置
          </div>
          <button className="btn btn-sm" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? "收起" : "展开"}
          </button>
        </div>

        {showSettings && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="row" style={{ flexWrap: "wrap", gap: 5 }}>
              {RELAY_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.label}
                  className="btn btn-sm"
                  style={{ fontSize: 11, padding: "3px 7px" }}
                  onClick={() =>
                    onConfigChange({ ...config, protocol: tpl.protocol, model: tpl.model })
                  }
                >
                  {tpl.label}
                </button>
              ))}
            </div>

            <div>
              <div className="muted" style={{ marginBottom: 4 }}>中转音频协议格式</div>
              <select
                className="select"
                value={config.protocol}
                onChange={(e) =>
                  onConfigChange({ ...config, protocol: e.target.value as RelayProtocol })
                }
              >
                <option value="openai_input_audio">
                  OpenAI input_audio（New API / OpenRouter / GPT-4o-audio）
                </option>
                <option value="openai_audio_url">
                  OpenAI audio_url DataURI（One API / Qwen-Omni 兼容）
                </option>
                <option value="gemini_compatible">
                  Gemini 原生中转（v1beta generateContent + inline_data）
                </option>
                <option value="text_only_midi">
                  仅传 MIDI 文本（兼容所有纯文本低价中转模型）
                </option>
              </select>
            </div>
            <div>
              <div className="muted" style={{ marginBottom: 4 }}>Base URL</div>
              <input
                className="input"
                placeholder="https://your-relay-domain.com/v1"
                value={config.base_url}
                onChange={(e) => onConfigChange({ ...config, base_url: e.target.value })}
              />
            </div>
            <div className="grid-2">
              <div>
                <div className="muted" style={{ marginBottom: 4 }}>模型名称</div>
                <input
                  className="input"
                  placeholder="gemini-2.5-pro / qwen2.5-omni"
                  value={config.model}
                  onChange={(e) => onConfigChange({ ...config, model: e.target.value })}
                />
              </div>
              <div>
                <div className="muted" style={{ marginBottom: 4 }}>API Key</div>
                <input
                  className="input"
                  type="password"
                  placeholder="sk-..."
                  value={config.api_key}
                  onChange={(e) => onConfigChange({ ...config, api_key: e.target.value })}
                />
              </div>
            </div>

            <div className="row" style={{ justifyContent: "space-between", marginTop: 2 }}>
              <button className="btn btn-sm" onClick={handleTest} disabled={testing}>
                <PlugZap size={13} /> {testing ? "测试中..." : "测试中转连通性"}
              </button>
              <span className="muted" style={{ fontSize: 11 }}>
                自动降采样至 16kHz 单声道防超限
              </span>
            </div>
            {testResult && (
              <div className="section-pill" style={{ marginBottom: 0, fontSize: 11.5 }}>
                {testResult}
              </div>
            )}
          </div>
        )}
      </div>

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
