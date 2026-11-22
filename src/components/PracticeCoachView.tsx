import React, { useEffect, useMemo, useRef, useState } from "react";
import { Award, Download, Mic, MicOff, Radio, RotateCcw, Save, Share2, Trash2, TrendingUp, Trophy, Usb } from "lucide-react";
import { chordToPitchClasses, NOTE_NAMES_SHARP, transposeChordSymbol } from "../lib/musicTheory";
import { LiveMicPitchTracker, type PitchReading } from "../lib/pitchTracker";
import type { ChordEvent, MidiNote, PracticeRecord } from "../types/music";

interface Props {
  songName: string;
  isPlaying: boolean;
  currentTime: number;
  playbackRate: number;
  transposeSemitones: number;
  notes: MidiNote[];
  chords: ChordEvent[];
  records: PracticeRecord[];
  pressedHardwareNotes: number[];
  midiDeviceCount: number;
  onConnectMidi: () => void;
  onSaveRecord: (record: PracticeRecord) => void;
  onDeleteRecord: (recordId: string) => void;
  onExportRecordsCsv: () => void;
  onOpenShareCard: (latestScore: { accuracyPct: number; maxCombo: number; rank: string }) => void;
}

function calcRank(acc: number): "S" | "A" | "B" | "C" {
  if (acc >= 92) return "S";
  if (acc >= 80) return "A";
  if (acc >= 65) return "B";
  return "C";
}

