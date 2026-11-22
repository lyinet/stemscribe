import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode2,
  Layers,
  Printer,
  Redo2,
  Sparkles,
  Undo2,
  Volume2,
} from "lucide-react";
import { Accidental, Formatter, Renderer, Stave, StaveNote, TabNote, TabStave, Voice } from "vexflow";
import type { SynthTimbre } from "../lib/audioEngine";
import { parseChordSymbol } from "../lib/musicTheory";
import type { MidiNote } from "../types/music";
import { PianoRollEditor } from "./PianoRollEditor";

interface Props {
  stemName: string;
  bpm: number;
  currentTime: number;
  notes: MidiNote[];
  hasChords: boolean;
  keyTonic?: string;
  scalePitchClasses?: number[];
  midiAuditionEnabled: boolean;
  synthTimbre: SynthTimbre;
  canUndo: boolean;
  canRedo: boolean;
  onToggleMidiAudition: () => void;
  onTimbreChange: (t: SynthTimbre) => void;
  onUndo: () => void;
  onRedo: () => void;
  onQuantize: (subdiv: number) => void;
  onNotesChange: (nextNotes: MidiNote[]) => void;
  onExportMidi: () => void;
  onExportMidiWithChords: () => void;
  onExportMusicXml: () => void;
}

const NOTE_NAMES = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"];
const GUITAR_STRINGS_MIDI = [64, 59, 55, 50, 45, 40];
const JIANPU_MAP = ["1", "#1", "2", "#2", "3", "4", "#4", "5", "#5", "6", "#6", "7"];
const NOTES_PER_PAGE = 16;

function midiToVexKey(midi: number): { key: string; sharp: boolean } {
  const octave = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[midi % 12];
  return { key: `${name}/${octave}`, sharp: name.includes("#") };
}

function midiToGuitarPosition(midi: number): { str: number; fret: number } {
  for (let i = 0; i < GUITAR_STRINGS_MIDI.length; i++) {
    const fret = midi - GUITAR_STRINGS_MIDI[i];
    if (fret >= 0 && fret <= 15) {
      return { str: i + 1, fret };
    }
  }
  return { str: 3, fret: Math.max(0, Math.min(18, midi - 55)) };
}

function midiToJianpu(midi: number, tonicPc: number): { label: string; octaveShift: number } {
  const rel = midi - (60 + tonicPc);
  const octShift = Math.floor(rel / 12);
  const deg = ((rel % 12) + 12) % 12;
  return { label: JIANPU_MAP[deg], octaveShift: octShift };
}

