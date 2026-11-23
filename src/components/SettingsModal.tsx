import React, { useEffect, useState } from "react";
import { Bot, Cpu, HardDrive, Info, Keyboard, Palette, PlugZap, Piano, X } from "lucide-react";
import { getLanguage, setLanguage, t, useLanguage } from "../i18n";
import type { I18nKey, Language } from "../i18n";
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
  highQualitySep: boolean;
  midiDevices: MidiInputDeviceInfo[];
  onClose: () => void;
  onThemeChange: (theme: AppThemeId) => void;
  onHighQualitySepChange: (v: boolean) => void;
  onRelayConfigChange: (next: LlmRelayConfig) => void;
  onTestRelay: () => Promise<string>;
  onOpenModelManager: () => void;
  onConnectMidi: () => void;
  onOpenDiagnostics: () => void;
  onOpenShortcuts: () => void;
}

const SECTIONS: Array<{ id: SettingsSection; labelKey: I18nKey; icon: React.ReactNode }> = [
  { id: "general", labelKey: "settings.sec.general", icon: <Palette size={15} /> },
  { id: "ai", labelKey: "settings.sec.ai", icon: <Bot size={15} /> },
  { id: "models", labelKey: "settings.sec.models", icon: <HardDrive size={15} /> },
  { id: "midi", labelKey: "settings.sec.midi", icon: <Piano size={15} /> },
  { id: "about", labelKey: "settings.sec.about", icon: <Info size={15} /> },
];