export const PracticeCoachView: React.FC<Props> = ({
  songName,
  isPlaying,
  currentTime,
  playbackRate,
  transposeSemitones,
  notes,
  chords,
  records,
  pressedHardwareNotes,
  midiDeviceCount,
  onConnectMidi,
  onSaveRecord,
  onDeleteRecord,
  onExportRecordsCsv,
  onOpenShareCard,
}) => {
  const trackerRef = useRef<LiveMicPitchTracker | null>(null);
  const [micActive, setMicActive] = useState(false);
  const [simActive, setSimActive] = useState(false);
  const [micError, setMicError] = useState("");
  const [reading, setReading] = useState<PitchReading | null>(null);

  const [hits, setHits] = useState(0);
  const [totalChecks, setTotalChecks] = useState(0);
  const [combo, setCombo] = useState(0);
  const [maxCombo, setMaxCombo] = useState(0);
  const [lastFeedback, setLastFeedback] = useState<"hit" | "miss" | "idle">("idle");
  const lastEvaluatedNoteIdxRef = useRef<number>(-1);

  const activeNoteIdx = useMemo(
    () => notes.findIndex((n) => currentTime >= n.start_sec && currentTime <= n.end_sec + 0.12),
    [notes, currentTime]
  );
  const activeNote = activeNoteIdx >= 0 ? notes[activeNoteIdx] : null;

  const activeChord = useMemo(
    () => chords.find((c) => currentTime >= c.start_sec && currentTime < c.end_sec) ?? null,
    [chords, currentTime]
  );

  const expectedPcs = useMemo(() => {
    const s = new Set<number>();
    if (activeNote) s.add(((activeNote.pitch % 12) + 12) % 12);
    if (activeChord) {
      const sym = transposeChordSymbol(activeChord.symbol, transposeSemitones);
      for (const pc of chordToPitchClasses(sym)) s.add(pc);
    }
    return s;
  }, [activeNote, activeChord, transposeSemitones]);

  useEffect(() => {
    return () => {
      trackerRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    if (!simActive) return;
    const id = window.setInterval(() => {
      const targetMidi = activeNote ? activeNote.pitch : 64;
      const jitterCents = Math.round((Math.random() - 0.5) * 18);
      const midiFloat = targetMidi + jitterCents / 100;
      const freq = 440 * Math.pow(2, (midiFloat - 69) / 12);
      const pc = ((targetMidi % 12) + 12) % 12;
      const oct = Math.floor(targetMidi / 12) - 1;
      setReading({
        frequencyHz: freq,
        midiFloat,
        midiNote: targetMidi,
        noteName: `${NOTE_NAMES_SHARP[pc]}${oct}`,
        centsOff: jitterCents,
        rms: 0.18,
        clarity: 0.94,
      });
    }, 140);
    return () => window.clearInterval(id);
  }, [simActive, activeNote]);

  // Evaluate live pitch (from either Hardware USB-MIDI keyboard OR Mic/Sim) once per note event
  useEffect(() => {
    if (!isPlaying || activeNoteIdx < 0) return;
    if (lastEvaluatedNoteIdxRef.current === activeNoteIdx) return;

    const hasHardwareInput = pressedHardwareNotes.length > 0;
    const hasMicInput = (micActive || simActive) && reading !== null;
    if (!hasHardwareInput && !hasMicInput) return;

    let isHit = false;
    if (hasHardwareInput) {
      isHit = pressedHardwareNotes.some((p) => expectedPcs.has(((p % 12) + 12) % 12));
    } else if (reading) {
      isHit = expectedPcs.has(((reading.midiNote % 12) + 12) % 12);
    }

    lastEvaluatedNoteIdxRef.current = activeNoteIdx;
    setTotalChecks((t) => t + 1);
    if (isHit) {
      setHits((h) => h + 1);
      setCombo((c) => {
        const next = c + 1;
        setMaxCombo((m) => Math.max(m, next));
        return next;
      });
      setLastFeedback("hit");
    } else {
      setCombo(0);
      setLastFeedback("miss");
    }
  }, [isPlaying, micActive, simActive, reading, pressedHardwareNotes, activeNoteIdx, expectedPcs]);

  const toggleMic = async () => {
    setMicError("");
    if (micActive) {
      trackerRef.current?.stop();
      setMicActive(false);
      setReading(null);
      return;
    }
    setSimActive(false);
    try {
      if (!trackerRef.current) trackerRef.current = new LiveMicPitchTracker();
      await trackerRef.current.start((r) => setReading(r));
      setMicActive(true);
    } catch (err) {
      setMicError(String(err));
      setMicActive(false);
    }
  };

  const resetSession = () => {
    setHits(0);
    setTotalChecks(0);
    setCombo(0);
    setMaxCombo(0);
    setLastFeedback("idle");
    lastEvaluatedNoteIdxRef.current = -1;
  };

  const accuracyPct = totalChecks > 0 ? Math.round((hits / totalChecks) * 1000) / 10 : 0;
  const rank = calcRank(accuracyPct);

  const handleSave = () => {
    const rec: PracticeRecord = {
      id: `prac_${Date.now()}`,
      song_name: songName || "未命名曲目",
      timestamp: new Date().toLocaleString("zh-CN", { hour12: false }),
      accuracy_pct: accuracyPct,
      max_combo: maxCombo,
      playback_rate: playbackRate,
      rank,
      duration_sec: Math.round(currentTime),
    };
    onSaveRecord(rec);
  };

  const centsPosPct = reading ? ((reading.centsOff + 50) / 100) * 100 : 50;
  const inTune = reading ? Math.abs(reading.centsOff) <= 12 : false;

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">
          <Trophy size={16} color="#f59e0b" />
          <span>AI 练琴教练 · 实时调音器 & 麦克风 / USB-MIDI 跟弹打分</span>
          {totalChecks > 0 && (
            <span className="badge ok">
              {rank} 级 · 命中率 {accuracyPct.toFixed(1)}% · 连击 {combo}
            </span>
          )}
        </div>

        <div className="row" style={{ flexWrap: "wrap" }}>
          <button
            className={`btn btn-sm ${midiDeviceCount > 0 ? "btn-active" : ""}`}
            onClick={onConnectMidi}
            title="接入 USB-MIDI 电钢琴实现零延迟复音跟弹判定"
          >
            <Usb size={13} /> {midiDeviceCount > 0 ? `已连 ${midiDeviceCount} 台 MIDI` : "连接 USB-MIDI"}
          </button>
          <button
            className={`btn btn-sm ${micActive ? "btn-primary" : ""}`}
            onClick={toggleMic}
          >
            {micActive ? <MicOff size={13} /> : <Mic size={13} />}
            {micActive ? "关闭麦克风" : "开启麦克风/声卡"}
          </button>
          <button
            className={`btn btn-sm ${simActive ? "btn-active" : ""}`}
            onClick={() => {
              if (micActive) {
                trackerRef.current?.stop();
                setMicActive(false);
              }
              setSimActive((v) => !v);
            }}
            title="无外接乐器时模拟精准音高信号体验打分"
          >
            <Radio size={13} /> {simActive ? "停止模拟" : "模拟测试"}
          </button>
          <button className="btn btn-sm" onClick={resetSession} title="重置本次打分">
            <RotateCcw size={13} /> 重置
          </button>
          <button
            className="btn btn-sm"
            disabled={totalChecks === 0}
            onClick={handleSave}
          >
            <Save size={13} /> 保存记录
          </button>
          <button
            className="btn btn-sm btn-active"
            onClick={() => onOpenShareCard({ accuracyPct, maxCombo, rank })}
          >
            <Share2 size={13} /> 生成分享卡片
          </button>
        </div>
      </div>

      {micError && (
        <div className="section-pill" style={{ borderColor: "var(--rose)", color: "#fda4af" }}>
          麦克风启动失败：{micError}（请在 macOS 系统设置 → 隐私与安全性 → 麦克风 中授权，或使用 USB-MIDI / 模拟测试）
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1.15fr 1fr", gap: 14 }}>
        <div
          style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: 14,
          }}
        >
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <span className="muted">实时高精度十二平均律调音器 (75–1200 Hz)</span>
            <span className="muted">
              {pressedHardwareNotes.length > 0
                ? `MIDI 按键: ${pressedHardwareNotes.map((p) => `${NOTE_NAMES_SHARP[p % 12]}${Math.floor(p / 12) - 1}`).join(" ")}`
                : reading
                ? `${reading.frequencyHz.toFixed(1)} Hz`
                : "等待音频 / MIDI 输入..."}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 12, margin: "6px 0 12px" }}>
            <span
              style={{
                fontSize: 44,
                fontWeight: 800,
                color:
                  pressedHardwareNotes.length > 0
                    ? "#22c55e"
                    : reading
                    ? inTune
                      ? "#22c55e"
                      : "#f59e0b"
                    : "#475569",
                minWidth: 88,
                textAlign: "center",
              }}
            >
              {pressedHardwareNotes.length > 0
                ? `${NOTE_NAMES_SHARP[pressedHardwareNotes[0] % 12]}${Math.floor(pressedHardwareNotes[0] / 12) - 1}`
                : reading
                ? reading.noteName
                : "--"}
            </span>
            <span className="badge" style={{ fontSize: 12 }}>
              {pressedHardwareNotes.length > 0
                ? "USB-MIDI 零误差"
                : reading
                ? `${reading.centsOff >= 0 ? "+" : ""}${reading.centsOff} 音分${inTune ? " · 准音" : ""}`
                : "静音"}
            </span>
          </div>

          <div style={{ position: "relative", height: 14, borderRadius: 7, background: "#1e293b", overflow: "hidden" }}>
            <div
              style={{
                position: "absolute",
                left: "38%",
                width: "24%",
                top: 0,
                bottom: 0,
                background: "rgba(34, 197, 94, 0.25)",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: 0,
                bottom: 0,
                width: 2,
                background: "rgba(255,255,255,0.4)",
              }}
            />
            {(reading || pressedHardwareNotes.length > 0) && (
              <div
                style={{
                  position: "absolute",
                  left: pressedHardwareNotes.length > 0 ? "calc(50% - 5px)" : `calc(${centsPosPct}% - 5px)`,
                  top: 2,
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: pressedHardwareNotes.length > 0 || inTune ? "#22c55e" : "#f59e0b",
                  boxShadow: `0 0 10px ${pressedHardwareNotes.length > 0 || inTune ? "#22c55e" : "#f59e0b"}`,
                  transition: "left 0.08s linear",
                }}
              />
            )}
          </div>
          <div className="row" style={{ justifyContent: "space-between", marginTop: 4, fontSize: 10.5 }}>
            <span className="muted">-50¢ 偏低</span>
            <span className="muted">0¢ 标准音 A4=440Hz</span>
            <span className="muted">+50¢ 偏高</span>
          </div>
        </div>

        <div
          style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: 14,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted">跟弹/跟唱实时判定</span>
            <span
              className="badge"
              style={{
                color:
                  lastFeedback === "hit"
                    ? "#22c55e"
                    : lastFeedback === "miss"
                    ? "#f43f5e"
                    : "var(--muted)",
              }}
            >
              {lastFeedback === "hit" ? "PERFECT 命中!" : lastFeedback === "miss" ? "偏移 · 再试一次" : "播放后自动计分"}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, margin: "10px 0" }}>
            <div style={{ textAlign: "center", padding: 8, borderRadius: 8, background: "var(--surface)" }}>
              <div className="muted">当前评级</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: rank === "S" ? "#f59e0b" : "#60a5fa" }}>
                {totalChecks > 0 ? rank : "-"}
              </div>
            </div>
            <div style={{ textAlign: "center", padding: 8, borderRadius: 8, background: "var(--surface)" }}>
              <div className="muted">音准命中率</div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
                {accuracyPct.toFixed(0)}%
              </div>
            </div>
            <div style={{ textAlign: "center", padding: 8, borderRadius: 8, background: "var(--surface)" }}>
              <div className="muted">最高连击</div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: "#38bdf8" }}>
                {maxCombo}
              </div>
            </div>
          </div>

          <div className="muted" style={{ fontSize: 11.5 }}>
            目标音符：{activeNote ? `${NOTE_NAMES_SHARP[activeNote.pitch % 12]}${Math.floor(activeNote.pitch / 12) - 1}` : "—"} · 当前倍速：{Math.round(playbackRate * 100)}%
          </div>
        </div>
      </div>

      {records.length > 0 && (() => {
        const recent = records.slice(0, 12).reverse();
        const bestAcc = Math.max(...records.map((r) => r.accuracy_pct));
        const sCount = records.filter((r) => r.rank === "S").length;
        const avgRate = Math.round(
          (records.reduce((acc, r) => acc + r.playback_rate, 0) / records.length) * 100
        );
        const svgW = 420;
        const svgH = 74;
        const pts = recent.map((r, i) => {
          const x = recent.length === 1 ? svgW / 2 : 14 + (i / (recent.length - 1)) * (svgW - 28);
          const y = svgH - 12 - (Math.max(0, Math.min(100, r.accuracy_pct)) / 100) * (svgH - 22);
          return { x, y, r };
        });
        const poly = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
        return (
          <div style={{ marginTop: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
              <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                <TrendingUp size={14} color="#38bdf8" />
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>练琴成长趋势（最近 {recent.length} 次）</span>
                <span className="badge">累计 {records.length} 次</span>
                <span className="badge ok">最高 {bestAcc.toFixed(0)}%</span>
                <span className="badge">S 级 ×{sCount}</span>
                <span className="badge">均速 {avgRate}%</span>
              </div>
              <button className="btn btn-sm" onClick={onExportRecordsCsv} title="导出 UTF-8 CSV 练琴日志（Excel / Numbers 兼容）">
                <Download size={12} /> 导出 .csv
              </button>
            </div>

            {recent.length >= 2 && (
              <div
                style={{
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "6px 10px",
                  marginBottom: 8,
                }}
              >
                <svg viewBox={`0 0 ${svgW} ${svgH}`} style={{ width: "100%", height: 74, display: "block" }}>
                  <line x1={12} y1={svgH - 12} x2={svgW - 12} y2={svgH - 12} stroke="var(--border)" strokeDasharray="3 3" />
                  <line x1={12} y1={14} x2={svgW - 12} y2={14} stroke="rgba(34,197,94,0.28)" strokeDasharray="3 3" />
                  <polyline fill="none" stroke="#38bdf8" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" points={poly} />
                  {pts.map((p) => (
                    <g key={p.r.id}>
                      <circle cx={p.x} cy={p.y} r={3.6} fill={p.r.rank === "S" ? "#f59e0b" : "#38bdf8"} />
                      <title>{`${p.r.song_name}: ${p.r.accuracy_pct.toFixed(1)}% (${p.r.rank}级, ${Math.round(p.r.playback_rate * 100)}%速)`}</title>
                    </g>
                  ))}
                </svg>
              </div>
            )}

            <div className="row" style={{ marginBottom: 6 }}>
              <Award size={14} color="#9aa3b2" />
              <span className="muted">最近练琴记录（本地持久化）</span>
            </div>
            <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
              {records.slice(0, 8).map((r) => (
                <div
                  key={r.id}
                  style={{
                    minWidth: 172,
                    padding: "8px 10px",
                    borderRadius: 8,
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    fontSize: 12,
                  }}
                >
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
                    <strong style={{ color: r.rank === "S" ? "#f59e0b" : "#93c5fd" }}>{r.rank} 级</strong>
                    <div className="row" style={{ gap: 6 }}>
                      <span>{r.accuracy_pct.toFixed(0)}%</span>
                      <button
                        className="btn btn-sm"
                        style={{ padding: "1px 4px" }}
                        onClick={() => onDeleteRecord(r.id)}
                        title="删除该条记录"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                  <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.song_name}
                  </div>
                  <div className="muted" style={{ fontSize: 10.5, marginTop: 2 }}>
                    连击 {r.max_combo} · {Math.round(r.playback_rate * 100)}% 速
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
};
