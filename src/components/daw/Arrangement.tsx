import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  Layers,
  Loader2,
  Maximize,
  Music2,
  Pencil,
  Plus,
  Sparkles,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { transposeChordSymbol } from "../../lib/musicTheory";
import type {
  ChordEvent,
  MidiNote,
  SectionMarker,
  SongStructureSegment,
  StemMixerState,
} from "../../types/music";

export interface ArrangementTrack {
  id: string;
  name: string;
  subtitle: string;
  color: string;
  peaks: number[];
  isOriginal: boolean;
}

interface Props {
  durationSec: number;
  currentTime: number;
  isPlaying: boolean;
  bpm: number;
  tracks: ArrangementTrack[];
  mixer: Record<string, StemMixerState>;
  transcribingStem: string | null;
  separating: boolean;
  structure: SongStructureSegment[];
  detectingStructure: boolean;
  chords: ChordEvent[];
  detectingChords: boolean;
  transposeSemitones: number;
  markers: SectionMarker[];
  notes: MidiNote[];
  midiLabel: string;
  loopEnabled: boolean;
  loopA: number;
  loopB: number;
  emptyState: React.ReactNode;
  onSeek: (sec: number) => void;
  onSetLoop: (a: number, b: number) => void;
  onMixerChange: (trackId: string, patch: Partial<StemMixerState>) => void;
  onTranscribeTrack: (trackId: string) => void;
  onSeparate: () => void;
  onDetectStructure: () => void;
  onConvertStructureToMarkers: () => void;
  onDetectChords: () => void;
  onOpenChordEditor: () => void;
  onAddMarker: () => void;
  onDeleteMarker: (id: string) => void;
  onOpenMidiEditor: () => void;
}

const HEADER_W = 232;
const ZOOM_LEVELS = [1, 1.5, 2, 3, 4, 6, 8];

const SECTION_COLORS: Record<string, string> = {
  intro: "#38bdf8",
  verse: "#818cf8",
  chorus: "#f43f5e",
  bridge: "#c084fc",
  outro: "#4ade80",
};

function WaveformClipCanvas({ peaks, color, width }: { peaks: number[]; color: string; width: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.min(4096, Math.round(width * dpr)));
    const h = Math.round(44 * dpr);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const n = peaks.length;
    if (n === 0) return;
    const mid = h / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1 || 1)) * w;
      ctx.lineTo(x, mid - Math.max(0.02, peaks[i]) * (mid - 2));
    }
    for (let i = n - 1; i >= 0; i--) {
      const x = (i / (n - 1 || 1)) * w;
      ctx.lineTo(x, mid + Math.max(0.02, peaks[i]) * (mid - 2));
    }
    ctx.closePath();
    ctx.fill();
  }, [peaks, color, width]);
  return <canvas ref={ref} className="clip-canvas" />;
}

function MidiClipCanvas({
  notes,
  pxPerSec,
  width,
}: {
  notes: MidiNote[];
  pxPerSec: number;
  width: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(1, 4096 / Math.max(1, width * dpr));
    const w = Math.max(1, Math.round(width * dpr * scale));
    const h = Math.round(40 * dpr);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx || notes.length === 0) return;
    let lo = 127;
    let hi = 0;
    for (const n of notes) {
      lo = Math.min(lo, n.pitch);
      hi = Math.max(hi, n.pitch);
    }
    const range = Math.max(12, hi - lo + 1);
    const rowH = h / range;
    const k = pxPerSec * dpr * scale;
    ctx.fillStyle = "#4ade80";
    for (const n of notes) {
      const x = n.start_sec * k;
      const nw = Math.max(1.5, (n.end_sec - n.start_sec) * k);
      const y = h - (n.pitch - lo + 1) * rowH;
      ctx.fillRect(x, y, nw, Math.max(1.5, rowH - 0.5));
    }
  }, [notes, pxPerSec, width]);
  return <canvas ref={ref} className="clip-canvas" />;
}