const RELAY_TEMPLATES: Array<{ labelKey: I18nKey; protocol: RelayProtocol; model: string }> = [
  { labelKey: "settings.tpl.newapi", protocol: "openai_input_audio", model: "gemini-2.5-pro" },
  { labelKey: "settings.tpl.qwen", protocol: "openai_audio_url", model: "qwen2.5-omni-7b" },
  { labelKey: "settings.tpl.gemini", protocol: "gemini_compatible", model: "gemini-2.5-pro" },
  { labelKey: "settings.tpl.text", protocol: "text_only_midi", model: "deepseek-chat" },
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
  highQualitySep,
  midiDevices,
  onClose,
  onThemeChange,
  onHighQualitySepChange,
  onRelayConfigChange,
  onTestRelay,
  onOpenModelManager,
  onConnectMidi,
  onOpenDiagnostics,
  onOpenShortcuts,
}) => {
  const lang = useLanguage();
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
    setTestResult(t("settings.testing"));
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
          <div className="settings-nav-title">{t("settings.title")}</div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`settings-nav-item ${section === s.id ? "on" : ""}`}
              onClick={() => setSection(s.id)}
            >
              {s.icon}
              {t(s.labelKey)}
            </button>
          ))}
        </nav>

        <div className="settings-body">
          <header className="settings-header">
            <h2>{t(SECTIONS.find((s) => s.id === section)?.labelKey ?? "settings.sec.general")}</h2>
            <button className="icon-btn" onClick={onClose} title={t("settings.closeTip")}>
              <X size={16} />
            </button>
          </header>

          <div className="settings-content">
            {section === "general" && (
              <>
              <Field label={t("settings.theme")}>
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
              <Field label={t("settings.language")}>
                <select
                  className="select"
                  value={lang}
                  onChange={(e) => setLanguage(e.target.value as Language)}
                >
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
              </Field>
              </>
            )}

            {section === "ai" && (
              <>
                <p className="set-intro">{t("settings.aiIntro")}</p>
                <Field label={t("settings.templates")}>
                  <div className="chip-row">
                    {RELAY_TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.labelKey}
                        className="chip"
                        onClick={() => onRelayConfigChange({ ...relayConfig, protocol: tpl.protocol, model: tpl.model })}
                      >
                        {t(tpl.labelKey)}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label={t("settings.protocol")}>
                  <select
                    className="select"
                    value={relayConfig.protocol}
                    onChange={(e) => onRelayConfigChange({ ...relayConfig, protocol: e.target.value as RelayProtocol })}
                  >
                    <option value="openai_input_audio">OpenAI input_audio（New API / OpenRouter / GPT-4o-audio）</option>
                    <option value="openai_audio_url">OpenAI audio_url DataURI（One API / Qwen-Omni）</option>
                    <option value="gemini_compatible">{t("settings.protoGemini")}</option>
                    <option value="text_only_midi">{t("settings.protoText")}</option>
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
                  <Field label={t("settings.modelName")}>
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
                    <PlugZap size={14} /> {testing ? t("settings.testing") : t("settings.test")}
                  </button>
                  {testResult && <span className="set-hint">{testResult}</span>}
                </div>
              </>
            )}

            {section === "models" && (
              <>
                <p className="set-intro">{t("settings.modelsIntro")}</p>
                <div className="status-list">
                  <div className="status-item">
                    <Cpu size={15} />
                    <span>{t("settings.engine")}</span>
                    <b className="ok">{t("settings.engineVal")}</b>
                  </div>
                  <div className="status-item">
                    <HardDrive size={15} />
                    <span>{t("settings.htd")}</span>
                    <b className={modelStatus?.demucs_installed ? "ok" : "warn"}>
                      {modelStatus?.demucs_installed ? t("settings.installed") : t("settings.notInstalled")}
                    </b>
                  </div>
                  <div className="status-item">
                    <HardDrive size={15} />
                    <span>{t("settings.htdFt")}</span>
                    <b className={modelStatus?.demucs_ft_vocals_installed ? "ok" : "warn"}>
                      {modelStatus?.demucs_ft_vocals_installed ? t("settings.installed") : t("settings.notInstalled")}
                    </b>
                  </div>
                  <div className="status-item">
                    <HardDrive size={15} />
                    <span>{t("settings.bp")}</span>
                    <b className={modelStatus?.basic_pitch_installed ? "ok" : "warn"}>
                      {modelStatus?.basic_pitch_installed ? t("settings.installed") : t("settings.notInstalled")}
                    </b>
                  </div>
                  <div className="status-item">
                    <HardDrive size={15} />
                    <span>{t("settings.critic")}</span>
                    <b className={modelStatus?.critic_installed ? "ok" : "warn"}>
                      {modelStatus?.critic_installed ? t("settings.installed") : t("settings.notInstalled")}
                    </b>
                  </div>
                </div>
                <Field label={t("settings.hq")}>
                  <label className="row" style={{ gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={highQualitySep}
                      onChange={(e) => onHighQualitySepChange(e.target.checked)}
                    />
                    <span>{t("settings.hqDesc")}</span>
                  </label>
                </Field>
                <div className="set-hint">{t("settings.modelsDir", { dir: modelStatus?.models_dir ?? "—" })}</div>
                <button className="btn btn-primary" onClick={onOpenModelManager}>
                  <HardDrive size={14} /> {t("settings.downloadModels")}
                </button>
              </>
            )}

            {section === "midi" && (
              <>
                <p className="set-intro">{t("settings.midiIntro")}</p>
                <div className="status-list">
                  {midiDevices.length === 0 ? (
                    <div className="status-item">
                      <Piano size={15} />
                      <span>{t("settings.noMidi")}</span>
                    </div>
                  ) : (
                    midiDevices.map((d) => (
                      <div key={d.id} className="status-item">
                        <Piano size={15} />
                        <span>{d.name}</span>
                        <b className="ok">{d.manufacturer || t("settings.connected")}</b>
                      </div>
                    ))
                  )}
                </div>
                <button className="btn" onClick={onConnectMidi}>
                  <Piano size={14} /> {t("settings.scanMidi")}
                </button>
                <div className="set-hint">{t("settings.midiHint")}</div>
              </>
            )}

            {section === "about" && (
              <>
                <div className="about-hero">
                  <div className="about-name">StemScribe</div>
                  <div className="set-hint">{t("settings.version", { v: appVersion })}</div>
                  <div className="set-hint">{t("settings.crashLog")}</div>
                </div>
                <div className="row">
                  <button className="btn" onClick={onOpenDiagnostics}>
                    <Cpu size={14} /> {t("settings.diagnostics")}
                  </button>
                  <button className="btn" onClick={onOpenShortcuts}>
                    <Keyboard size={14} /> {t("settings.shortcuts")}
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
