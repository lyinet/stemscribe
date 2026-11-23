import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { translateIssue } from "../../lib/backendI18n";
import { t } from "../../i18n";
import type { I18nKey } from "../../i18n";
import { Download, Eye, Pause, Play, Sparkles, X } from "lucide-react";
import { adviseRestoration, pickAudioFile, resolveAudioUrl } from "../../lib/tauriApi";
import type {
  AdvisorInput,
  AdvisorResult,
  AgentProgress,
  AgentResult,
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
  /** 多轮自动修复（实验性） */
  onRunAgent: (userRequest: string) => void;
  agentRunning: boolean;
  onStopAgent: () => void;
  agentProgressRows: AgentProgress[];
  agentResult: AgentResult | null;
}

const STAGE_LABEL_KEYS: Record<string, string> = {
  analyze: "rp.stage.analyze",
  stems: "rp.stage.stems",
  master: "rp.stage.master",
  limit: "rp.stage.limit",
  write: "rp.stage.write",
  report: "rp.stage.report",
  compare_light: "rp.stage.compareLight",
  compare_standard: "rp.stage.compareStandard",
  compare_strong: "rp.stage.compareStrong",
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

const MODULE_LABEL_KEYS: Array<{ key: AmountModule; labelKey: string }> = [
  { key: "vocal_cleanup", labelKey: "rp.mod.vocalCleanup" },
  { key: "shimmer", labelKey: "rp.mod.shimmer" },
  { key: "drum_punch", labelKey: "rp.mod.drumPunch" },
  { key: "low_end", labelKey: "rp.mod.lowEnd" },
  { key: "width", labelKey: "rp.mod.width" },
  { key: "vocal_space", labelKey: "rp.mod.vocalSpace" },
  { key: "hf_restore", labelKey: "rp.mod.hfRestore" },
  { key: "glue", labelKey: "rp.mod.glue" },
];

const TONE_FIELDS: Array<{ key: ToneKey; labelKey: string }> = [
  { key: "vocal_level_db", labelKey: "rp.tone.vocalLevel" },
  { key: "vocal_presence_db", labelKey: "rp.tone.vocalPresence" },
  { key: "vocal_air_db", labelKey: "rp.tone.vocalAir" },
  { key: "low_shelf_db", labelKey: "rp.tone.lowShelf" },
  { key: "high_shelf_db", labelKey: "rp.tone.highShelf" },
];

const CONF_LABEL_KEYS: Record<string, string> = {
  low: "rp.conf.low",
  medium: "rp.conf.medium",
  high: "rp.conf.high",
};

const AGENT_STAGE_LABEL_KEYS: Record<string, string> = {
  prepare: "rp.agent.prepare",
  advise: "rp.agent.advise",
  render: "rp.agent.render",
  score: "rp.agent.score",
  done: "rp.agent.done",
};

const STOP_REASON_LABEL_KEYS: Record<string, string> = {
  max_rounds: "rp.stop.maxRounds",
  no_changes: "rp.stop.noChanges",
  no_improvement: "rp.stop.noImprovement",
  target_reached: "rp.stop.targetReached",
  advisor_error: "rp.stop.advisorError",
  render_error: "rp.stop.renderError",
  cancelled: "rp.stop.cancelled",
};

function fmtAdvisorVal(v: number | boolean): string {
  return typeof v === "boolean" ? (v ? t("rp.on") : t("rp.off")) : `${v}`;
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
  return hz && hz < 19000 ? `${(hz / 1000).toFixed(1)} kHz` : t("rp.full");
}

function specLabel(r: QualityReport): string {
  const khz = (r.sample_rate / 1000).toFixed(r.sample_rate % 1000 === 0 ? 0 : 1);
  const bd = r.bit_depth ? `${r.bit_depth}-bit` : t("rp.lossy");
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
      ctx.fillText(t("rp.delta"), 2, mid + 3);
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
      rows.push({ issue: translateIssue(iss), state: "before" });
    } else {
      const a = afterMap.get(iss.id);
      if (!a || a.severity === "ok" || SEV_ORDER[a.severity] < SEV_ORDER[iss.severity]) {
        rows.push({ issue: translateIssue(iss), state: "fixed", afterSeverity: a?.severity });
      } else {
        rows.push({ issue: translateIssue(a), state: "still" });
      }
    }
  }
  if (after) {
    for (const iss of after.issues) {
      if (iss.severity === "ok" || seen.has(iss.id)) continue;
      rows.push({ issue: translateIssue(iss), state: "new" });
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
  onRunAgent,
  agentRunning,
  onStopAgent,
  agentProgressRows,
  agentResult,
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
      ? t("rp.matched")
      : matchDb < 0
        ? t("rp.matchedAfter", { db: matchDb.toFixed(1) })
        : t("rp.matchedOrig", { db: (-matchDb).toFixed(1) });

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
        { label: t("rp.m.loudness"), before: `${fmtLufs(before.integrated_lufs)} LUFS`, after: after ? `${fmtLufs(after.integrated_lufs)} LUFS` : null },
        { label: t("rp.m.dynamics"), before: `${before.lra_lu.toFixed(1)} LU`, after: after ? `${after.lra_lu.toFixed(1)} LU` : null },
        { label: t("rp.m.truePeak"), before: `${before.true_peak_dbtp.toFixed(1)} dBTP`, after: after ? `${after.true_peak_dbtp.toFixed(1)} dBTP` : null },
        { label: t("rp.m.hfCutoff"), before: cutoffLabel(before.cutoff_hz), after: after ? cutoffLabel(after.cutoff_hz) : null },
        { label: t("rp.m.spec"), before: specLabel(before), after: after ? specLabel(after) : null },
        ...(result?.reference
          ? [
              {
                label: t("rp.m.refGap"),
                before: `${result.reference.distance_before_db.toFixed(1)} dB`,
                after: `${result.reference.distance_after_db.toFixed(1)} dB`,
              },
            ]
          : []),
        ...(result?.objective
          ? [
              {
                label: t("rp.m.ruleScore"),
                before: "—",
                after: `S = ${result.objective.score.toFixed(2)}`,
              },
            ]
          : []),
        ...(result?.critic
          ? [
              {
                label: t("rp.m.aiScore"),
                before: result.critic_before
                  ? result.critic_before.pq.toFixed(2)
                  : "—",
                after:
                  result.critic.pq.toFixed(2) +
                  (result.guard_rung && result.guard_rung !== "full"
                    ? `（${result.guard_rung === "half" ? t("rp.guardHalf") : t("rp.guardLoudOnly")}）`
                    : ""),
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
          <div className="rp-title">{t("rp.diagnosis")}</div>
          {!before && <div className="rp-hint">{t("rp.diagHint")}</div>}
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
                  {row.state === "fixed" && <span className="rp-tag ok">{t("rp.fixed")}</span>}
                  {row.state === "still" && <span className="rp-tag warn">{t("rp.still")}</span>}
                  {row.state === "new" && <span className="rp-tag new">{t("rp.new")}</span>}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rp-col">
          <div className="rp-title">{t("rp.spectrum")}</div>
          <SpectrumPlot before={before} after={after} reference={result?.reference?.report ?? null} />
          <div className="rp-legend">
            <span className="rp-swatch" style={{ background: "var(--text-3)" }} /> {t("rp.before")}
            <span className="rp-swatch" style={{ background: "var(--accent)" }} /> {t("rp.after")}
            {result?.reference && <span className="rp-swatch dashed" />} {result?.reference ? t("rp.reference") : null}
          </div>
        </section>

        <section className="rp-col">
          <div className="rp-title">{t("rp.restore")}</div>
          <div className="rp-row">
            <span className="rp-label">{t("rp.reference")}</span>
            {settings.reference_path ? (
              <span className="rp-chip" title={settings.reference_path}>
                {settings.reference_path.split("/").pop()}
                <button
                  className="rp-chip-x"
                  disabled={running}
                  title={t("rp.clearRef")}
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
                {t("rp.pickRef")}
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
                {t("rp.followRef")}
              </label>
            </div>
          )}
          <div className="rp-row">
            <span className="rp-label">{t("rp.strength")}</span>
            <div className="seg">
              {[
                { v: 0.5, l: t("rp.strength.light") },
                { v: 1.0, l: t("rp.strength.standard") },
                { v: 1.5, l: t("rp.strength.heavy") },
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
            <span className="rp-label">{t("rp.target")}</span>
            <div className="seg">
              {[
                { v: -14, l: t("rp.target.streaming") },
                { v: -12, l: t("rp.target.louder") },
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
              <Sparkles size={13} /> {running ? t("rp.restoring") : result ? t("rp.reRestore") : t("rp.startRestore")}
            </button>
            <button className="btn rp-run" disabled={running} onClick={onRunCompare}>
              {running ? t("rp.comparing") : t("rp.compare")}
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
                    <span className="rp-card-name">{t("rp.strengthCard", { label: c.strength_label })}</span>
                    {i === compareResult.recommended && (
                      <span className="rp-badge">{t("rp.recommended")}</span>
                    )}
                    {c.warning && <span className="rp-badge warn">⚠</span>}
                  </div>
                  <div className="rp-card-row">
                    {t("rp.issues", { n: c.after.issues.filter((x) => x.severity !== "ok").length })}
                  </div>
                  <div className="rp-card-row">
                    {t("rp.dynamicsDelta", { b: compareResult.before.lra_lu.toFixed(1), a: c.after.lra_lu.toFixed(1) })}
                  </div>
                  <div className="rp-card-row">
                    {t("rp.scoreVal", { s: c.objective.score.toFixed(2) })}
                  </div>
                  <div className="rp-card-row">
                    AI PQ {c.critic ? c.critic.pq.toFixed(2) : "—"}
                  </div>
                </button>
              ))}
              <div className="rp-cards-note">
                {compareResult.reason} · {t("rp.compareNote")}
              </div>
            </div>
          )}
          <div className="rp-advisor">
            <div className="rp-subtitle">{t("rp.advisor")}</div>
            <textarea
              className="rp-advisor-text"
              placeholder={t("rp.advisorPlaceholder")}
              value={advisorText}
              disabled={running || advising}
              onChange={(e) => setAdvisorText(e.target.value)}
              rows={2}
            />
            <div className="rp-advisor-row">
              <button
                className="btn btn-sm"
                disabled={running || advising || agentRunning || !llmReady || !before}
                title={!before ? t("rp.needDiag") : undefined}
                onClick={askAdvisor}
              >
                {advising ? t("rp.thinking") : t("rp.advise")}
              </button>
              <button
                className="btn btn-sm"
                disabled={running || advising || agentRunning || !llmReady || !before}
                title={t("rp.agentTip")}
                onClick={() => onRunAgent(advisorText)}
              >
                {agentRunning ? t("rp.agentRunning") : t("rp.agent")}
              </button>
              {agentRunning && (
                <button className="btn btn-sm" onClick={onStopAgent}>
                  {t("rp.stop")}
                </button>
              )}
              {!llmReady && (
                <button className="rp-link" onClick={onOpenAiSettings}>
                  {t("rp.needAiConfig")}
                </button>
              )}
              {llmReady && !before && (
                <span className="rp-hint">{t("rp.needRun")}</span>
              )}
            </div>
            {advisorError && <div className="rp-advisor-err">{advisorError}</div>}
            {(agentRunning || agentResult) && (
              <div className="rp-agent-timeline">
                {(agentResult ? agentResult.history : agentProgressRows).map((row) => {
                  if ("stage" in row && !("accepted" in row)) {
                    const p = row as AgentProgress;
                    return (
                      <div key={`p${p.round}`} className="rp-agent-row running">
                        <span className="rp-agent-round">
                          {p.round === 0 ? t("rp.baseline") : t("rp.round", { n: p.round })}
                        </span>
                        <span className="rp-agent-stage">
                          {AGENT_STAGE_LABEL_KEYS[p.stage] ? t(AGENT_STAGE_LABEL_KEYS[p.stage] as I18nKey) : p.stage} ·{" "}
                          {Math.round(p.percent)}%
                        </span>
                      </div>
                    );
                  }
                  const r = row as AgentResult["history"][number];
                  const changeStr =
                    r.changes.length > 0
                      ? r.changes
                          .map(
                            (c) =>
                              `${c.label_zh} ${fmtAdvisorVal(c.from)}→${fmtAdvisorVal(c.to)}`,
                          )
                          .join("、")
                      : r.round === 0
                        ? t("rp.currentParams")
                        : t("rp.noChanges");
                  return (
                    <div
                      key={`h${r.round}`}
                      className={`rp-agent-row${r.accepted ? "" : " rejected"}`}
                    >
                      <span className="rp-agent-round">
                        {r.round === 0 ? t("rp.baseline") : t("rp.round", { n: r.round })}
                      </span>
                      <span className="rp-agent-detail">{changeStr}</span>
                      {r.score != null && (
                        <span className="rp-agent-score">S={r.score.toFixed(2)}</span>
                      )}
                      <span className="rp-agent-verdict">
                        {r.error
                          ? t("rp.failed", { err: r.error })
                          : r.accepted
                            ? t("rp.adopted")
                            : t("rp.rejectedSuffix", { reason: r.reject_reason ?? "" })}
                      </span>
                    </div>
                  );
                })}
                {agentResult && (
                  <div className="rp-agent-summary">
                    {(() => {
                      const s0 = agentResult.history[0]?.score;
                      const sb = agentResult.history.find(
                        (r) => r.round === agentResult.best_round && r.accepted,
                      )?.score;
                      const rej = agentResult.history
                        .filter((r) => r.round > 0 && !r.accepted)
                        .map(
                          (r) =>
                            t("rp.roundRejected", { n: r.round, reason: r.reject_reason ? `：${r.reject_reason}` : r.error ? `：${r.error}` : "" }),
                        )
                        .join("；");
                      return `${
                        agentResult.best_round === 0 ? t("rp.baseline") : t("rp.round", { n: agentResult.best_round })
                      }${t("rp.best", { s0: s0 != null ? s0.toFixed(2) : "?" })} → ${
                        sb != null ? sb.toFixed(2) : agentResult.best.objective?.score.toFixed(2) ?? "?"
                      }${rej ? `；${rej}` : ""}（${STOP_REASON_LABEL_KEYS[agentResult.stop_reason] ? t(STOP_REASON_LABEL_KEYS[agentResult.stop_reason] as I18nKey) : agentResult.stop_reason}）`;
                    })()}
                  </div>
                )}
              </div>
            )}
            {proposal && (
              <div className="rp-proposal">
                <div className="rp-proposal-head">
                  <span className="rp-proposal-title">{t("rp.proposal")}</span>
                  <span className={`rp-badge conf-${proposal.confidence}`}>
                    {CONF_LABEL_KEYS[proposal.confidence] ? t(CONF_LABEL_KEYS[proposal.confidence] as I18nKey) : proposal.confidence}
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
                  <div className="rp-hint">{t("rp.noAdjust")}</div>
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
                    {t("rp.applyAndRestore")}
                  </button>
                  <button
                    className="btn btn-sm"
                    disabled={running}
                    onClick={() => setProposal(null)}
                  >
                    {t("rp.discard")}
                  </button>
                </div>
              </div>
            )}
            {advisorRegress && (
              <div className="rp-regress">
                <span>
                  {t("rp.regress", { prev: advisorRegress.prevScore.toFixed(2), next: advisorRegress.newScore.toFixed(2) })}
                </span>
                <button className="btn btn-sm" onClick={onRevertAdvisor}>
                  {t("rp.revertResult")}
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
                {t("rp.progress", { stage: STAGE_LABEL_KEYS[progress?.stage ?? "analyze"] ? t(STAGE_LABEL_KEYS[progress?.stage ?? "analyze"] as I18nKey) : (progress?.stage ?? "") })}
              </span>
            </div>
          )}
          <details className="rp-adv">
            <summary>{t("rp.advanced")}</summary>
            <div className="rp-sliders">
              {MODULE_LABEL_KEYS.map((mm) => (
                <label key={mm.key} className="rp-slider">
                  <span className="rp-slider-label">{t(mm.labelKey as I18nKey)}</span>
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
              {TONE_FIELDS.map((fld) => (
                <label key={fld.key} className="rp-slider">
                  <span className="rp-slider-label">{t(fld.labelKey as I18nKey)}</span>
                  <input
                    type="range"
                    min={-3}
                    max={3}
                    step={0.5}
                    disabled={running}
                    value={settings[fld.key]}
                    onChange={(e) => setTone(fld.key, Number(e.target.value))}
                  />
                  <span className="rp-slider-val">
                    {settings[fld.key] > 0 ? "+" : ""}
                    {settings[fld.key]} dB
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
                {t("rp.loudnessNorm")}
              </label>
              <label className="rp-module">
                <input
                  type="checkbox"
                  checked={settings.modules.drum_replace}
                  disabled={running}
                  onChange={() => toggleModule("drum_replace")}
                />
                {t("rp.drumReplace")}
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
                  {t("rp.original")}
                </button>
                <button className={abSel === "rest" ? "on" : ""} onClick={() => selectAb("rest")}>
                  {t("rp.after")}
                </button>
              </>
            )}
          </div>
          <button className="btn btn-icon" onClick={toggleAb} title={abPlaying ? t("wave.pause") : t("wave.play")}>
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
            {t("rp.blind")}
          </label>
          {blind && !revealed && (
            <button className="btn btn-sm" onClick={() => setRevealed(true)}>
              <Eye size={12} /> {t("rp.reveal")}
            </button>
          )}
          {revealed && blindMap && (
            <span className="rp-reveal">
              A = {blindMap.a === "orig" ? t("rp.original") : t("rp.after")} · B = {blindMap.b === "orig" ? t("rp.original") : t("rp.after")}
            </span>
          )}
          <span className="rp-ab-export">
            <span className="rp-label">{t("rp.export")}</span>
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
              <Download size={12} /> {t("rp.exportWav")}
            </button>
          </span>
        </div>
      )}
    </div>
  );
};