export const Arrangement: React.FC<Props> = ({
  durationSec,
  currentTime,
  isPlaying,
  bpm,
  tracks,
  mixer,
  transcribingStem,
  separating,
  structure,
  detectingStructure,
  chords,
  detectingChords,
  transposeSemitones,
  markers,
  notes,
  midiLabel,
  loopEnabled,
  loopA,
  loopB,
  emptyState,
  onSeek,
  onSetLoop,
  onMixerChange,
  onTranscribeTrack,
  onSeparate,
  onDetectStructure,
  onConvertStructureToMarkers,
  onDetectChords,
  onOpenChordEditor,
  onAddMarker,
  onDeleteMarker,
  onOpenMidiEditor,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportW, setViewportW] = useState(900);
  const [zoomIdx, setZoomIdx] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth));
    ro.observe(el);
    setViewportW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const notesEnd = notes.reduce((m, n) => Math.max(m, n.end_sec), 0);
  const total = Math.max(durationSec, notesEnd, 1);
  const hasContent = tracks.length > 0 || notes.length > 0;
  const laneW = Math.max(240, (viewportW - HEADER_W - 2) * ZOOM_LEVELS[zoomIdx]);
  const pxPerSec = laneW / total;
  const x = (t: number) => Math.max(0, Math.min(laneW, t * pxPerSec));

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isPlaying || zoomIdx === 0) return;
    const px = currentTime * pxPerSec;
    const visible = el.clientWidth - HEADER_W;
    if (px < el.scrollLeft || px > el.scrollLeft + visible - 40) {
      el.scrollLeft = Math.max(0, px - 80);
    }
  }, [currentTime, isPlaying, pxPerSec, zoomIdx]);

  const rulerTicks = useMemo(() => {
    const barSec = 240 / Math.max(1, bpm);
    const barPx = barSec * pxPerSec;
    let step = 1;
    while (barPx * step < 56) step *= 2;
    const beatPx = barPx / 4;
    const out: Array<{ left: number; label: string | null; major: boolean }> = [];
    const bars = Math.ceil(total / barSec);
    for (let b = 0; b <= bars; b++) {
      const left = b * barPx;
      if (left > laneW) break;
      const labeled = b % step === 0;
      if (labeled || barPx >= 14) out.push({ left, label: labeled ? String(b + 1) : null, major: labeled });
      if (beatPx >= 14) {
        for (let k = 1; k < 4; k++) {
          const bl = left + k * beatPx;
          if (bl < laneW) out.push({ left: bl, label: null, major: false });
        }
      }
    }
    return out;
  }, [bpm, pxPerSec, total, laneW]);

  const timeFromEvent = (e: { clientX: number }, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(total, (e.clientX - rect.left) / pxPerSec));
  };

  const handleRulerMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const startT = timeFromEvent(e, el);
    const startX = e.clientX;
    let dragging = false;
    const move = (ev: MouseEvent) => {
      if (!dragging && Math.abs(ev.clientX - startX) < 4) return;
      dragging = true;
      const t = timeFromEvent(ev, el);
      onSetLoop(Math.min(startT, t), Math.max(startT, t));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (!dragging) onSeek(startT);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const seekFromLane = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    onSeek(timeFromEvent(e, e.currentTarget));
  };

  const chordBlocks = useMemo(
    () =>
      chords.map((c, i) => ({
        ...c,
        end: chords[i + 1]?.start_sec ?? Math.max(c.end_sec, c.start_sec + 0.5),
        label: transposeChordSymbol(c.symbol, transposeSemitones),
      })),
    [chords, transposeSemitones]
  );

  const showLoop = loopEnabled && loopB > loopA;

  return (
    <div className="arr">
      <div className="arr-scroll" ref={scrollRef}>
        <div className="arr-content" style={{ width: HEADER_W + laneW }}>
          <div className="arr-row arr-ruler-row">
            <div className="arr-head arr-corner">
              <span className="arr-corner-title">轨道</span>
              <div className="arr-zoom">
                <button
                  className="icon-btn"
                  disabled={zoomIdx === 0}
                  onClick={() => setZoomIdx((z) => Math.max(0, z - 1))}
                  title="缩小"
                >
                  <ZoomOut size={13} />
                </button>
                <button className="icon-btn" disabled={zoomIdx === 0} onClick={() => setZoomIdx(0)} title="适合窗口">
                  <Maximize size={12} />
                </button>
                <button
                  className="icon-btn"
                  disabled={zoomIdx === ZOOM_LEVELS.length - 1}
                  onClick={() => setZoomIdx((z) => Math.min(ZOOM_LEVELS.length - 1, z + 1))}
                  title="放大"
                >
                  <ZoomIn size={13} />
                </button>
              </div>
            </div>
            <div
              className="arr-lane arr-ruler"
              style={{ width: laneW }}
              onMouseDown={handleRulerMouseDown}
              title="点击跳转 · 拖动框选循环区"
            >
              {showLoop && <div className="ruler-loop" style={{ left: x(loopA), width: x(loopB) - x(loopA) }} />}
              {rulerTicks.map((t, i) => (
                <div key={i} className={`ruler-tick ${t.major ? "major" : ""}`} style={{ left: t.left }}>
                  {t.label && <span>{t.label}</span>}
                </div>
              ))}
              <div className="ruler-playhead" style={{ left: x(currentTime) }} />
            </div>
          </div>

          <div className="arr-row arr-meta-row">
            <div className="arr-head meta-head">
              <span className="meta-title">段落</span>
              <div className="meta-actions">
                <button
                  className="icon-btn"
                  disabled={!durationSec || detectingStructure}
                  onClick={onDetectStructure}
                  title="自动识别前奏 / 主歌 / 副歌"
                >
                  {detectingStructure ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                </button>
                <button
                  className="icon-btn"
                  disabled={structure.length === 0}
                  onClick={onConvertStructureToMarkers}
                  title="全部转为书签"
                >
                  <Bookmark size={13} />
                </button>
              </div>
            </div>
            <div className="arr-lane" style={{ width: laneW }} onClick={seekFromLane}>
              {structure.map((seg) => {
                const color = SECTION_COLORS[seg.kind] ?? "#94a3b8";
                return (
                  <div
                    key={seg.id}
                    className="sec-block"
                    style={{
                      left: x(seg.start_sec),
                      width: Math.max(2, x(seg.end_sec) - x(seg.start_sec) - 2),
                      background: `${color}2e`,
                      borderColor: `${color}99`,
                      color,
                    }}
                    title={`${seg.label} · 单击跳转，双击循环本段`}
                    onClick={() => onSeek(seg.start_sec)}
                    onDoubleClick={() => onSetLoop(seg.start_sec, seg.end_sec)}
                  >
                    {seg.label}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="arr-row arr-meta-row">
            <div className="arr-head meta-head">
              <span className="meta-title">和弦</span>
              <div className="meta-actions">
                <button
                  className="icon-btn"
                  disabled={!durationSec || detectingChords}
                  onClick={onDetectChords}
                  title="自动识别和弦"
                >
                  {detectingChords ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                </button>
                <button className="icon-btn" onClick={onOpenChordEditor} title="打开和弦编辑器">
                  <Pencil size={12} />
                </button>
              </div>
            </div>
            <div className="arr-lane" style={{ width: laneW }} onClick={seekFromLane}>
              {chordBlocks.map((c, i) => {
                const active = currentTime >= c.start_sec && currentTime < c.end;
                return (
                  <div
                    key={`${c.start_sec}_${i}`}
                    className={`chord-block ${active ? "active" : ""}`}
                    style={{ left: x(c.start_sec), width: Math.max(2, x(c.end) - x(c.start_sec) - 1) }}
                    title={`${c.label} · ${c.start_sec.toFixed(1)}s`}
                    onClick={() => onSeek(c.start_sec)}
                  >
                    {c.label}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="arr-row arr-meta-row small">
            <div className="arr-head meta-head">
              <span className="meta-title">书签</span>
              <div className="meta-actions">
                <button className="icon-btn" disabled={!durationSec} onClick={onAddMarker} title="在播放位置加书签 (K)">
                  <Plus size={13} />
                </button>
              </div>
            </div>
            <div className="arr-lane" style={{ width: laneW }} onClick={seekFromLane}>
              {markers.map((m, i) => {
                const next = markers[i + 1]?.time_sec ?? total;
                return (
                  <div
                    key={m.id}
                    className="marker-flag"
                    style={{ left: x(m.time_sec) }}
                    title={`${m.label} · 单击跳转，双击循环到下一个书签`}
                    onClick={() => onSeek(m.time_sec)}
                    onDoubleClick={() => onSetLoop(m.time_sec, next)}
                  >
                    <span>{m.label}</span>
                    <button
                      className="marker-del"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteMarker(m.id);
                      }}
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {tracks.map((t) => {
            const st = mixer[t.id] ?? { muted: false, solo: false, gain: 1, pan: 0 };
            return (
              <div key={t.id} className="arr-row arr-track-row">
                <div className="arr-head track-head" style={{ ["--track-color" as string]: t.color }}>
                  <div className="track-title">
                    <span className="track-name">{t.name}</span>
                    <span className="track-sub">{t.subtitle}</span>
                  </div>
                  <div className="track-controls">
                    <button
                      className={`ms-btn ${st.muted ? "mute-on" : ""}`}
                      onClick={() => onMixerChange(t.id, { muted: !st.muted })}
                      title="静音"
                    >
                      {st.muted ? <VolumeX size={11} /> : "M"}
                    </button>
                    <button
                      className={`ms-btn ${st.solo ? "solo-on" : ""}`}
                      onClick={() => onMixerChange(t.id, { solo: !st.solo })}
                      title="独奏"
                    >
                      S
                    </button>
                    <Volume2 size={12} className="track-vol-icon" />
                    <input
                      className="track-slider"
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={st.gain}
                      onChange={(e) => onMixerChange(t.id, { gain: Number(e.target.value) })}
                      title={`音量 ${Math.round(st.gain * 100)}%`}
                    />
                    {t.isOriginal ? (
                      <button
                        className="track-action"
                        disabled={separating}
                        onClick={onSeparate}
                        title="用 AI 分离成 人声 / 鼓 / 贝斯 / 其他 4 轨"
                      >
                        {separating ? <Loader2 size={11} className="spin" /> : <Layers size={11} />}
                        {separating ? "分轨中" : "AI 分轨"}
                      </button>
                    ) : (
                      <button
                        className="track-action"
                        disabled={transcribingStem !== null}
                        onClick={() => onTranscribeTrack(t.id)}
                        title="把这一轨扒成 MIDI 音符"
                      >
                        {transcribingStem === t.id ? <Loader2 size={11} className="spin" /> : <Music2 size={11} />}
                        {transcribingStem === t.id ? "扒谱中" : "转 MIDI"}
                      </button>
                    )}
                  </div>
                </div>
                <div className="arr-lane" style={{ width: laneW }}>
                  <div
                    className={`clip ${st.muted ? "muted" : ""}`}
                    style={{ width: x(durationSec), ["--track-color" as string]: t.color }}
                    onClick={(e) => onSeek(timeFromEvent(e, e.currentTarget))}
                  >
                    <span className="clip-label">{t.name}</span>
                    <WaveformClipCanvas peaks={t.peaks} color={t.color} width={x(durationSec)} />
                  </div>
                </div>
              </div>
            );
          })}

          {notes.length > 0 && (
            <div className="arr-row arr-track-row">
              <div className="arr-head track-head" style={{ ["--track-color" as string]: "#4ade80" }}>
                <div className="track-title">
                  <span className="track-name">MIDI 旋律</span>
                  <span className="track-sub">
                    {midiLabel || "转谱结果"} · {notes.length} 音符
                  </span>
                </div>
                <div className="track-controls">
                  <button className="track-action" onClick={onOpenMidiEditor} title="在下方编辑器中打开">
                    <Pencil size={11} /> 编辑音符
                  </button>
                </div>
              </div>
              <div className="arr-lane" style={{ width: laneW }}>
                <div
                  className="clip midi"
                  style={{ width: x(notesEnd) + 4, ["--track-color" as string]: "#4ade80" }}
                  onClick={(e) => onSeek(timeFromEvent(e, e.currentTarget))}
                  onDoubleClick={onOpenMidiEditor}
                  title="双击打开钢琴卷帘编辑"
                >
                  <span className="clip-label">MIDI · {midiLabel || "旋律"}</span>
                  <MidiClipCanvas notes={notes} pxPerSec={pxPerSec} width={x(notesEnd) + 4} />
                </div>
              </div>
            </div>
          )}

          {hasContent && (
            <>
              {showLoop && (
                <div className="arr-loop" style={{ left: HEADER_W + x(loopA), width: x(loopB) - x(loopA) }} />
              )}
              <div className="arr-playhead" style={{ left: HEADER_W + x(currentTime) }} />
            </>
          )}
        </div>
        {!hasContent && <div className="arr-empty">{emptyState}</div>}
      </div>
    </div>
  );
};
