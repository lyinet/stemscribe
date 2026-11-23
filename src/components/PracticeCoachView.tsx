import React, { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
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
  useFlats?: boolean;
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
  useFlats,
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
      const sym = transposeChordSymbol(activeChord.symbol, transposeSemitones, useFlats);
      for (const pc of chordToPitchClasses(sym)) s.add(pc);
    }
    return s;
  }, [activeNote, activeChord, transposeSemitones, useFlats]);

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
      song_name: songName || t("coach.untitled"),
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
        <div className="card-title" title={t("coach.titleTip")}>
          <Trophy size={14} color="#f59e0b" />
          <span>{t("coach.title")}</span>
          {totalChecks > 0 && (
            <span className="badge ok">
              {t("coach.summary", { rank, acc: accuracyPct.toFixed(1), combo })}
            </span>
          )}
        </div>

        <div className="row" style={{ flexWrap: "wrap" }}>
          <button
            className={`btn btn-sm ${midiDeviceCount > 0 ? "btn-active" : ""}`}
            onClick={onConnectMidi}
            title={t("coach.midiTip")}
          >
            <Usb size={13} /> {midiDeviceCount > 0 ? t("coach.midiConnected", { n: midiDeviceCount }) : t("coach.connectMidi")}
          </button>
          <button
            className={`btn btn-sm ${micActive ? "btn-primary" : ""}`}
            onClick={toggleMic}
          >
            {micActive ? <MicOff size={13} /> : <Mic size={13} />}
            {micActive ? t("coach.micOff") : t("coach.micOn")}
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
            title={t("coach.simTip")}
          >
            <Radio size={13} /> {simActive ? t("coach.simStop") : t("coach.simStart")}
          </button>
          <button className="btn btn-sm" onClick={resetSession} title={t("coach.resetTip")}>
            <RotateCcw size={13} /> {t("coach.reset")}
          </button>
          <button
            className="btn btn-sm"
            disabled={totalChecks === 0}
            onClick={handleSave}
          >
            <Save size={13} /> {t("coach.save")}
          </button>
          <button
            className="btn btn-sm btn-active"
            onClick={() => onOpenShareCard({ accuracyPct, maxCombo, rank })}
          >
            <Share2 size={13} /> {t("coach.share")}
          </button>
        </div>
      </div>

      {micError && (
        <div className="section-pill" style={{ borderColor: "var(--rose)", color: "#fda4af" }}>
          {t("coach.micError", { err: micError })}
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
            <span className="muted">{t("coach.tuner")}</span>
            <span className="muted">
              {pressedHardwareNotes.length > 0
                ? t("coach.midiKeys", { notes: pressedHardwareNotes.map((p) => `${NOTE_NAMES_SHARP[p % 12]}${Math.floor(p / 12) - 1}`).join(" ") })
                : reading
                ? `${reading.frequencyHz.toFixed(1)} Hz`
                : t("coach.waiting")}
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
                ? t("coach.midiExact")
                : reading
                ? t("coach.cents", { sign: reading.centsOff >= 0 ? "+" : "", cents: reading.centsOff, suffix: inTune ? t("coach.inTune") : "" })
                : t("coach.silent")}
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
            <span className="muted">{t("coach.flat")}</span>
            <span className="muted">{t("coach.a440")}</span>
            <span className="muted">{t("coach.sharp")}</span>
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
            <span className="muted">{t("coach.judge")}</span>
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
              {lastFeedback === "hit" ? t("coach.hit") : lastFeedback === "miss" ? t("coach.miss") : t("coach.idle")}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, margin: "10px 0" }}>
            <div style={{ textAlign: "center", padding: 8, borderRadius: 8, background: "var(--surface)" }}>
              <div className="muted">{t("coach.rank")}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: rank === "S" ? "#f59e0b" : "#60a5fa" }}>
                {totalChecks > 0 ? rank : "-"}
              </div>
            </div>
            <div style={{ textAlign: "center", padding: 8, borderRadius: 8, background: "var(--surface)" }}>
              <div className="muted">{t("coach.accuracy")}</div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
                {accuracyPct.toFixed(0)}%
              </div>
            </div>
            <div style={{ textAlign: "center", padding: 8, borderRadius: 8, background: "var(--surface)" }}>
              <div className="muted">{t("coach.maxCombo")}</div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: "#38bdf8" }}>
                {maxCombo}
              </div>
            </div>
          </div>

          <div className="muted" style={{ fontSize: 11.5 }}>
            {t("coach.target", { note: activeNote ? `${NOTE_NAMES_SHARP[activeNote.pitch % 12]}${Math.floor(activeNote.pitch / 12) - 1}` : "—", rate: Math.round(playbackRate * 100) })}
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
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t("coach.trend", { n: recent.length })}</span>
                <span className="badge">{t("coach.total", { n: records.length })}</span>
                <span className="badge ok">{t("coach.best", { pct: bestAcc.toFixed(0) })}</span>
                <span className="badge">{t("coach.sCount", { n: sCount })}</span>
                <span className="badge">{t("coach.avgRate", { pct: avgRate })}</span>
              </div>
              <button className="btn btn-sm" onClick={onExportRecordsCsv} title={t("coach.csvTip")}>
                <Download size={12} /> {t("coach.exportCsv")}
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
                      <title>{t("coach.recordTip", { name: p.r.song_name, acc: p.r.accuracy_pct.toFixed(1), rank: p.r.rank, rate: Math.round(p.r.playback_rate * 100) })}</title>
                    </g>
                  ))}
                </svg>
              </div>
            )}

            <div className="row" style={{ marginBottom: 6 }}>
              <Award size={14} color="#9aa3b2" />
              <span className="muted">{t("coach.recent")}</span>
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
                    <strong style={{ color: r.rank === "S" ? "#f59e0b" : "#93c5fd" }}>{t("coach.rankSuffix", { rank: r.rank })}</strong>
                    <div className="row" style={{ gap: 6 }}>
                      <span>{r.accuracy_pct.toFixed(0)}%</span>
                      <button
                        className="btn btn-sm"
                        style={{ padding: "1px 4px" }}
                        onClick={() => onDeleteRecord(r.id)}
                        title={t("coach.deleteTip")}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                  <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.song_name}
                  </div>
                  <div className="muted" style={{ fontSize: 10.5, marginTop: 2 }}>
                    {t("coach.recordMeta", { combo: r.max_combo, rate: Math.round(r.playback_rate * 100) })}
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
