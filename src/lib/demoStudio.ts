import type {
  AudioMetadata,
  ChordEvent,
  DrumHit,
  KeyEstimate,
  LyricLine,
  MidiNote,
  SongStructureSegment,
  StemOutput,
  TempoAndLoudness,
} from "../types/music";

export interface DemoStudioBundle {
  audioMeta: AudioMetadata;
  tempoInfo: TempoAndLoudness;
  keyEst: KeyEstimate;
  structure: SongStructureSegment[];
  stems: StemOutput[];
  chords: ChordEvent[];
  drumHits: DrumHit[];
  lyrics: LyricLine[];
  notes: MidiNote[];
  blobUrls: string[];
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function encodeMonoToStereoWavBlob(samples: Float32Array, sampleRate: number): string {
  const numFrames = samples.length;
  const dataSize = numFrames * 4; // 2ch * 16-bit
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let pos = 44;
  for (let i = 0; i < numFrames; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const v = Math.round(s * 32767);
    view.setInt16(pos, v, true);
    view.setInt16(pos + 2, v, true);
    pos += 4;
  }

  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

function extractPeaks(samples: Float32Array, bins: number): number[] {
  const step = Math.max(1, Math.floor(samples.length / bins));
  const peaks: number[] = [];
  for (let i = 0; i < bins; i++) {
    let max = 0;
    const start = i * step;
    const end = Math.min(samples.length, start + step);
    for (let j = start; j < end; j += 8) {
      const a = Math.abs(samples[j]);
      if (a > max) max = a;
    }
    peaks.push(Math.min(1, max));
  }
  return peaks;
}

/**
 * Synthesize a real playable 24-second 4-stem demo track ("星海漫游 · Demo") in C Major @ 120 BPM
 * so first-time users can immediately experience every StemScribe feature with zero setup.
 */
export function createDemoStudioBundle(): DemoStudioBundle {
  const sr = 22050;
  const durationSec = 24;
  const totalSamples = sr * durationSec;

  // Chord progression: 6 bars of 4s each (C - Am - F - G7 - C - G7) -> 24s total
  const chords: ChordEvent[] = [
    { start_sec: 0, end_sec: 4, symbol: "C", confidence: 0.96 },
    { start_sec: 4, end_sec: 8, symbol: "Am", confidence: 0.94 },
    { start_sec: 8, end_sec: 12, symbol: "Fmaj7", confidence: 0.92 },
    { start_sec: 12, end_sec: 16, symbol: "G7", confidence: 0.95 },
    { start_sec: 16, end_sec: 20, symbol: "C", confidence: 0.97 },
    { start_sec: 20, end_sec: 24, symbol: "Am7", confidence: 0.93 },
  ];

  const chordVoicings: Record<string, number[]> = {
    C: [48, 52, 55, 60],
    Am: [45, 52, 57, 60],
    Fmaj7: [41, 48, 52, 57],
    G7: [43, 47, 50, 53],
    Am7: [45, 52, 55, 60],
  };

  const melodyPattern: Array<[number, number, number]> = [
    // [start_sec, duration, midiPitch]
    [0.5, 0.85, 64], [1.5, 0.45, 67], [2.0, 0.9, 72], [3.0, 0.8, 71],
    [4.0, 0.9, 69], [5.0, 0.45, 67], [5.5, 0.45, 64], [6.0, 1.4, 60],
    [8.0, 0.85, 65], [9.0, 0.45, 69], [9.5, 0.45, 72], [10.0, 1.3, 71],
    [12.0, 0.9, 67], [13.0, 0.45, 69], [13.5, 0.45, 71], [14.0, 1.5, 74],
    [16.0, 0.9, 76], [17.0, 0.45, 74], [17.5, 0.45, 72], [18.0, 1.4, 72],
    [20.0, 0.9, 69], [21.0, 0.9, 67], [22.0, 1.6, 64],
  ];

  const notes: MidiNote[] = melodyPattern.map(([start_sec, dur, pitch]) => ({
    pitch,
    start_sec,
    end_sec: start_sec + dur,
    velocity: 98,
    confidence: 0.95,
  }));

  const vocals = new Float32Array(totalSamples);
  const drums = new Float32Array(totalSamples);
  const bass = new Float32Array(totalSamples);
  const other = new Float32Array(totalSamples);

  // 1. Synthesize Vocals / Lead Melody
  for (const n of notes) {
    const startIdx = Math.floor(n.start_sec * sr);
    const endIdx = Math.min(totalSamples, Math.floor(n.end_sec * sr));
    const freq = midiToHz(n.pitch);
    const len = endIdx - startIdx;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.03) * Math.min(1, (len - i) / (sr * 0.06));
      const vib = 1 + 0.005 * Math.sin(2 * Math.PI * 5.2 * t);
      const val =
        (Math.sin(2 * Math.PI * freq * vib * t) * 0.65 +
          Math.sin(4 * Math.PI * freq * vib * t) * 0.25 +
          Math.sin(6 * Math.PI * freq * vib * t) * 0.1) *
        env *
        0.48;
      vocals[startIdx + i] += val;
    }
  }

