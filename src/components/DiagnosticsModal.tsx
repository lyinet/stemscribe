import React, { useEffect, useState } from "react";
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
      `StemScribe 诊断报告 (v${diag.app_version})`,
      `- 系统架构: ${diag.os} / ${diag.arch}`,
      `- CoreML 加速: ${diag.coreml_enabled ? "已启用" : "未启用"}`,
      `- Basic Pitch 模型: ${diag.basic_pitch_installed ? "已安装" : "未安装 (将自动使用内置离线算法)"}`,
      `- HTDemucs 4-Stem 模型: ${diag.htdemucs_installed ? "已安装" : "未安装 (将自动使用内置 DSP 分轨)"}`,
      `- 模型缓存目录: ${diag.models_dir}`,
      `- 检测到 CoreMIDI 硬件端口: ${diag.midi_input_count} 个`,
      `- 本地统计: ${diag.saved_projects_count} 个工程 · ${diag.practice_records_count} 条练琴日志 · ${diag.recorded_takes_count} 条翻唱 Take`,
      `- 多模态中转站: ${relayConfigured ? `已配置 (${relayConfig.protocol} / ${relayConfig.model})` : "未配置"}`,
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
            <Activity size={15} /> 系统诊断与环境自检
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn btn-sm" onClick={load} disabled={loading}>
              <RefreshCw size={12} /> 刷新
            </button>
            <button className="btn btn-sm" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        </div>

        {!diag ? (
          <div className="muted" style={{ padding: 20, textAlign: "center" }}>
            正在采集本机运行环境信息...
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5 }}>
            <div className="section-pill" style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between" }}>
              <span className="muted">应用版本与平台</span>
              <strong>v{diag.app_version} · {diag.os} ({diag.arch})</strong>
            </div>
            <div className="section-pill" style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between" }}>
              <span className="muted">Apple Silicon CoreML 硬件加速</span>
              <span className={`badge ${diag.coreml_enabled ? "ok" : ""}`}>
                {diag.coreml_enabled ? "已就绪" : "CPU 模式"}
              </span>
            </div>
            <div className="section-pill" style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between" }}>
              <span className="muted">本地 ONNX 模型状态</span>
              <div className="row" style={{ gap: 6 }}>
                <span className={`badge ${diag.basic_pitch_installed ? "ok" : ""}`}>
                  Basic Pitch: {diag.basic_pitch_installed ? "已安装" : "离线回退"}
                </span>
                <span className={`badge ${diag.htdemucs_installed ? "ok" : ""}`}>
                  HTDemucs: {diag.htdemucs_installed ? "已安装" : "DSP 回退"}
                </span>
              </div>
            </div>
            <div className="section-pill" style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between" }}>
              <span className="muted">原生 CoreMIDI 硬件端口</span>
              <strong>{diag.midi_input_count} 个已检测到</strong>
            </div>
            <div className="section-pill" style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between" }}>
              <span className="muted">本地数据统计</span>
              <strong>
                {diag.saved_projects_count} 工程 · {diag.practice_records_count} 练琴日志 · {diag.recorded_takes_count} 翻唱 Take
              </strong>
            </div>
            <div className="section-pill" style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between" }}>
              <span className="muted">多模态大模型中转站</span>
              <span className={`badge ${relayConfigured ? "ok" : ""}`}>
                {relayConfigured ? `${relayConfig.protocol} · ${relayConfig.model}` : "未填写 API Key"}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 11.5, wordBreak: "break-all" }}>
              模型目录：{diag.models_dir}
            </div>

            <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
              <button className="btn btn-sm btn-primary" onClick={handleCopy}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "已复制诊断报告" : "一键复制诊断报告"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
