import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Eye, Pause, Play, Sparkles, X } from "lucide-react";
import { adviseRestoration, pickAudioFile, resolveAudioUrl } from "../../lib/tauriApi";
import type {
  AdvisorInput,
  AdvisorResult,
  CompareResult,
  LlmRelayConfig,
  QualityIssue,
  QualityReport,
  RestoreProgress,
  RestoreResult,
  RestoreSettings,
} from "../../types/music";

interface Props {
  before: QualityReport | null;
  result: RestoreResult | null;
  settings: RestoreSettings;
  onSettingsChange: (s: RestoreSettings) => void;
  running: boolean;
  progress: RestoreProgress | null;
  onRun: () => void;
  onRunCompare: () => void;
  compareResult: CompareResult | null;
  compareSel: number;
  onSelectCompare: (i: number) => void;
  onExport: (bitDepth: 24 | 16) => void;
  sourcePath: string | null;
  sourceDuration: number;
  mainIsPlaying: boolean;
  onAbPlayingChange: (playing: boolean) => void;
  llmConfig: LlmRelayConfig | null;
  /** Prompt-role names (lead_vocals/backing_vocals/drums/percussion/bass/other). */
  stemRoles: string[];
  onApplyAdvisor: (s: RestoreSettings) => void;
  /** Set when the adopted AI render scored worse than the previous one. */
  advisorRegress: { prevScore: number; newScore: number } | null;
  onRevertAdvisor: () => void;
  onOpenAiSettings: () => void;
}

const STAGE_LABELS: Record<string, string> = {
  analyze: "诊断",
  stems: "分轨处理",
  master: "母带",
  limit: "限幅",
  write: "写盘",
  report: "报告",
  compare_light: "对比 · 轻档",
  compare_standard: "对比 · 标准档",
  compare_strong: "对比 · 重档",
};

type AmountModule =
  | "vocal_cleanup"
  | "shimmer"
  | "drum_punch"
  | "low_end"
  | "width"
  | "vocal_space"
  | "hf_restore"
  | "glue";

type BoolModule = "loudness" | "reference_match" | "drum_replace";

type ToneKey =
  | "vocal_level_db"
  | "vocal_presence_db"
  | "vocal_air_db"
  | "low_shelf_db"
  | "high_shelf_db";

const MODULE_LABELS: Array<{ key: AmountModule; label: string }> = [
  { key: "vocal_cleanup", label: "人声清理" },
  { key: "shimmer", label: "去金属声" },
  { key: "drum_punch", label: "鼓点冲击" },
  { key: "low_end", label: "低频收紧" },
  { key: "width", label: "立体声展宽" },
  { key: "vocal_space", label: "人声让位" },
  { key: "hf_restore", label: "补高频" },
  { key: "glue", label: "整体粘合" },
];

const TONE_FIELDS: Array<{ key: ToneKey; label: string }> = [
  { key: "vocal_level_db", label: "人声音量" },
  { key: "vocal_presence_db", label: "人声清晰度" },
  { key: "vocal_air_db", label: "人声空气感" },
  { key: "low_shelf_db", label: "整体低频" },
  { key: "high_shelf_db", label: "整体高频" },
];

const CONF_LABELS: Record<string, string> = {
  low: "置信度：低",
  medium: "置信度：中",
  high: "置信度：高",
};

function fmtAdvisorVal(v: number | boolean): string {
  return typeof v === "boolean" ? (v ? "开" : "关") : `${v}`;
}

const SEV_ORDER: Record<string, number> = { ok: 0, warn: 1, bad: 2 };
const SEV_COLOR: Record<string, string> = {
  ok: "var(--green)",
  warn: "var(--amber)",
  bad: "var(--rose)",
};

function fmtLufs(v: number): string {
  return `${v.toFixed(1)}`;
}

function cutoffLabel(hz: number | null): string {
  return hz && hz < 19000 ? `${(hz / 1000).toFixed(1)} kHz` : "完整";
}

