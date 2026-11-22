import React, { useEffect, useState } from "react";
import { Bot, Cpu, HardDrive, Info, Keyboard, Palette, PlugZap, Piano, X } from "lucide-react";
import type { MidiInputDeviceInfo } from "../lib/webMidi";
import type { LlmRelayConfig, ModelStatus, RelayProtocol } from "../types/music";

export type SettingsSection = "general" | "ai" | "models" | "midi" | "about";
export type AppThemeId = "dark" | "midnight" | "light";

interface Props {
  open: boolean;
  initialSection: SettingsSection;
  appVersion: string;
  theme: AppThemeId;
  themeLabels: Record<AppThemeId, string>;
  relayConfig: LlmRelayConfig;
  modelStatus: ModelStatus | null;
  midiDevices: MidiInputDeviceInfo[];
  onClose: () => void;
  onThemeChange: (theme: AppThemeId) => void;
  onRelayConfigChange: (next: LlmRelayConfig) => void;
  onTestRelay: () => Promise<string>;
  onOpenModelManager: () => void;
  onConnectMidi: () => void;
  onOpenDiagnostics: () => void;
  onOpenShortcuts: () => void;
}

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: React.ReactNode }> = [
  { id: "general", label: "通用", icon: <Palette size={15} /> },
  { id: "ai", label: "AI 服务", icon: <Bot size={15} /> },
  { id: "models", label: "本地模型", icon: <HardDrive size={15} /> },
  { id: "midi", label: "MIDI 设备", icon: <Piano size={15} /> },
  { id: "about", label: "关于", icon: <Info size={15} /> },
];

const RELAY_TEMPLATES: Array<{ label: string; protocol: RelayProtocol; model: string }> = [
  { label: "New API (Gemini)", protocol: "openai_input_audio", model: "gemini-2.5-pro" },
  { label: "Qwen-Omni 音频", protocol: "openai_audio_url", model: "qwen2.5-omni-7b" },
  { label: "Gemini 原生中转", protocol: "gemini_compatible", model: "gemini-2.5-pro" },
  { label: "纯文本修谱", protocol: "text_only_midi", model: "deepseek-chat" },
];

const THEME_SWATCH: Record<AppThemeId, string[]> = {
  dark: ["#16171c", "#202228", "#3b82f6"],
  midnight: ["#0b1020", "#18233e", "#6366f1"],
  light: ["#f4f6fa", "#ffffff", "#2563eb"],
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-field">
      <div className="set-label">{label}</div>
      {children}
      {hint && <div className="set-hint">{hint}</div>}
    </div>
  );
}