  // 2. Synthesize Drums (120 BPM = 0.5s per beat) & record DrumHits
  const drumHits: DrumHit[] = [];
  const stepSec = 0.25; // 8th note
  const totalSteps = Math.floor(durationSec / stepSec);
  for (let step = 0; step < totalSteps; step++) {
    const t0 = step * stepSec;
    const idx0 = Math.floor(t0 * sr);
    const isChorus = t0 >= 8 && t0 < 20;
    const gainScale = isChorus ? 1.0 : 0.72;

    // Hi-hat on every 8th
    drumHits.push({ time_sec: t0, kind: "hihat", midi_note: 42, velocity: isChorus ? 86 : 68 });
    const hhLen = Math.min(totalSamples - idx0, Math.floor(sr * 0.045));
    for (let i = 0; i < hhLen; i++) {
      const decay = Math.exp(-i / (sr * 0.012));
      const noise = Math.sin(i * 12.9898 + step * 78.233) * 43758.5453;
      const white = (noise - Math.floor(noise)) * 2 - 1;
      drums[idx0 + i] += white * decay * 0.16 * gainScale;
    }

    // Kick on beats 1 & 3 (step % 4 === 0)
    if (step % 4 === 0) {
      drumHits.push({ time_sec: t0, kind: "kick", midi_note: 36, velocity: isChorus ? 116 : 98 });
      const kLen = Math.min(totalSamples - idx0, Math.floor(sr * 0.16));
      for (let i = 0; i < kLen; i++) {
        const t = i / sr;
        const f = 140 * Math.exp(-t * 24) + 46;
        const env = Math.exp(-t * 14);
        drums[idx0 + i] += Math.sin(2 * Math.PI * f * t) * env * 0.62 * gainScale;
      }
    }

    // Snare on beats 2 & 4 (step % 4 === 2)
    if (step % 4 === 2) {
      drumHits.push({ time_sec: t0, kind: "snare", midi_note: 38, velocity: isChorus ? 108 : 88 });
      const sLen = Math.min(totalSamples - idx0, Math.floor(sr * 0.13));
      for (let i = 0; i < sLen; i++) {
        const t = i / sr;
        const env = Math.exp(-t * 20);
        const n = Math.sin(i * 91.7 + step * 17.3) * 19384.5;
        const white = (n - Math.floor(n)) * 2 - 1;
        drums[idx0 + i] += (white * 0.55 + Math.sin(2 * Math.PI * 195 * t) * 0.45) * env * 0.42 * gainScale;
      }
    }
  }

