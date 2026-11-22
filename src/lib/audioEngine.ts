import type { MidiNote, StemMixerState, StemOutput } from "../types/music";
import { resolveAudioUrl } from "./tauriApi";

interface StemChannel {
  el: HTMLAudioElement;
  gainNode?: GainNode;
  panNode?: StereoPannerNode;
}

export interface MasterEqState {
  lowDb: number;
  midDb: number;
  highDb: number;
}

export type SynthTimbre = "triangle" | "sine" | "sawtooth" | "square";
export type ReverbPreset = "off" | "studio" | "hall";

function createImpulseResponse(ctx: AudioContext, durationSec: number, decay: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * durationSec);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, decay);
      data[i] = (Math.random() * 2 - 1) * env * 0.6;
    }
  }
  return buf;
}

export class MultiStemAudioEngine {
  private channels: Map<string, StemChannel> = new Map();
  private rafId: number | null = null;
  private playbackRate = 1.0;
  private transposeSemitones = 0;
  private loopEnabled = false;
  private loopA = 0;
  private loopB = 8;
  private progressiveRampEnabled = false;
  private onRateAutoRamp?: (nextRate: number) => void;

  private metronomeEnabled = false;
  private bpm = 120;
  private lastBeatIndex = -1;

  private midiAuditionEnabled = false;
  private synthTimbre: SynthTimbre = "triangle";
  private midiNotes: MidiNote[] = [];
  private lastTickTime = -1;

  private audioCtx: AudioContext | null = null;
  private lowEq: BiquadFilterNode | null = null;
  private midEq: BiquadFilterNode | null = null;
  private highEq: BiquadFilterNode | null = null;
  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private analyser: AnalyserNode | null = null;
  private timeBuf = new Float32Array(256);
  private onTimeUpdate?: (sec: number) => void;

  private ensureAudioGraph(): AudioContext | null {
    try {
      if (!this.audioCtx) {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        this.audioCtx = ctx;

        this.lowEq = ctx.createBiquadFilter();
        this.lowEq.type = "lowshelf";
        this.lowEq.frequency.value = 250;

        this.midEq = ctx.createBiquadFilter();
        this.midEq.type = "peaking";
        this.midEq.frequency.value = 1500;
        this.midEq.Q.value = 1.0;

        this.highEq = ctx.createBiquadFilter();
        this.highEq.type = "highshelf";
        this.highEq.frequency.value = 5000;

        this.dryGain = ctx.createGain();
        this.dryGain.gain.value = 1.0;

        this.wetGain = ctx.createGain();
        this.wetGain.gain.value = 0.0;

        this.convolver = ctx.createConvolver();
        this.convolver.buffer = createImpulseResponse(ctx, 1.4, 2.6);

        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 128;
        this.analyser.smoothingTimeConstant = 0.78;

        this.lowEq.connect(this.midEq);
        this.midEq.connect(this.highEq);

        // Parallel dry + studio reverb send
        this.highEq.connect(this.dryGain);
        this.highEq.connect(this.convolver);
        this.convolver.connect(this.wetGain);

        this.dryGain.connect(this.analyser);
        this.wetGain.connect(this.analyser);
        this.analyser.connect(ctx.destination);
      }
      return this.audioCtx;
    } catch {
      return null;
    }
  }

  public setReverb(preset: ReverbPreset, wetAmount: number) {
    const ctx = this.ensureAudioGraph();
    if (!ctx || !this.wetGain || !this.dryGain || !this.convolver) return;
    if (preset === "off") {
      this.wetGain.gain.value = 0;
      this.dryGain.gain.value = 1.0;
      return;
    }
    const clampedWet = Math.max(0, Math.min(0.65, wetAmount));
    if (preset === "studio") {
      this.convolver.buffer = createImpulseResponse(ctx, 1.1, 3.0);
    } else {
      this.convolver.buffer = createImpulseResponse(ctx, 2.4, 2.0);
    }
    this.wetGain.gain.value = clampedWet;
    this.dryGain.gain.value = 1.0 - clampedWet * 0.35;
  }

