import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Eye, Pause, Play, Sparkles } from "lucide-react";
import { resolveAudioUrl } from "../../lib/tauriApi";
import type {
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
  onExport: (bitDepth: 24 | 16) => void;
  sourcePath: string | null;
  sourceDuration: number;
  mainIsPlaying: boolean;
  onAbPlayingChange: (playing: boolean) => void;
}

const STAGE_LABELS: Record<string, string> = {
  analyze: "诊断",
  stems: "分轨处理",
  master: "母带",
  limit: "限幅",
  write: "写盘",
  report: "报告",
};

const MODULE_LABELS: Array<{ key: keyof RestoreSettings["modules"]; label: string }> = [
  { key: "vocal_cleanup", label: "人声清理" },
  { key: "shimmer", label: "去金属声" },
  { key: "drum_punch", label: "鼓点冲击" },
  { key: "low_end", label: "低频收紧" },
  { key: "width", label: "立体声展宽" },
  { key: "vocal_space", label: "人声让位" },
  { key: "hf_restore", label: "补高频" },
  { key: "glue", label: "整体粘合" },
  { key: "loudness", label: "响度标准化" },
];

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

/** Log-frequency LTAS plot: before (grey) vs after (accent). */
const SpectrumPlot: React.FC<{ before: QualityReport | null; after: QualityReport | null }> = ({
  before,
  after,
}) => {
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

    // dB range
    const all = [...(before?.ltas ?? []), ...(after?.ltas ?? [])];
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
  }, [before, after]);

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
  onExport,
  sourcePath,
  sourceDuration,
  mainIsPlaying,
  onAbPlayingChange,
}) => {
  const after = result?.after ?? null;
  const issues = useMemo(() => mergeIssues(before, after), [before, after]);

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
  const toggleModule = (key: keyof RestoreSettings["modules"]) =>
    onSettingsChange({
      ...settings,
      modules: { ...settings.modules, [key]: !settings.modules[key] },
    });

  const metricRows: Array<{ label: string; before: string; after: string | null }> = before
    ? [
        { label: "响度", before: `${fmtLufs(before.integrated_lufs)} LUFS`, after: after ? `${fmtLufs(after.integrated_lufs)} LUFS` : null },
        { label: "动态", before: `${before.lra_lu.toFixed(1)} LU`, after: after ? `${after.lra_lu.toFixed(1)} LU` : null },
        { label: "真峰值", before: `${before.true_peak_dbtp.toFixed(1)} dBTP`, after: after ? `${after.true_peak_dbtp.toFixed(1)} dBTP` : null },
        { label: "高频截止", before: cutoffLabel(before.cutoff_hz), after: after ? cutoffLabel(after.cutoff_hz) : null },
        { label: "规格", before: specLabel(before), after: after ? specLabel(after) : null },
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
          <SpectrumPlot before={before} after={after} />
          <div className="rp-legend">
            <span className="rp-swatch" style={{ background: "var(--text-3)" }} /> 修复前
            <span className="rp-swatch" style={{ background: "var(--accent)" }} /> 修复后
          </div>
        </section>

        <section className="rp-col">
          <div className="rp-title">修复</div>
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
          <button className="btn btn-primary rp-run" disabled={running} onClick={onRun}>
            <Sparkles size={13} /> {running ? "修复中…" : result ? "重新修复" : "开始修复"}
          </button>
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
            <div className="rp-modules">
              {MODULE_LABELS.map((mm) => (
                <label key={mm.key} className="rp-module">
                  <input
                    type="checkbox"
                    checked={settings.modules[mm.key]}
                    disabled={running}
                    onChange={() => toggleModule(mm.key)}
                  />
                  {mm.label}
                </label>
              ))}
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