  // 3. Synthesize Bass & Electric Piano Chords ("other")
  for (const ch of chords) {
    const voicing = chordVoicings[ch.symbol] ?? [48, 52, 55, 60];
    const rootMidi = voicing[0] - 12; // bass octave
    const startIdx = Math.floor(ch.start_sec * sr);
    const endIdx = Math.min(totalSamples, Math.floor(ch.end_sec * sr));
    const barSamples = endIdx - startIdx;

    // Bass plays root + fifth rhythm
    for (let beat = 0; beat < 8; beat++) {
      const bStart = startIdx + Math.floor(beat * 0.5 * sr);
      const bLen = Math.min(totalSamples - bStart, Math.floor(0.45 * sr));
      const pitch = beat % 4 === 2 ? rootMidi + 7 : rootMidi;
      const freq = midiToHz(pitch);
      for (let i = 0; i < bLen; i++) {
        const t = i / sr;
        const env = Math.min(1, t / 0.015) * Math.exp(-t * 3.2);
        bass[bStart + i] += (Math.sin(2 * Math.PI * freq * t) * 0.8 + Math.sin(4 * Math.PI * freq * t) * 0.2) * env * 0.46;
      }
    }

    // Piano pads
    for (let i = 0; i < barSamples; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.05) * Math.exp(-t * 0.65);
      let sum = 0;
      for (const m of voicing) {
        sum += Math.sin(2 * Math.PI * midiToHz(m) * t);
      }
      other[startIdx + i] += (sum / voicing.length) * env * 0.36;
    }
  }

  const mix = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    mix[i] = Math.max(-1, Math.min(1, (vocals[i] + drums[i] + bass[i] + other[i]) * 0.65));
  }

  const vocalsUrl = encodeMonoToStereoWavBlob(vocals, sr);
  const drumsUrl = encodeMonoToStereoWavBlob(drums, sr);
  const bassUrl = encodeMonoToStereoWavBlob(bass, sr);
  const otherUrl = encodeMonoToStereoWavBlob(other, sr);

  const stems: StemOutput[] = [
    { name: "vocals", label_zh: "人声", file_path: vocalsUrl, duration_sec: durationSec, waveform_peaks: extractPeaks(vocals, 220) },
    { name: "drums", label_zh: "鼓组", file_path: drumsUrl, duration_sec: durationSec, waveform_peaks: extractPeaks(drums, 220) },
    { name: "bass", label_zh: "贝斯", file_path: bassUrl, duration_sec: durationSec, waveform_peaks: extractPeaks(bass, 220) },
    { name: "other", label_zh: "伴奏/其他", file_path: otherUrl, duration_sec: durationSec, waveform_peaks: extractPeaks(other, 220) },
  ];

  const structure: SongStructureSegment[] = [
    { id: "demo_sec_0", label: "前奏 Intro", kind: "intro", start_sec: 0, end_sec: 4, energy: 0.42 },
    { id: "demo_sec_1", label: "主歌 Verse", kind: "verse", start_sec: 4, end_sec: 8, energy: 0.64 },
    { id: "demo_sec_2", label: "副歌 Chorus", kind: "chorus", start_sec: 8, end_sec: 16, energy: 0.94 },
    { id: "demo_sec_3", label: "副歌 Chorus 2", kind: "chorus", start_sec: 16, end_sec: 20, energy: 0.9 },
    { id: "demo_sec_4", label: "尾奏 Outro", kind: "outro", start_sec: 20, end_sec: 24, energy: 0.48 },
  ];

  const lyrics: LyricLine[] = [
    { start_sec: 0.4, end_sec: 3.9, text: "星光漫过录音室的玻璃窗" },
    { start_sec: 4.0, end_sec: 7.9, text: "四条音轨在指尖轻轻点亮" },
    { start_sec: 8.0, end_sec: 11.9, text: "和弦与鼓点共振成清晰乐章" },
    { start_sec: 12.0, end_sec: 15.9, text: "慢放循环也能听见每寸呼吸声响" },
    { start_sec: 16.0, end_sec: 19.9, text: "切换变调夹让吉他自由飞翔" },
    { start_sec: 20.0, end_sec: 23.8, text: "在 StemScribe 舞台弹奏你的主场" },
  ];

  return {
    audioMeta: {
      file_path: vocalsUrl,
      file_name: "星海漫游_Demo_120BPM.wav",
      sample_rate: sr,
      channels: 2,
      duration_sec: durationSec,
      waveform_peaks: extractPeaks(mix, 360),
    },
    tempoInfo: {
      bpm: 120,
      confidence: 0.98,
      peak_dbfs: -1.1,
      rms_dbfs: -10.8,
    },
    keyEst: {
      tonic: "C",
      mode: "major",
      label: "C 大调 (Major)",
      confidence: 0.97,
      scale_pitch_classes: [0, 2, 4, 5, 7, 9, 11],
    },
    structure,
    stems,
    chords,
    drumHits,
    lyrics,
    notes,
    blobUrls: [vocalsUrl, drumsUrl, bassUrl, otherUrl],
  };
}
