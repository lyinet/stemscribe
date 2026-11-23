import { t } from "../i18n";
import { NOTE_NAMES_SHARP } from "./musicTheory";

export interface PitchReading {
  frequencyHz: number;
  midiFloat: number;
  midiNote: number;
  noteName: string;
  centsOff: number; // -50 .. +50
  rms: number;
  clarity: number;
}

/**
 * Autocorrelation-based fundamental frequency (F0) detector tuned for guitar, piano & vocals (75Hz - 1200Hz).
 */
export function detectPitchFromFrame(
  buf: Float32Array,
  sampleRate: number
): PitchReading | null {
  const n = buf.length;
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += buf[i] * buf[i];
  const rms = Math.sqrt(sumSq / n);
  if (rms < 0.012) return null; // silence gate

  const minLag = Math.max(8, Math.floor(sampleRate / 1200));
  const maxLag = Math.min(Math.floor(n / 2), Math.floor(sampleRate / 75));

  let bestLag = -1;
  let bestCorr = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    let normA = 0;
    let normB = 0;
    const len = n - lag;
    for (let i = 0; i < len; i += 2) {
      const a = buf[i];
      const b = buf[i + lag];
      corr += a * b;
      normA += a * a;
      normB += b * b;
    }
    const denom = Math.sqrt(normA * normB);
    if (denom > 1e-6) {
      const normalized = corr / denom;
      if (normalized > bestCorr) {
        bestCorr = normalized;
        bestLag = lag;
      }
    }
  }

  if (bestLag < 0 || bestCorr < 0.62) return null;

  const frequencyHz = sampleRate / bestLag;
  const midiFloat = 69 + 12 * Math.log2(frequencyHz / 440);
  const midiNote = Math.round(midiFloat);
  const centsOff = Math.round((midiFloat - midiNote) * 100);
  const pc = ((midiNote % 12) + 12) % 12;
  const octave = Math.floor(midiNote / 12) - 1;

  return {
    frequencyHz,
    midiFloat,
    midiNote,
    noteName: `${NOTE_NAMES_SHARP[pc]}${octave}`,
    centsOff: Math.max(-50, Math.min(50, centsOff)),
    rms,
    clarity: bestCorr,
  };
}

export class LiveMicPitchTracker {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId: number | null = null;
  private buffer = new Float32Array(2048);

  public async start(onReading: (reading: PitchReading | null) => void): Promise<void> {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(t("mic.audioCaptureUnsupported"));
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);

    this.stream = stream;
    this.ctx = ctx;
    this.analyser = analyser;

    const loop = () => {
      if (!this.analyser || !this.ctx) return;
      this.analyser.getFloatTimeDomainData(this.buffer);
      onReading(detectPitchFromFrame(this.buffer, this.ctx.sampleRate));
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  public stop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.analyser = null;
  }
}
