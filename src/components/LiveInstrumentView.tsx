import React, { useEffect, useMemo, useState } from "react";
import { Guitar, Keyboard, Piano, Sparkles, Usb } from "lucide-react";
import {
  chordToPitchClasses,
  GUITAR_TUNINGS,
  NOTE_NAMES_SHARP,
  recommendCapoFrets,
  transposeChordSymbol,
} from "../lib/musicTheory";
import { t } from "../i18n";
import type { MidiInputDeviceInfo } from "../lib/webMidi";
import type { ChordEvent, MidiNote } from "../types/music";

interface Props {
  notes: MidiNote[];
  chords: ChordEvent[];
  currentTime: number;
  transposeSemitones: number;
  useFlats?: boolean;
  capoFret: number;
  scalePitchClasses?: number[];
  midiDevices: MidiInputDeviceInfo[];
  pressedHardwareNotes: number[];
  onConnectMidi: () => void;
  onCapoChange: (fret: number) => void;
  onAuditionNote: (midiPitch: number) => void;
}

const FRET_MARKERS = new Set([3, 5, 7, 9, 12, 15]);

const QWERTY_OFFSETS: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ";": 16,
};

export const LiveInstrumentView: React.FC<Props> = ({
  notes,
  chords,
  currentTime,
  transposeSemitones,
  useFlats,
  capoFret,
  scalePitchClasses,
  midiDevices,
  pressedHardwareNotes,
  onConnectMidi,
  onCapoChange,
  onAuditionNote,
}) => {
  const [tuningId, setTuningId] = useState<string>("standard");
  const [qwertyEnabled, setQwertyEnabled] = useState<boolean>(false);
  const [qwertyOctave, setQwertyOctave] = useState<number>(4);
  const [qwertyPressed, setQwertyPressed] = useState<number[]>([]);
  const activeTuning = useMemo(
    () => GUITAR_TUNINGS.find((t) => t.id === tuningId) ?? GUITAR_TUNINGS[0],
    [tuningId]
  );
  const activeMidiSet = useMemo(() => {
    const s = new Set<number>();
    for (const n of notes) {
      if (currentTime >= n.start_sec && currentTime <= n.end_sec + 0.08) {
        s.add(n.pitch);
      }
    }
    return s;
  }, [notes, currentTime]);

  useEffect(() => {
    if (!qwertyEnabled) {
      setQwertyPressed([]);
      return;
    }
    const baseMidi = (qwertyOctave + 1) * 12;
    const isTypingTarget = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "z") {
        setQwertyOctave((o) => Math.max(3, o - 1));
        return;
      }
      if (k === "x") {
        setQwertyOctave((o) => Math.min(5, o + 1));
        return;
      }
      if (k in QWERTY_OFFSETS) {
        e.preventDefault();
        const midi = baseMidi + QWERTY_OFFSETS[k];
        onAuditionNote(midi);
        setQwertyPressed((prev) => (prev.includes(midi) ? prev : [...prev, midi]));
      }
    };
    const onUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k in QWERTY_OFFSETS) {
        const midi = baseMidi + QWERTY_OFFSETS[k];
        setQwertyPressed((prev) => prev.filter((p) => p !== midi));
      }
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [qwertyEnabled, qwertyOctave, onAuditionNote]);

  const hardwareSet = useMemo(
    () => new Set([...pressedHardwareNotes, ...qwertyPressed]),
    [pressedHardwareNotes, qwertyPressed]
  );

  const activeChord = useMemo(
    () => chords.find((c) => currentTime >= c.start_sec && currentTime < c.end_sec) ?? chords[0] ?? null,
    [chords, currentTime]
  );

  const soundingChordSymbol = activeChord
    ? transposeChordSymbol(activeChord.symbol, transposeSemitones, useFlats)
    : null;
  const capoChordShape = soundingChordSymbol
    ? transposeChordSymbol(soundingChordSymbol, -capoFret, useFlats)
    : null;

  const activeChordPcs = useMemo(
    () => new Set(soundingChordSymbol ? chordToPitchClasses(soundingChordSymbol) : []),
    [soundingChordSymbol]
  );

  const scaleSet = useMemo(
    () => new Set(scalePitchClasses ?? []),
    [scalePitchClasses]
  );

  const capoRecommendations = useMemo(
    () => recommendCapoFrets(chords, transposeSemitones, useFlats),
    [chords, transposeSemitones, useFlats]
  );
  const topCapo = capoRecommendations[0];

  // Build 4-octave piano keys: C3 (48) to B6 (95)
  const pianoKeys = useMemo(() => {
    const white: number[] = [];
    const black: Array<{ midi: number; leftIndex: number }> = [];
    let whiteCount = 0;
    for (let midi = 48; midi <= 95; midi++) {
      const pc = midi % 12;
      const isBlack = [1, 3, 6, 8, 10].includes(pc);
      if (isBlack) {
        black.push({ midi, leftIndex: whiteCount - 1 });
      } else {
        white.push(midi);
        whiteCount++;
      }
    }
    return { white, black };
  }, []);

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">
          <Piano size={14} />
          <span>{t("live.title")}</span>
          {soundingChordSymbol && (
            <span className="badge ok">
              {t("live.soundingChord", { chord: soundingChordSymbol })}
              {capoFret > 0 && capoChordShape ? t("live.capoShape", { fret: capoFret, shape: capoChordShape }) : ""}
            </span>
          )}
        </div>

        <div className="row" style={{ flexWrap: "wrap" }}>
          <button
            className={`btn btn-sm ${qwertyEnabled ? "btn-active" : ""}`}
            onClick={() => setQwertyEnabled((v) => !v)}
            title={t("live.qwertyTip")}
          >
            <Keyboard size={13} /> {qwertyEnabled ? t("live.qwertyOn", { oct: `C${qwertyOctave}` }) : t("live.qwertyOff")}
          </button>
          <button
            className={`btn btn-sm ${midiDevices.length > 0 ? "btn-active" : ""}`}
            onClick={onConnectMidi}
            title={t("live.midiTip")}
          >
            <Usb size={12} />
            {midiDevices.length > 0 ? `MIDI: ${midiDevices[0].name.slice(0, 14)}` : t("live.midiConnect")}
          </button>
          <Guitar size={14} color="#9aa3b2" />
          <span className="muted">{t("live.capo")}</span>
          <select
            className="select"
            style={{ width: 92, padding: "4px 8px" }}
            value={capoFret}
            onChange={(e) => onCapoChange(Number(e.target.value))}
          >
            {Array.from({ length: 10 }, (_, i) => (
              <option key={i} value={i}>
                {i === 0 ? t("capo.none") : t("capo.atFret", { fret: i })}
              </option>
            ))}
          </select>
          {topCapo && topCapo.fret !== capoFret && chords.length > 0 && (
            <button
              className="btn btn-sm btn-active"
              onClick={() => onCapoChange(topCapo.fret)}
              title={t("live.capoSuggestTip")}
            >
              <Sparkles size={12} /> {t("live.capoSuggest", { label: topCapo.label })}
            </button>
          )}
        </div>
      </div>

      {/* 4-Octave Interactive Piano Keyboard */}
      <div style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
          <span className="muted">
            {t("live.keyboardLegend")}
          </span>
        </div>
        <div style={{ position: "relative", height: 108, userSelect: "none", overflowX: "auto" }}>
          <div style={{ position: "relative", display: "flex", height: "100%", minWidth: 680 }}>
            {pianoKeys.white.map((midi) => {
              const pc = midi % 12;
              const isHardware = hardwareSet.has(midi);
              const isMelody = activeMidiSet.has(midi);
              const isChordTone = activeChordPcs.has(pc);
              const isScale = scaleSet.has(pc);
              const bg = isHardware
                ? "#22c55e"
                : isMelody
                ? "#3b82f6"
                : isChordTone
                ? "#fde68a"
                : "#f8fafc";
              return (
                <div
                  key={midi}
                  onMouseDown={() => onAuditionNote(midi)}
                  title={`${NOTE_NAMES_SHARP[pc]}${Math.floor(midi / 12) - 1} (MIDI ${midi})`}
                  style={{
                    flex: 1,
                    height: "100%",
                    background: bg,
                    border: "1px solid #cbd5e1",
                    borderBottomLeftRadius: 5,
                    borderBottomRightRadius: 5,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "flex-end",
                    alignItems: "center",
                    paddingBottom: 5,
                    cursor: "pointer",
                    color: isHardware || isMelody ? "#fff" : "#334155",
                    fontSize: 10,
                    fontWeight: pc === 0 || isMelody || isHardware ? 700 : 400,
                    transition: "background 0.06s",
                  }}
                >
                  {isScale && !isMelody && !isHardware && (
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background: isChordTone ? "#d97706" : "#94a3b8",
                        marginBottom: 3,
                      }}
                    />
                  )}
                  {pc === 0 ? `C${Math.floor(midi / 12) - 1}` : ""}
                </div>
              );
            })}

            {pianoKeys.black.map(({ midi, leftIndex }) => {
              const pc = midi % 12;
              const isHardware = hardwareSet.has(midi);
              const isMelody = activeMidiSet.has(midi);
              const isChordTone = activeChordPcs.has(pc);
              const whiteWidthPct = 100 / pianoKeys.white.length;
              const leftPct = (leftIndex + 0.68) * whiteWidthPct;
              return (
                <div
                  key={midi}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    onAuditionNote(midi);
                  }}
                  title={`${NOTE_NAMES_SHARP[pc]}${Math.floor(midi / 12) - 1}`}
                  style={{
                    position: "absolute",
                    left: `${leftPct}%`,
                    width: `${whiteWidthPct * 0.64}%`,
                    height: "62%",
                    top: 0,
                    background: isHardware
                      ? "#16a34a"
                      : isMelody
                      ? "#2563eb"
                      : isChordTone
                      ? "#f59e0b"
                      : "#1e293b",
                    border: "1px solid #0f172a",
                    borderBottomLeftRadius: 4,
                    borderBottomRightRadius: 4,
                    zIndex: 3,
                    cursor: "pointer",
                    boxShadow: "0 3px 6px rgba(0,0,0,0.35)",
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* 6-String Interactive Guitar Fretboard */}
      <div>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 6 }}>
          <span className="muted">
            {t("live.fretboardLegend")}
          </span>
          <div className="row" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: 11.5 }}>{t("live.tuning")}</span>
            <select
              className="select"
              value={tuningId}
              onChange={(e) => setTuningId(e.target.value)}
              style={{ width: 148, padding: "3px 8px", fontSize: 11.5 }}
            >
              {GUITAR_TUNINGS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.labelKey ? t(preset.labelKey) : preset.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div
          style={{
            background: "#1c1917",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "10px 12px",
            overflowX: "auto",
          }}
        >
          <div style={{ minWidth: 680 }}>
            <div style={{ display: "grid", gridTemplateColumns: "34px repeat(16, 1fr)", marginBottom: 4 }}>
              <div />
              {Array.from({ length: 16 }, (_, fret) => (
                <div
                  key={fret}
                  style={{
                    textAlign: "center",
                    fontSize: 10,
                    color: fret === capoFret && capoFret > 0 ? "#fbbf24" : FRET_MARKERS.has(fret) ? "#e2e8f0" : "#64748b",
                    fontWeight: fret === capoFret || FRET_MARKERS.has(fret) ? 700 : 400,
                  }}
                >
                  {fret === capoFret && capoFret > 0 ? `C${fret}` : fret}
                </div>
              ))}
            </div>

            {activeTuning.openMidi.map((openMidi, sIdx) => (
              <div
                key={`${activeTuning.id}_${sIdx}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "34px repeat(16, 1fr)",
                  alignItems: "center",
                  height: 24,
                  position: "relative",
                }}
              >
                <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600 }}>
                  {activeTuning.stringLabels[sIdx]}
                </div>
                {Array.from({ length: 16 }, (_, fret) => {
                  const midi = openMidi + fret;
                  const pc = midi % 12;
                  const isMelody = activeMidiSet.has(midi);
                  const isChord = activeChordPcs.has(pc) && fret >= capoFret && fret <= capoFret + 4;
                  const isCapoBar = capoFret > 0 && fret === capoFret;
                  return (
                    <div
                      key={fret}
                      onClick={() => onAuditionNote(midi)}
                      title={t("live.stringFret", { string: activeTuning.stringLabels[sIdx], fret, note: `${NOTE_NAMES_SHARP[pc]}${Math.floor(midi / 12) - 1}` })}
                      style={{
                        height: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        position: "relative",
                        borderRight: fret === 0 ? "3px solid #e2e8f0" : "1px solid #44403c",
                        background: isCapoBar ? "rgba(251, 191, 36, 0.22)" : "transparent",
                        cursor: "pointer",
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          left: 0,
                          right: 0,
                          height: 1 + sIdx * 0.35,
                          background: "#a8a29e",
                          opacity: 0.65,
                        }}
                      />
                      {(isMelody || isChord) && (
                        <div
                          style={{
                            position: "relative",
                            zIndex: 2,
                            width: 19,
                            height: 19,
                            borderRadius: "50%",
                            background: isMelody ? "#3b82f6" : "#f59e0b",
                            color: "#fff",
                            fontSize: 9.5,
                            fontWeight: 700,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            boxShadow: isMelody
                              ? "0 0 10px rgba(59, 130, 246, 0.8)"
                              : "0 0 6px rgba(245, 158, 11, 0.5)",
                          }}
                        >
                          {NOTE_NAMES_SHARP[pc]}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