  public getMasterPeakLevel(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.timeBuf);
    let peak = 0;
    for (let i = 0; i < this.timeBuf.length; i++) {
      const a = Math.abs(this.timeBuf[i]);
      if (a > peak) peak = a;
    }
    return Math.min(1, peak);
  }

  public setMidiAudition(enabled: boolean, notes: MidiNote[], timbre?: SynthTimbre) {
    this.midiAuditionEnabled = enabled;
    this.midiNotes = notes;
    if (timbre) this.synthTimbre = timbre;
  }

  public setProgressiveRamp(enabled: boolean, onRamp: (nextRate: number) => void) {
    this.progressiveRampEnabled = enabled;
    this.onRateAutoRamp = onRamp;
  }

  public playSingleNote(midiPitch: number, durationSec = 0.45, velocity = 100) {
    const ctx = this.ensureAudioGraph();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    this.triggerSynthNote(midiPitch, durationSec, velocity);
  }

  private triggerSynthNote(midiPitch: number, durationSec: number, velocity: number) {
    const ctx = this.ensureAudioGraph();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const dur = Math.max(0.08, Math.min(2.5, durationSec / Math.max(0.5, this.playbackRate)));
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = this.synthTimbre;
      osc.frequency.value = 440 * Math.pow(2, (midiPitch - 69) / 12);

      const scale = this.synthTimbre === "sawtooth" || this.synthTimbre === "square" ? 0.09 : 0.16;
      const amp = Math.max(0.03, Math.min(0.18, (velocity / 127) * scale));
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(amp, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

      osc.connect(gain);
      gain.connect(this.dryGain ?? this.analyser ?? ctx.destination);
      if (this.convolver) gain.connect(this.convolver);
      osc.start(now);
      osc.stop(now + dur + 0.02);
    } catch {
      // Ignore Web Audio errors
    }
  }

  public setMasterEq(eq: MasterEqState) {
    this.ensureAudioGraph();
    if (this.lowEq) this.lowEq.gain.value = eq.lowDb;
    if (this.midEq) this.midEq.gain.value = eq.midDb;
    if (this.highEq) this.highEq.gain.value = eq.highDb;
  }

  public getFrequencyBins(out: Uint8Array): boolean {
    if (!this.analyser) return false;
    this.analyser.getByteFrequencyData(out);
    return true;
  }

  public loadStems(stems: StemOutput[], onTimeUpdate: (sec: number) => void) {
    this.dispose();
    this.onTimeUpdate = onTimeUpdate;
    const ctx = this.ensureAudioGraph();

    for (const stem of stems) {
      const el = new Audio(resolveAudioUrl(stem.file_path));
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      this.applyPlaybackSettings(el);

      let gainNode: GainNode | undefined;
      let panNode: StereoPannerNode | undefined;

      if (ctx && this.lowEq) {
        try {
          const src = ctx.createMediaElementSource(el);
          gainNode = ctx.createGain();
          panNode = ctx.createStereoPanner();
          src.connect(gainNode);
          gainNode.connect(panNode);
          panNode.connect(this.lowEq);
        } catch {
          // Fallback to direct HTMLAudioElement
        }
      }

      this.channels.set(stem.name, { el, gainNode, panNode });
    }
  }

  private applyPlaybackSettings(el: HTMLAudioElement) {
    const pitchRatio = Math.pow(2, this.transposeSemitones / 12);
    const audioWithPitch = el as HTMLAudioElement & { preservesPitch?: boolean };
    if (this.transposeSemitones === 0) {
      audioWithPitch.preservesPitch = true;
      el.playbackRate = this.playbackRate;
    } else {
      audioWithPitch.preservesPitch = false;
      el.playbackRate = Math.max(0.5, Math.min(2.0, this.playbackRate * pitchRatio));
    }
  }

  public applyMixer(mixer: Record<string, StemMixerState>) {
    const anySolo = Object.values(mixer).some((m) => m.solo);
    for (const [name, ch] of this.channels.entries()) {
      const st = mixer[name] ?? { muted: false, solo: false, gain: 1.0, pan: 0 };
      const audible = anySolo ? st.solo : !st.muted;
      const vol = audible ? Math.max(0, Math.min(1, st.gain)) : 0;

      if (ch.gainNode) {
        ch.gainNode.gain.value = vol;
      } else {
        ch.el.volume = vol;
      }
      if (ch.panNode) {
        ch.panNode.pan.value = Math.max(-1, Math.min(1, st.pan ?? 0));
      }
    }
  }

  public setPlaybackRate(rate: number) {
    this.playbackRate = rate;
    for (const ch of this.channels.values()) {
      this.applyPlaybackSettings(ch.el);
    }
  }

  public setTranspose(semitones: number) {
    this.transposeSemitones = semitones;
    for (const ch of this.channels.values()) {
      this.applyPlaybackSettings(ch.el);
    }
  }

  public setMetronome(enabled: boolean, bpm: number) {
    this.metronomeEnabled = enabled;
    this.bpm = Math.max(40, Math.min(240, bpm));
    this.lastBeatIndex = -1;
  }

  public setLoop(enabled: boolean, loopA: number, loopB: number) {
    this.loopEnabled = enabled;
    this.loopA = Math.min(loopA, loopB);
    this.loopB = Math.max(loopA, loopB);
  }

  public seek(sec: number) {
    this.lastBeatIndex = -1;
    this.lastTickTime = sec;
    for (const ch of this.channels.values()) {
      if (Number.isFinite(sec)) {
        ch.el.currentTime = Math.max(0, sec);
      }
    }
    this.onTimeUpdate?.(sec);
  }

  public async playWithCountIn(enableCountIn: boolean) {
    if (enableCountIn) {
      const beatMs = (60 / Math.max(40, this.bpm)) * 1000;
      for (let i = 0; i < 4; i++) {
        this.playClick(i === 0);
        await new Promise((r) => setTimeout(r, beatMs));
      }
    }
    await this.play();
  }

  public async play() {
    const ctx = this.ensureAudioGraph();
    if (ctx && ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }
    const first = this.channels.values().next().value as StemChannel | undefined;
    if (!first) return;
    const syncTime = first.el.currentTime;
    this.lastBeatIndex = -1;
    this.lastTickTime = syncTime;
    await Promise.all(
      Array.from(this.channels.values()).map((ch) => {
        ch.el.currentTime = syncTime;
        return ch.el.play().catch(() => {});
      })
    );
    this.startTicker();
  }

  public pause() {
    for (const ch of this.channels.values()) {
      ch.el.pause();
    }
    this.stopTicker();
  }

  public playClick(accent: boolean) {
    const ctx = this.ensureAudioGraph();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = accent ? 1180 : 820;
      gain.gain.setValueAtTime(accent ? 0.22 : 0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.045);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.05);
    } catch {
      // Ignore Web Audio errors
    }
  }

  private startTicker() {
    this.stopTicker();
    const tick = () => {
      const first = this.channels.values().next().value as StemChannel | undefined;
      if (first) {
        const t = first.el.currentTime;
        if (this.metronomeEnabled && this.bpm > 0) {
          const beatIdx = Math.floor(t / (60 / this.bpm));
          if (beatIdx !== this.lastBeatIndex) {
            this.lastBeatIndex = beatIdx;
            this.playClick(beatIdx % 4 === 0);
          }
        }
        if (
          this.midiAuditionEnabled &&
          this.midiNotes.length > 0 &&
          this.lastTickTime >= 0 &&
          t > this.lastTickTime
        ) {
          for (const n of this.midiNotes) {
            if (n.start_sec > this.lastTickTime && n.start_sec <= t) {
              this.triggerSynthNote(n.pitch, n.end_sec - n.start_sec, n.velocity);
            }
          }
        }
        this.lastTickTime = t;

        if (this.loopEnabled && this.loopB > this.loopA + 0.1 && t >= this.loopB) {
          if (this.progressiveRampEnabled && this.playbackRate < 1.0) {
            const nextRate = Math.min(1.0, Math.round((this.playbackRate + 0.05) * 100) / 100);
            this.setPlaybackRate(nextRate);
            this.onRateAutoRamp?.(nextRate);
          }
          this.seek(this.loopA);
        } else {
          this.onTimeUpdate?.(t);
        }
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopTicker() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  public dispose() {
    this.stopTicker();
    for (const ch of this.channels.values()) {
      ch.el.pause();
      ch.el.src = "";
    }
    this.channels.clear();
  }
}