function specLabel(r: QualityReport): string {
  const khz = (r.sample_rate / 1000).toFixed(r.sample_rate % 1000 === 0 ? 0 : 1);
  const bd = r.bit_depth ? `${r.bit_depth}-bit` : "有损";
  return `${khz} kHz · ${bd}`;
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Mean dB of ltas bands in [lo, hi] Hz — bands are log-spaced. */
function bandMean(ltas: { hz: number; db: number }[], lo: number, hi: number): number | null {
  const sel = ltas.filter((b) => b.hz >= lo && b.hz <= hi);
  if (sel.length === 0) return null;
  return sel.reduce((s, b) => s + b.db, 0) / sel.length;
}

/** Log-frequency LTAS plot: before (grey) vs after (accent), optional
 *  reference curve dashed, normalized to the after curve's 100 Hz–8 kHz mean. */
const SpectrumPlot: React.FC<{
  before: QualityReport | null;
  after: QualityReport | null;
  reference?: QualityReport | null;
}> = ({ before, after, reference }) => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(cv);
    const cGrid = css.getPropertyValue("--grid-major").trim() || "rgba(127,127,127,0.2)";
    const cText = css.getPropertyValue("--text-3").trim() || "#888";
    const cBefore = css.getPropertyValue("--text-3").trim() || "#888";
    const cAfter = css.getPropertyValue("--accent").trim() || "#5b8cff";
    ctx.clearRect(0, 0, w, h);

    const F_MIN = 20;
    const F_MAX = 20000;
    const xOf = (f: number) =>
      (Math.log2(f / F_MIN) / Math.log2(F_MAX / F_MIN)) * w;

    const hasDelta = !!(before?.ltas?.length && after?.ltas?.length);
    const LABEL_H = 12;
    const STRIP_H = hasDelta ? 30 : 0;
    const plotH = h - LABEL_H - STRIP_H;

    // Reference curve normalized to the after curve's 100 Hz–8 kHz mean.
    const anchor = after ?? before;
    const anchorMean = anchor ? bandMean(anchor.ltas, 100, 8000) : null;
    const refMean = reference ? bandMean(reference.ltas, 100, 8000) : null;
    const refLtas =
      reference && anchorMean != null && refMean != null
        ? reference.ltas.map((b) => ({ hz: b.hz, db: b.db - refMean + anchorMean }))
        : [];

    // dB range
    const all = [...(before?.ltas ?? []), ...(after?.ltas ?? []), ...refLtas];
    let lo = -80;
    let hi = -10;
    if (all.length > 0) {
      lo = Math.min(...all.map((b) => b.db)) - 3;
      hi = Math.max(...all.map((b) => b.db)) + 3;
      if (hi - lo < 20) {
        const mid = (hi + lo) / 2;
        lo = mid - 10;
        hi = mid + 10;
      }
    }
    const yOf = (db: number) => plotH - ((db - lo) / (hi - lo)) * plotH;

    // grid + labels
    ctx.strokeStyle = cGrid;
    ctx.fillStyle = cText;
    ctx.font = "9px sans-serif";
    ctx.lineWidth = 1;
    for (const [f, lab] of [
      [100, "100"],
      [1000, "1k"],
      [10000, "10k"],
    ] as Array<[number, string]>) {
      const x = xOf(f);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotH);
      ctx.stroke();
      ctx.fillText(lab, x - 8, plotH + LABEL_H - 2);
    }

    const drawCurve = (ltas: { hz: number; db: number }[], color: string) => {
      if (ltas.length === 0) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ltas.forEach((b, i) => {
        const x = xOf(Math.max(F_MIN, b.hz));
        const y = yOf(b.db);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    drawCurve(before?.ltas ?? [], cBefore);
    drawCurve(after?.ltas ?? [], cAfter);
    if (refLtas.length > 0) {
      ctx.strokeStyle = cAfter;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      refLtas.forEach((b, i) => {
        const x = xOf(Math.max(F_MIN, b.hz));
        const y = yOf(b.db);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // cutoff marker
    if (before?.cutoff_hz) {
      const x = xOf(before.cutoff_hz);
      ctx.strokeStyle = cText;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Delta strip: after - before per band, fixed +/-6 dB, zero line.
    if (hasDelta) {
      const b = before!.ltas;
      const a = after!.ltas;
      const interp = (f: number): number => {
        if (f <= a[0].hz) return a[0].db;
        if (f >= a[a.length - 1].hz) return a[a.length - 1].db;
        for (let i = 1; i < a.length; i++) {
          if (a[i].hz >= f) {
            const t = Math.log2(f / a[i - 1].hz) / Math.log2(a[i].hz / a[i - 1].hz);
            return a[i - 1].db + (a[i].db - a[i - 1].db) * t;
          }
        }
        return a[a.length - 1].db;
      };
      const top = plotH + LABEL_H;
      const mid = top + STRIP_H / 2;
      const yD = (d: number) => mid - (Math.max(-6, Math.min(6, d)) / 6) * (STRIP_H / 2 - 3);
      ctx.strokeStyle = cGrid;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cText;
      ctx.fillText("变化", 2, mid + 3);
      ctx.strokeStyle = cAfter;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      b.forEach((band, i) => {
        const x = xOf(Math.max(F_MIN, band.hz));
        const y = yD(interp(band.hz) - band.db);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }, [before, after, reference]);

  return <canvas ref={ref} className="rp-spectrum" />;
};

interface IssueRow {
  issue: QualityIssue;
  state: "before" | "fixed" | "still" | "new";
  afterSeverity?: string;
}

function mergeIssues(before: QualityReport | null, after: QualityReport | null): IssueRow[] {
  const rows: IssueRow[] = [];
  const afterMap = new Map((after?.issues ?? []).map((i) => [i.id, i]));
  const seen = new Set<string>();
  for (const iss of before?.issues ?? []) {
    if (iss.severity === "ok") continue;
    seen.add(iss.id);
    if (!after) {
      rows.push({ issue: iss, state: "before" });
    } else {
      const a = afterMap.get(iss.id);
      if (!a || a.severity === "ok" || SEV_ORDER[a.severity] < SEV_ORDER[iss.severity]) {
        rows.push({ issue: iss, state: "fixed", afterSeverity: a?.severity });
      } else {
        rows.push({ issue: a, state: "still" });
      }
    }
  }
  if (after) {
    for (const iss of after.issues) {
      if (iss.severity === "ok" || seen.has(iss.id)) continue;
      rows.push({ issue: iss, state: "new" });
    }
  }
  return rows;
}

export const RestorePanel: React.FC<Props> = ({
  before,
  result,
  settings,
  onSettingsChange,
  running,
  progress,
  onRun,
  onRunCompare,
  compareResult,
  compareSel,
  onSelectCompare,
  onExport,
  sourcePath,
  sourceDuration,
  mainIsPlaying,
  onAbPlayingChange,
  llmConfig,
  stemRoles,
  onApplyAdvisor,
  advisorRegress,
  onRevertAdvisor,
  onOpenAiSettings,
}) => {
  const after = result?.after ?? null;
  const issues = useMemo(() => mergeIssues(before, after), [before, after]);

  // ---------- AI 参谋 ----------
  const [advisorText, setAdvisorText] = useState("");
  const [advising, setAdvising] = useState(false);
  const [proposal, setProposal] = useState<AdvisorResult | null>(null);
  const [advisorError, setAdvisorError] = useState<string | null>(null);
  const llmReady = !!(
    llmConfig &&
    llmConfig.base_url.trim() &&
    llmConfig.api_key.trim()
  );

  const askAdvisor = async () => {
    if (!llmConfig || !before || advising) return;
    setAdvising(true);
    setAdvisorError(null);
    try {
      const input: AdvisorInput = {
        report: before,
        stems: stemRoles,
        current: settings,
        last_result:
          result?.objective != null
            ? {
                report: result.after,
                score: result.objective.score,
                terms: result.objective.terms,
              }
            : null,
        user_request: advisorText,
      };
      const res = await adviseRestoration(llmConfig, input);
      setProposal(res);
    } catch (err) {
      setAdvisorError(String(err));
      setProposal(null);
    } finally {
      setAdvising(false);
    }
  };

  // ---------- A/B ----------
  const aRef = useRef<HTMLAudioElement>(null);
  const bRef = useRef<HTMLAudioElement>(null);
  const [abPlaying, setAbPlaying] = useState(false);
  const [abTime, setAbTime] = useState(0);
  const [abSel, setAbSel] = useState<"orig" | "rest">("orig");
  const [blind, setBlind] = useState(false);
  const [blindMap, setBlindMap] = useState<{ a: "orig" | "rest"; b: "orig" | "rest" } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [exportDepth, setExportDepth] = useState<24 | 16>(24);

  const matchDb = result?.loudness_match_db ?? 0;
  // match_db = before.I - after.I; <0 means restored is louder -> attenuate it.
  const restGainDb = Math.min(0, matchDb);
  const origGainDb = Math.min(0, -matchDb);
  const volOf = useCallback(
    (kind: "orig" | "rest", active: boolean) => {
      if (!active) return 0;
      const db = kind === "orig" ? origGainDb : restGainDb;
      return Math.min(1, Math.pow(10, db / 20));
    },
    [origGainDb, restGainDb]
  );

  const applyVols = useCallback(
    (sel: "orig" | "rest") => {
      const a = aRef.current;
      const b = bRef.current;
      if (!a || !b) return;
      a.volume = volOf("orig", sel === "orig");
      b.volume = volOf("rest", sel === "rest");
    },
    [volOf]
  );

  const pauseAb = useCallback(() => {
    aRef.current?.pause();
    bRef.current?.pause();
    setAbPlaying(false);
    onAbPlayingChange(false);
  }, [onAbPlayingChange]);

  const toggleAb = async () => {
    const a = aRef.current;
    const b = bRef.current;
    if (!a || !b) return;
    if (abPlaying) {
      pauseAb();
      return;
    }
    if (Math.abs(a.currentTime - b.currentTime) > 0.03) b.currentTime = a.currentTime;
    applyVols(abSel);
    try {
      await Promise.all([a.play(), b.play()]);
      setAbPlaying(true);
      onAbPlayingChange(true);
    } catch {
      setAbPlaying(false);
    }
  };

  // Pause A/B when the main transport starts.
  useEffect(() => {
    if (mainIsPlaying && abPlaying) pauseAb();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainIsPlaying]);

  // Stop A/B if a new render replaces the result file.
  const resultPath = result?.output_path ?? null;
  useEffect(() => {
    setAbTime(0);
    setAbPlaying(false);
    setRevealed(false);
    setBlind(false);
    setBlindMap(null);
    setAbSel("orig");
  }, [resultPath]);

  // Keep hidden element in sync while playing.
  useEffect(() => {
    if (!abPlaying) return;
    const id = window.setInterval(() => {
      const a = aRef.current;
      const b = bRef.current;
      if (!a || !b) return;
      if (Math.abs(a.currentTime - b.currentTime) > 0.03) {
        b.currentTime = a.currentTime;
      }
      setAbTime(a.currentTime);
      if (a.ended) pauseAb();
    }, 200);
    return () => window.clearInterval(id);
  }, [abPlaying, pauseAb]);

  const selectAb = (pick: "a" | "b" | "orig" | "rest") => {
    let sel: "orig" | "rest";
    if (blind && blindMap && !revealed) {
      sel = pick === "a" ? blindMap.a : blindMap.b;
    } else {
      sel = pick === "orig" || pick === "a" ? "orig" : "rest";
    }
    setAbSel(sel);
    const a = aRef.current;
    const b = bRef.current;
    if (a && b && Math.abs(a.currentTime - b.currentTime) > 0.03) {
      const srcEl = sel === "orig" ? a : b;
      const other = sel === "orig" ? b : a;
      other.currentTime = srcEl.currentTime;
    }
    applyVols(sel);
  };

  const duration = sourceDuration || before?.duration_sec || 0;
  const matchLabel =
    Math.abs(matchDb) < 0.1
      ? "已等响度"
      : matchDb < 0
        ? `已等响度：修复后 ${matchDb.toFixed(1)} dB`
        : `已等响度：原曲 ${(-matchDb).toFixed(1)} dB`;

  const setStrength = (v: number) => onSettingsChange({ ...settings, strength: v });
  const setTarget = (v: number) => onSettingsChange({ ...settings, target_lufs: v });
  const toggleModule = (key: BoolModule) =>
    onSettingsChange({
      ...settings,
      modules: { ...settings.modules, [key]: !settings.modules[key] },
    });
  const setModuleAmount = (key: AmountModule, v: number) =>
    onSettingsChange({
      ...settings,
      modules: { ...settings.modules, [key]: v },
    });
  const setTone = (key: ToneKey, v: number) =>
    onSettingsChange({ ...settings, [key]: v });

  const metricRows: Array<{ label: string; before: string; after: string | null }> = before
    ? [
        { label: "响度", before: `${fmtLufs(before.integrated_lufs)} LUFS`, after: after ? `${fmtLufs(after.integrated_lufs)} LUFS` : null },
        { label: "动态", before: `${before.lra_lu.toFixed(1)} LU`, after: after ? `${after.lra_lu.toFixed(1)} LU` : null },
        { label: "真峰值", before: `${before.true_peak_dbtp.toFixed(1)} dBTP`, after: after ? `${after.true_peak_dbtp.toFixed(1)} dBTP` : null },
        { label: "高频截止", before: cutoffLabel(before.cutoff_hz), after: after ? cutoffLabel(after.cutoff_hz) : null },
        { label: "规格", before: specLabel(before), after: after ? specLabel(after) : null },
        ...(result?.reference
          ? [
              {
                label: "与参考差距",
                before: `${result.reference.distance_before_db.toFixed(1)} dB`,
                after: `${result.reference.distance_after_db.toFixed(1)} dB`,
              },
            ]
          : []),
        ...(result?.objective
          ? [
              {
                label: "规则评分",
                before: "—",
                after: `S = ${result.objective.score.toFixed(2)}`,
              },
            ]
          : []),
        ...(result?.critic
          ? [
              {
                label: "AI 评分 PQ",
                before: result.critic_before
                  ? result.critic_before.pq.toFixed(2)
                  : "—",
                after: result.critic.pq.toFixed(2),
              },
            ]
          : []),
      ]
    : [];

  const showBlind = blind && !revealed;

  return (
    <div className="restore-panel">
      <div className="rp-grid">
        <section className="rp-col">
          <div className="rp-title">诊断</div>
          {!before && <div className="rp-hint">点「开始修复」会先诊断当前歌曲。</div>}
          {metricRows.map((r) => (
            <div key={r.label} className="rp-metric">
              <span className="rp-metric-label">{r.label}</span>
              <span className="rp-metric-val">{r.before}</span>
              {r.after && (
                <>
                  <span className="rp-arrow">→</span>
                  <span className="rp-metric-val after">{r.after}</span>
                </>
              )}
            </div>
          ))}
          {issues.length > 0 && (
            <div className="rp-issues">
              {issues.map((row, i) => (
                <div key={`${row.issue.id}_${i}`} className="rp-issue" title={row.issue.detail}>
                  <span className="rp-dot" style={{ background: SEV_COLOR[row.issue.severity] }} />
                  <span className="rp-issue-title">{row.issue.title}</span>
                  {row.state === "fixed" && <span className="rp-tag ok">已改善</span>}
                  {row.state === "still" && <span className="rp-tag warn">仍存在</span>}
                  {row.state === "new" && <span className="rp-tag new">新增</span>}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rp-col">
          <div className="rp-title">频谱</div>
          <SpectrumPlot before={before} after={after} reference={result?.reference?.report ?? null} />
          <div className="rp-legend">
            <span className="rp-swatch" style={{ background: "var(--text-3)" }} /> 修复前
            <span className="rp-swatch" style={{ background: "var(--accent)" }} /> 修复后
            {result?.reference && <span className="rp-swatch dashed" />} {result?.reference ? "参考曲" : null}
          </div>
        </section>

        <section className="rp-col">
          <div className="rp-title">修复</div>
          <div className="rp-row">
            <span className="rp-label">参考曲</span>
            {settings.reference_path ? (
              <span className="rp-chip" title={settings.reference_path}>
                {settings.reference_path.split("/").pop()}
                <button
                  className="rp-chip-x"
                  disabled={running}
                  title="清除参考曲"
                  onClick={() =>
                    onSettingsChange({ ...settings, reference_path: null })
                  }
                >
                  <X size={11} />
                </button>
              </span>
            ) : (
              <button
                className="btn btn-sm"
                disabled={running}
                onClick={async () => {
                  const p = await pickAudioFile();
                  if (p) onSettingsChange({ ...settings, reference_path: p });
                }}
              >
                选择参考曲…
              </button>
            )}
          </div>
          {settings.reference_path && (
            <div className="rp-row">
              <span className="rp-label" />
              <label className="rp-module">
                <input
                  type="checkbox"
                  checked={settings.follow_reference_loudness}
                  disabled={running}
                  onChange={(e) =>
                    onSettingsChange({
                      ...settings,
                      follow_reference_loudness: e.target.checked,
                    })
                  }
                />
                跟随参考响度
              </label>
            </div>
          )}
          <div className="rp-row">
            <span className="rp-label">强度</span>
            <div className="seg">
              {[
                { v: 0.5, l: "轻" },
                { v: 1.0, l: "标准" },
                { v: 1.5, l: "重" },
              ].map((o) => (
                <button
                  key={o.v}
                  className={settings.strength === o.v ? "on" : ""}
                  disabled={running}
                  onClick={() => setStrength(o.v)}
                >
                  {o.l}
                </button>
              ))}
            </div>
          </div>
          <div className="rp-row">
            <span className="rp-label">目标</span>
            <div className="seg">
              {[
                { v: -14, l: "−14 LUFS 流媒体" },
                { v: -12, l: "−12 LUFS 更响" },
              ].map((o) => (
                <button
                  key={o.v}
                  className={settings.target_lufs === o.v ? "on" : ""}
                  disabled={running}
                  onClick={() => setTarget(o.v)}
                >
                  {o.l}
                </button>
              ))}
            </div>
          </div>
          <div className="rp-runrow">
            <button className="btn btn-primary rp-run" disabled={running} onClick={onRun}>
              <Sparkles size={13} /> {running ? "修复中…" : result ? "重新修复" : "开始修复"}
            </button>
            <button className="btn rp-run" disabled={running} onClick={onRunCompare}>
              {running ? "对比中…" : "三档对比"}
            </button>
          </div>
          {compareResult && compareResult.candidates.length > 0 && (
            <div className="rp-cards">
              {compareResult.candidates.map((c, i) => (
                <button
                  key={i}
                  className={`rp-card${i === compareSel ? " on" : ""}${c.warning ? " warn" : ""}`}
                  onClick={() => onSelectCompare(i)}
                  title={c.warning ?? undefined}
                >
                  <div className="rp-card-head">
                    <span className="rp-card-name">{c.strength_label}档</span>
                    {i === compareResult.recommended && (
                      <span className="rp-badge">推荐</span>
                    )}
                    {c.warning && <span className="rp-badge warn">⚠</span>}
                  </div>
                  <div className="rp-card-row">
                    问题 {c.after.issues.filter((x) => x.severity !== "ok").length} 个
                  </div>
                  <div className="rp-card-row">
                    动态 {compareResult.before.lra_lu.toFixed(1)}→{c.after.lra_lu.toFixed(1)} LU
                  </div>
                  <div className="rp-card-row">
                    评分 {c.objective.score.toFixed(2)}
                  </div>
                  <div className="rp-card-row">
                    AI PQ {c.critic ? c.critic.pq.toFixed(2) : "—"}
                  </div>
                </button>
              ))}
              <div className="rp-cards-note">
                {compareResult.reason} · AI 评分差 &lt; 0.1 视为无差别
              </div>
            </div>
          )}
          <div className="rp-advisor">
            <div className="rp-subtitle">AI 参谋</div>
            <textarea
              className="rp-advisor-text"
              placeholder="想要什么效果？例如：人声再亮一点、低频别那么轰（可留空）"
              value={advisorText}
              disabled={running || advising}
              onChange={(e) => setAdvisorText(e.target.value)}
              rows={2}
            />
            <div className="rp-advisor-row">
              <button
                className="btn btn-sm"
                disabled={running || advising || !llmReady || !before}
                title={!before ? "先完成一次修复/诊断" : undefined}
                onClick={askAdvisor}
              >
                {advising ? "AI 思考中…" : "让 AI 出方案"}
              </button>
              {!llmReady && (
                <button className="rp-link" onClick={onOpenAiSettings}>
                  先在设置里配置 AI 服务
                </button>
              )}
              {llmReady && !before && (
                <span className="rp-hint">先运行一次修复后可咨询</span>
              )}
            </div>
            {advisorError && <div className="rp-advisor-err">{advisorError}</div>}
            {proposal && (
              <div className="rp-proposal">
                <div className="rp-proposal-head">
                  <span className="rp-proposal-title">AI 方案</span>
                  <span className={`rp-badge conf-${proposal.confidence}`}>
                    {CONF_LABELS[proposal.confidence] ?? proposal.confidence}
                  </span>
                </div>
                {proposal.changes.length > 0 ? (
                  <ul className="rp-proposal-changes">
                    {proposal.changes.map((c) => (
                      <li key={c.field}>
                        <span className="rp-change-label">{c.label_zh}</span>
                        <span className="rp-change-vals">
                          {fmtAdvisorVal(c.from)} → {fmtAdvisorVal(c.to)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="rp-hint">AI 认为当前参数无需调整</div>
                )}
                {proposal.explanation.length > 0 && (
                  <ul className="rp-proposal-expl">
                    {proposal.explanation.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
                {proposal.warnings.length > 0 && (
                  <ul className="rp-proposal-warn">
                    {proposal.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                <div className="rp-proposal-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={running}
                    onClick={() => {
                      onApplyAdvisor(proposal.settings);
                      setProposal(null);
                    }}
                  >
                    采用并修复
                  </button>
                  <button
                    className="btn btn-sm"
                    disabled={running}
                    onClick={() => setProposal(null)}
                  >
                    放弃
                  </button>
                </div>
              </div>
            )}
            {advisorRegress && (
              <div className="rp-regress">
                <span>
                  AI 方案的规则评分比之前差（{advisorRegress.prevScore.toFixed(2)} →{" "}
                  {advisorRegress.newScore.toFixed(2)}），建议放弃
                </span>
                <button className="btn btn-sm" onClick={onRevertAdvisor}>
                  恢复之前的结果
                </button>
              </div>
            )}
          </div>
          {(running || progress) && (
            <div className="rp-progress">
              <div className="rp-progress-bar">
                <div style={{ width: `${Math.round(progress?.percent ?? 0)}%` }} />
              </div>
              <span className="rp-progress-label">
                修复中 · {STAGE_LABELS[progress?.stage ?? "analyze"] ?? progress?.stage}
              </span>
            </div>
          )}
          <details className="rp-adv">
            <summary>高级</summary>
            <div className="rp-sliders">
              {MODULE_LABELS.map((mm) => (
                <label key={mm.key} className="rp-slider">
                  <span className="rp-slider-label">{mm.label}</span>
                  <input
                    type="range"
                    min={0}
                    max={150}
                    step={5}
                    disabled={running}
                    value={Math.round(settings.modules[mm.key] * 100)}
                    onChange={(e) =>
                      setModuleAmount(mm.key, Number(e.target.value) / 100)
                    }
                  />
                  <span className="rp-slider-val">
                    {Math.round(settings.modules[mm.key] * 100)}%
                  </span>
                </label>
              ))}
              {TONE_FIELDS.map((t) => (
                <label key={t.key} className="rp-slider">
                  <span className="rp-slider-label">{t.label}</span>
                  <input
                    type="range"
                    min={-3}
                    max={3}
                    step={0.5}
                    disabled={running}
                    value={settings[t.key]}
                    onChange={(e) => setTone(t.key, Number(e.target.value))}
                  />
                  <span className="rp-slider-val">
                    {settings[t.key] > 0 ? "+" : ""}
                    {settings[t.key]} dB
                  </span>
                </label>
              ))}
            </div>
            <div className="rp-modules">
              <label className="rp-module">
                <input
                  type="checkbox"
                  checked={settings.modules.loudness}
                  disabled={running}
                  onChange={() => toggleModule("loudness")}
                />
                响度标准化
              </label>
              <label className="rp-module">
                <input
                  type="checkbox"
                  checked={settings.modules.drum_replace}
                  disabled={running}
                  onChange={() => toggleModule("drum_replace")}
                />
                鼓替换（实验性，叠加底鼓 / 军鼓）
              </label>
              <div className="seg rp-drumseg">
                {[
                  { v: 0.3, l: "30%" },
                  { v: 0.5, l: "50%" },
                  { v: 0.8, l: "80%" },
                ].map((o) => (
                  <button
                    key={o.v}
                    className={settings.drum_replace_amount === o.v ? "on" : ""}
                    disabled={running || !settings.modules.drum_replace}
                    onClick={() =>
                      onSettingsChange({ ...settings, drum_replace_amount: o.v })
                    }
                  >
                    {o.l}
                  </button>
                ))}
              </div>
            </div>
          </details>
          {result && result.notes.length > 0 && (
            <ul className="rp-notes">
              {result.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {result && (
        <div className="rp-ab">
          <audio ref={aRef} src={sourcePath ? resolveAudioUrl(sourcePath) : undefined} preload="auto" />
          <audio ref={bRef} src={resolveAudioUrl(result.output_path)} preload="auto" />
          <div className="seg rp-ab-seg">
            {showBlind ? (
              <>
                <button className={abSel === blindMap?.a ? "on" : ""} onClick={() => selectAb("a")}>
                  A
                </button>
                <button className={abSel === blindMap?.b ? "on" : ""} onClick={() => selectAb("b")}>
                  B
                </button>
              </>
            ) : (
              <>
                <button className={abSel === "orig" ? "on" : ""} onClick={() => selectAb("orig")}>
                  原曲
                </button>
                <button className={abSel === "rest" ? "on" : ""} onClick={() => selectAb("rest")}>
                  修复后
                </button>
              </>
            )}
          </div>
          <button className="btn btn-icon" onClick={toggleAb} title={abPlaying ? "暂停" : "播放"}>
            {abPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <input
            type="range"
            className="rp-ab-seek"
            min={0}
            max={Math.max(1, duration)}
            step={0.1}
            value={Math.min(abTime, duration)}
            onInput={(e) => {
              const t = Number((e.target as HTMLInputElement).value);
              if (aRef.current) aRef.current.currentTime = t;
              if (bRef.current) bRef.current.currentTime = t;
              setAbTime(t);
            }}
          />
          <span className="rp-ab-time">
            {fmtTime(abTime)} / {fmtTime(duration)}
          </span>
          <span className="rp-ab-match">{matchLabel}</span>
          <label className="rp-blind">
            <input
              type="checkbox"
              checked={blind}
              onChange={(e) => {
                const on = e.target.checked;
                setBlind(on);
                setRevealed(false);
                if (on) {
                  const first: "orig" | "rest" = Math.random() < 0.5 ? "orig" : "rest";
                  setBlindMap({ a: first, b: first === "orig" ? "rest" : "orig" });
                  selectAb("a");
                } else {
                  setAbSel("orig");
                  applyVols("orig");
                }
              }}
            />
            盲听
          </label>
          {blind && !revealed && (
            <button className="btn btn-sm" onClick={() => setRevealed(true)}>
              <Eye size={12} /> 揭晓
            </button>
          )}
          {revealed && blindMap && (
            <span className="rp-reveal">
              A = {blindMap.a === "orig" ? "原曲" : "修复后"} · B = {blindMap.b === "orig" ? "原曲" : "修复后"}
            </span>
          )}
          <span className="rp-ab-export">
            <span className="rp-label">导出</span>
            <span className="seg">
              {([24, 16] as const).map((d) => (
                <button
                  key={d}
                  className={exportDepth === d ? "on" : ""}
                  onClick={() => setExportDepth(d)}
                >
                  {d}-bit
                </button>
              ))}
            </span>
            <button className="btn btn-sm" onClick={() => onExport(exportDepth)}>
              <Download size={12} /> 导出 WAV
            </button>
          </span>
        </div>
      )}
    </div>
  );
};
