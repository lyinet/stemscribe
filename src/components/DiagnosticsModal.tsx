import React, { useEffect, useState } from "react";
import { t } from "../i18n";
import { Activity, Check, Copy, RefreshCw, X } from "lucide-react";
import { getSystemDiagnostics } from "../lib/tauriApi";
import type { LlmRelayConfig, SystemDiagnostics } from "../types/music";

interface Props {
  open: boolean;
  relayConfig: LlmRelayConfig;
  onClose: () => void;
}

export const DiagnosticsModal: React.FC<Props> = ({ open, relayConfig, onClose }) => {
  const [diag, setDiag] = useState<SystemDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await getSystemDiagnostics();
      setDiag(res);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setCopied(false);
      load().catch(() => {});
    }
  }, [open]);

  if (!open) return null;

  const relayConfigured = Boolean(relayConfig.base_url.trim() && relayConfig.api_key.trim());

  const handleCopy = async () => {
    if (!diag) return;
    const report = [
      t("diag.report.title", { v: diag.app_version }),
      t("diag.report.arch", { os: diag.os, arch: diag.arch }),
      t("diag.report.coreml", { state: diag.coreml_enabled ? t("diag.enabled") : t("diag.disabled") }),
      t("diag.report.bp", { state: diag.basic_pitch_installed ? t("diag.installed") : t("diag.notInstalledBp") }),
      t("diag.report.htd", { state: diag.htdemucs_installed ? t("diag.installed") : t("diag.notInstalledHtd") }),
      t("diag.report.modelsDir", { dir: diag.models_dir }),
      t("diag.report.midi", { n: diag.midi_input_count }),
      t("diag.report.local", { p: diag.saved_projects_count, r: diag.practice_records_count, tk: diag.recorded_takes_count }),
      t("diag.report.relay", { state: relayConfigured ? t("diag.relayConfigured", { proto: relayConfig.protocol, model: relayConfig.model }) : t("diag.relayNone") }),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.68)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 125,
      }}
      onClick={onClose}
    >
      <div className="card" style={{ width: 580, maxWidth: "92vw" }} onClick={(e) => e.stopPropagation()}>
        <div className="card-header">
          <div className="card-title">
            <Activity size={15} /> {t("diag.title")}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn btn-sm" onClick={load} disabled={loading}>
              <RefreshCw size={12} /> {t("diag.refresh")}
            </button>
            <button className="btn btn-sm" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        </div>

        {!diag ? (
          <div className="muted" style={{ padding: 20, textAlign: "center" }}>
            {t("diag.collecting")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5 }}>
            <div className="section-pill" style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between" }}>
              <span className="muted">{t("diag.app")}</span>
              <strong>v{diag.app_version} · {diag.os} ({diag.arch})</strong>
            </div>
            <div className="section-pill" style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between" }}>
              <span className="muted">{t("diag.coreml")}</span>
              <span className={`badge ${diag.coreml_enabled ? "ok" : ""}`}>
                {diag.coreml_enabled ? t("diag.ready") : t("diag.cpu")}
              </span>
            </div>
            <div className="section-pill" style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between" }}>
              <span className="muted">{t("diag.models")}</span>
              <div className="row" style={{ gap: 6 }}>
                <span className={`badge ${diag.basic_pitch_installed ? "ok" : ""}`}>
                  Basic Pitch: {diag.basic_pitch_installed ? t("diag.installed") : t("diag.offlineFallback")}
                </span>
                <span className={`badge ${diag.htdemucs_installed ? "ok" : ""}`}>
                  HTDemucs: {diag.htdemucs_installed ? t("diag.installed") : t("diag.dspFallback")}
                </span>
              </div>
            </div>
            <div className="section-pill" style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between" }}>
              <span className="muted">{t("diag.midiPorts")}</span>
              <strong>{t("diag.midiCount", { n: diag.midi_input_count })}</strong>
            </div>
            <div className="section-pill" style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between" }}>
              <span className="muted">{t("diag.local")}</span>
              <strong>
                {t("diag.localStats", { p: diag.saved_projects_count, r: diag.practice_records_count, tk: diag.recorded_takes_count })}
              </strong>
            </div>
            <div className="section-pill" style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between" }}>
              <span className="muted">{t("diag.relay")}</span>
              <span className={`badge ${relayConfigured ? "ok" : ""}`}>
                {relayConfigured ? `${relayConfig.protocol} · ${relayConfig.model}` : t("diag.noApiKey")}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 11.5, wordBreak: "break-all" }}>
              {t("diag.modelsDir", { dir: diag.models_dir })}
            </div>

            <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
              <button className="btn btn-sm btn-primary" onClick={handleCopy}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? t("diag.copied") : t("diag.copy")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