export const ScoreViewer: React.FC<Props> = ({
  stemName,
  bpm,
  currentTime,
  notes,
  hasChords,
  keyTonic,
  scalePitchClasses,
  midiAuditionEnabled,
  synthTimbre,
  canUndo,
  canRedo,
  onToggleMidiAudition,
  onTimbreChange,
  onUndo,
  onRedo,
  onQuantize,
  onNotesChange,
  onExportMidi,
  onExportMidiWithChords,
  onExportMusicXml,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewMode, setViewMode] = useState<"pianoroll" | "staff" | "tab" | "jianpu">("pianoroll");
  const [clef, setClef] = useState<"treble" | "bass">("treble");
  const [pageIdx, setPageIdx] = useState(0);

  const totalPages = Math.max(1, Math.ceil(notes.length / NOTES_PER_PAGE));
  const safePage = Math.min(pageIdx, totalPages - 1);
  const pageNotes = useMemo(
    () => notes.slice(safePage * NOTES_PER_PAGE, (safePage + 1) * NOTES_PER_PAGE),
    [notes, safePage]
  );

  const tonicPc = useMemo(() => {
    if (!keyTonic) return 0;
    return parseChordSymbol(keyTonic)?.rootPc ?? 0;
  }, [keyTonic]);

  // Auto-select bass clef when transcribing bass stem
  useEffect(() => {
    if (stemName.toLowerCase().includes("bass")) {
      setClef("bass");
    }
  }, [stemName]);

  useEffect(() => {
    if (viewMode !== "staff" && viewMode !== "tab") return;
    const el = containerRef.current;
    if (!el) return;
    el.innerHTML = "";
    if (pageNotes.length === 0) return;

    const measures: MidiNote[][] = [];
    for (let i = 0; i < pageNotes.length; i += 4) {
      measures.push(pageNotes.slice(i, i + 4));
    }

    const measureW = 225;
    const totalW = Math.max(680, measures.length * measureW + 40);
    const renderer = new Renderer(el, Renderer.Backends.SVG);
    renderer.resize(totalW, viewMode === "tab" ? 190 : 175);
    const ctx = renderer.getContext();

    measures.forEach((group, mIdx) => {
      const x = 16 + mIdx * measureW;
      if (viewMode === "staff") {
        const stave = new Stave(x, 26, measureW);
        if (mIdx === 0) stave.addClef(clef).addTimeSignature("4/4");
        stave.setContext(ctx).draw();

        const vexNotes = group.map((n) => {
          const { key, sharp } = midiToVexKey(n.pitch);
          const sn = new StaveNote({
            clef,
            keys: [key],
            duration: "q",
          });
          if (sharp) {
            sn.addModifier(new Accidental("#"));
          }
          return sn;
        });
        while (vexNotes.length < 4) {
          vexNotes.push(new StaveNote({ clef, keys: [clef === "bass" ? "d/3" : "b/4"], duration: "qr" }));
        }
        const voice = new Voice({ num_beats: 4, beat_value: 4 });
        voice.addTickables(vexNotes);
        new Formatter().joinVoices([voice]).format([voice], measureW - 42);
        voice.draw(ctx, stave);
      } else {
        const tabStave = new TabStave(x, 24, measureW);
        if (mIdx === 0) tabStave.addClef("tab").addTimeSignature("4/4");
        tabStave.setContext(ctx).draw();

        const tabNotes = group.map((n) => {
          const pos = midiToGuitarPosition(n.pitch);
          return new TabNote({
            positions: [{ str: pos.str, fret: pos.fret }],
            duration: "q",
          });
        });
        while (tabNotes.length < 4) {
          tabNotes.push(new TabNote({ positions: [{ str: 3, fret: 0 }], duration: "q" }));
        }
        const voice = new Voice({ num_beats: 4, beat_value: 4 });
        voice.addTickables(tabNotes);
        new Formatter().joinVoices([voice]).format([voice], measureW - 36);
        voice.draw(ctx, tabStave);
      }
    });
  }, [pageNotes, viewMode, clef]);

  const handlePrintPdf = () => {
    if (viewMode === "pianoroll") {
      setViewMode("staff");
      setTimeout(() => window.print(), 250);
    } else {
      window.print();
    }
  };

  return (
    <div className="card">
      <div className="card-header" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="card-title" title="钢琴卷帘编辑与多视图乐谱导出">
          乐谱
          {stemName && (
            <span className="badge">
              {stemName} · {bpm.toFixed(1)} BPM · {notes.length} 音符
            </span>
          )}
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 5 }}>
          <button
            className={`btn btn-sm ${midiAuditionEnabled ? "btn-active" : ""}`}
            disabled={notes.length === 0}
            onClick={onToggleMidiAudition}
          >
            <Volume2 size={13} /> 跟播试听
          </button>
          <select
            className="select"
            value={synthTimbre}
            onChange={(e) => onTimbreChange(e.target.value as SynthTimbre)}
            style={{ width: 86, padding: "4px 6px", fontSize: 12 }}
            title="选择 MIDI 合成试听音色"
          >
            <option value="triangle">电钢音色</option>
            <option value="sine">贝斯柔和</option>
            <option value="sawtooth">合成锯齿</option>
            <option value="square">复古方波</option>
          </select>
          <button className="btn btn-sm" disabled={!canUndo} onClick={onUndo} title="撤销 (Cmd+Z)">
            <Undo2 size={13} />
          </button>
          <button
            className="btn btn-sm"
            disabled={!canRedo}
            onClick={onRedo}
            title="重做 (Cmd+Shift+Z)"
          >
            <Redo2 size={13} />
          </button>
          <button
            className="btn btn-sm"
            disabled={notes.length === 0}
            onClick={() => onQuantize(4)}
          >
            <Sparkles size={12} /> 1/16
          </button>
          <div className="seg">
            {(
              [
                ["pianoroll", "卷帘"],
                ["staff", "五线谱"],
                ["tab", "吉他谱"],
                ["jianpu", "简谱"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={viewMode === id ? "on" : ""} onClick={() => setViewMode(id)}>
                {label}
              </button>
            ))}
          </div>
          <button className="btn btn-sm" disabled={notes.length === 0} onClick={onExportMusicXml}>
            <FileCode2 size={13} /> XML
          </button>
          <button className="btn btn-sm" disabled={notes.length === 0} onClick={handlePrintPdf}>
            <Printer size={13} /> PDF
          </button>
          <button
            className="btn btn-sm"
            disabled={notes.length === 0 || !hasChords}
            onClick={onExportMidiWithChords}
            title="导出双轨 Type-1 MIDI（轨 1 主旋律 + 轨 2 和弦伴奏）"
          >
            <Layers size={13} /> 双轨 .mid
          </button>
          <button
            className="btn btn-sm btn-primary"
            disabled={notes.length === 0}
            onClick={onExportMidi}
          >
            <Download size={13} /> .mid
          </button>
        </div>
      </div>

      {viewMode !== "pianoroll" && notes.length > 0 && (
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
          <div className="row" style={{ gap: 6 }}>
            {viewMode === "staff" && (
              <>
                <span className="muted" style={{ fontSize: 11 }}>谱号</span>
                <div className="seg">
                  <button className={clef === "treble" ? "on" : ""} onClick={() => setClef("treble")}>
                    高音
                  </button>
                  <button className={clef === "bass" ? "on" : ""} onClick={() => setClef("bass")}>
                    低音
                  </button>
                </div>
              </>
            )}
            {viewMode === "jianpu" && (
              <span className="badge ok">
                首调简谱：1 = {keyTonic || "C"} · 4/4（高八度上方加点 / 低八度下方加点）
              </span>
            )}
          </div>

          <div className="row" style={{ gap: 6 }}>
            <button
              className="btn btn-sm"
              disabled={safePage <= 0}
              onClick={() => setPageIdx((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft size={12} /> 上一页
            </button>
            <span className="muted" style={{ fontSize: 11.5 }}>
              第 {safePage + 1} / {totalPages} 页
            </span>
            <button
              className="btn btn-sm"
              disabled={safePage >= totalPages - 1}
              onClick={() => setPageIdx((p) => Math.min(totalPages - 1, p + 1))}
            >
              下一页 <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}

      {notes.length === 0 && viewMode !== "pianoroll" ? (
        <div className="muted" style={{ padding: "26px 0", textAlign: "center" }}>
          点击任意音轨右侧的「转 MIDI」即可生成乐谱，或在「卷帘」视图中双击直接手绘音符。
        </div>
      ) : viewMode === "pianoroll" ? (
        <PianoRollEditor
          notes={notes}
          bpm={bpm}
          currentTime={currentTime}
          scalePitchClasses={scalePitchClasses}
          onChange={onNotesChange}
        />
      ) : viewMode === "jianpu" ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
            gap: 10,
            padding: 12,
            borderRadius: 10,
            background: "var(--bg)",
            border: "1px solid var(--border)",
          }}
        >
          {Array.from({ length: Math.ceil(pageNotes.length / 4) }, (_, barIdx) => {
            const group = pageNotes.slice(barIdx * 4, barIdx * 4 + 4);
            const globalBar = safePage * 4 + barIdx + 1;
            return (
              <div
                key={barIdx}
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                }}
              >
                <div className="muted" style={{ fontSize: 10.5, marginBottom: 6 }}>
                  第 {globalBar} 小节
                </div>
                <div style={{ display: "flex", justifyContent: "space-around", alignItems: "center", gap: 6 }}>
                  {group.map((n, nIdx) => {
                    const jp = midiToJianpu(n.pitch, tonicPc);
                    const active = currentTime >= n.start_sec && currentTime <= n.end_sec + 0.08;
                    return (
                      <div
                        key={nIdx}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          minWidth: 26,
                          padding: "4px 6px",
                          borderRadius: 6,
                          background: active ? "var(--accent-soft)" : "transparent",
                          border: active ? "1px solid var(--accent)" : "1px solid transparent",
                          color: active ? "#38bdf8" : "var(--text)",
                        }}
                      >
                        <span style={{ fontSize: 10, lineHeight: "8px", minHeight: 8 }}>
                          {jp.octaveShift > 0 ? "•".repeat(Math.min(2, jp.octaveShift)) : ""}
                        </span>
                        <span style={{ fontSize: 18, fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>
                          {jp.label}
                        </span>
                        <span style={{ fontSize: 10, lineHeight: "8px", minHeight: 8 }}>
                          {jp.octaveShift < 0 ? "•".repeat(Math.min(2, -jp.octaveShift)) : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="score-canvas-wrap" ref={containerRef} />
      )}
    </div>
  );
};