export const SettingsModal: React.FC<Props> = ({
  open,
  initialSection,
  appVersion,
  theme,
  themeLabels,
  relayConfig,
  modelStatus,
  midiDevices,
  onClose,
  onThemeChange,
  onRelayConfigChange,
  onTestRelay,
  onOpenModelManager,
  onConnectMidi,
  onOpenDiagnostics,
  onOpenShortcuts,
}) => {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");

  useEffect(() => {
    if (open) setSection(initialSection);
  }, [open, initialSection]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleTest = async () => {
    setTesting(true);
    setTestResult("正在测试连接...");
    try {
      setTestResult(await onTestRelay());
    } catch (err) {
      setTestResult(String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-window" onClick={(e) => e.stopPropagation()}>
        <nav className="settings-nav">
          <div className="settings-nav-title">设置</div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`settings-nav-item ${section === s.id ? "on" : ""}`}
              onClick={() => setSection(s.id)}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-body">
          <header className="settings-header">
            <h2>{SECTIONS.find((s) => s.id === section)?.label}</h2>
            <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
              <X size={16} />
            </button>
          </header>

          <div className="settings-content">
            {section === "general" && (
              <Field label="界面主题">
                <div className="theme-grid">
                  {(Object.keys(themeLabels) as AppThemeId[]).map((id) => (
                    <button
                      key={id}
                      className={`theme-card ${theme === id ? "on" : ""}`}
                      onClick={() => onThemeChange(id)}
                    >
                      <div className="theme-preview" style={{ background: THEME_SWATCH[id][0] }}>
                        <span style={{ background: THEME_SWATCH[id][1] }} />
                        <span style={{ background: THEME_SWATCH[id][2], width: "40%" }} />
                      </div>
                      {themeLabels[id]}
                    </button>
                  ))}
                </div>
              </Field>
            )}

            {section === "ai" && (
              <>
                <p className="set-intro">
                  编曲分析、智能修谱和歌词识别会调用你配置的大模型服务（OpenAI / Gemini 兼容接口）。音频会自动降采样为 16kHz
                  单声道后上传。
                </p>
                <Field label="快速模板">
                  <div className="chip-row">
                    {RELAY_TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.label}
                        className="chip"
                        onClick={() => onRelayConfigChange({ ...relayConfig, protocol: tpl.protocol, model: tpl.model })}
                      >
                        {tpl.label}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="接口协议">
                  <select
                    className="select"
                    value={relayConfig.protocol}
                    onChange={(e) => onRelayConfigChange({ ...relayConfig, protocol: e.target.value as RelayProtocol })}
                  >
                    <option value="openai_input_audio">OpenAI input_audio（New API / OpenRouter / GPT-4o-audio）</option>
                    <option value="openai_audio_url">OpenAI audio_url DataURI（One API / Qwen-Omni）</option>
                    <option value="gemini_compatible">Gemini 原生（v1beta generateContent）</option>
                    <option value="text_only_midi">仅传 MIDI 文本（任意纯文本模型）</option>
                  </select>
                </Field>
                <Field label="Base URL">
                  <input
                    className="input"
                    placeholder="https://your-relay-domain.com/v1"
                    value={relayConfig.base_url}
                    onChange={(e) => onRelayConfigChange({ ...relayConfig, base_url: e.target.value })}
                  />
                </Field>
                <div className="grid-2">
                  <Field label="模型名称">
                    <input
                      className="input"
                      placeholder="gemini-2.5-pro"
                      value={relayConfig.model}
                      onChange={(e) => onRelayConfigChange({ ...relayConfig, model: e.target.value })}
                    />
                  </Field>
                  <Field label="API Key">
                    <input
                      className="input"
                      type="password"
                      placeholder="sk-..."
                      value={relayConfig.api_key}
                      onChange={(e) => onRelayConfigChange({ ...relayConfig, api_key: e.target.value })}
                    />
                  </Field>
                </div>
                <div className="row">
                  <button className="btn" onClick={handleTest} disabled={testing}>
                    <PlugZap size={14} /> {testing ? "测试中..." : "测试连接"}
                  </button>
                  {testResult && <span className="set-hint">{testResult}</span>}
                </div>
              </>
            )}

            {section === "models" && (
              <>
                <p className="set-intro">AI 分轨与扒谱在本机运行（Apple Silicon CoreML 加速），需要先下载对应的 ONNX 模型。</p>
                <div className="status-list">
                  <div className="status-item">
                    <Cpu size={15} />
                    <span>硬件加速</span>
                    <b className={modelStatus?.coreml_enabled ? "ok" : ""}>
                      {modelStatus?.coreml_enabled ? "CoreML 已启用" : "CPU"}
                    </b>
                  </div>
                  <div className="status-item">
                    <HardDrive size={15} />
                    <span>HTDemucs 4 轨分离模型</span>
                    <b className={modelStatus?.demucs_installed ? "ok" : "warn"}>
                      {modelStatus?.demucs_installed ? "已安装" : "未安装"}
                    </b>
                  </div>
                  <div className="status-item">
                    <HardDrive size={15} />
                    <span>Basic Pitch 扒谱模型</span>
                    <b className={modelStatus?.basic_pitch_installed ? "ok" : "warn"}>
                      {modelStatus?.basic_pitch_installed ? "已安装" : "未安装"}
                    </b>
                  </div>
                </div>
                <div className="set-hint">模型目录：{modelStatus?.models_dir ?? "—"}</div>
                <button className="btn btn-primary" onClick={onOpenModelManager}>
                  <HardDrive size={14} /> 下载 / 导入模型...
                </button>
              </>
            )}

            {section === "midi" && (
              <>
                <p className="set-intro">连接 USB-MIDI 键盘后，琴键视图、瀑布流和跟弹打分会实时显示你按下的键。</p>
                <div className="status-list">
                  {midiDevices.length === 0 ? (
                    <div className="status-item">
                      <Piano size={15} />
                      <span>尚未连接 MIDI 设备</span>
                    </div>
                  ) : (
                    midiDevices.map((d) => (
                      <div key={d.id} className="status-item">
                        <Piano size={15} />
                        <span>{d.name}</span>
                        <b className="ok">{d.manufacturer || "已连接"}</b>
                      </div>
                    ))
                  )}
                </div>
                <button className="btn" onClick={onConnectMidi}>
                  <Piano size={14} /> 扫描并连接 MIDI 设备
                </button>
                <div className="set-hint">没有 MIDI 键盘？在「琴键」视图里可以直接用电脑键盘 A–L 弹奏。</div>
              </>
            )}

            {section === "about" && (
              <>
                <div className="about-hero">
                  <div className="about-name">StemScribe</div>
                  <div className="set-hint">版本 {appVersion} · macOS Apple Silicon AI 扒带工作站</div>
                </div>
                <div className="row">
                  <button className="btn" onClick={onOpenDiagnostics}>
                    <Cpu size={14} /> 系统诊断
                  </button>
                  <button className="btn" onClick={onOpenShortcuts}>
                    <Keyboard size={14} /> 快捷键
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
