import type { ChordEvent } from "../types/music";

export const NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export interface GuitarTuningPreset {
  id: string;
  label: string;
  openMidi: number[]; // 1st string (high) -> 6th string (low)
  stringLabels: string[];
}

export const GUITAR_TUNINGS: GuitarTuningPreset[] = [
  {
    id: "standard",
    label: "标准 (EADGBE)",
    openMidi: [64, 59, 55, 50, 45, 40],
    stringLabels: ["1e", "2B", "3G", "4D", "5A", "6E"],
  },
  {
    id: "drop_d",
    label: "Drop D (DADGBE)",
    openMidi: [64, 59, 55, 50, 45, 38],
    stringLabels: ["1e", "2B", "3G", "4D", "5A", "6D"],
  },
  {
    id: "half_down",
    label: "降半音 (Eb)",
    openMidi: [63, 58, 54, 49, 44, 39],
    stringLabels: ["1eb", "2Bb", "3Gb", "4Db", "5Ab", "6Eb"],
  },
  {
    id: "dadgad",
    label: "DADGAD 指弹",
    openMidi: [62, 57, 55, 50, 45, 38],
    stringLabels: ["1D", "2A", "3G", "4D", "5A", "6D"],
  },
  {
    id: "open_g",
    label: "Open G (DGDGBD)",
    openMidi: [62, 59, 55, 50, 43, 38],
    stringLabels: ["1D", "2B", "3G", "4D", "5G", "6D"],
  },
];

const OPEN_FRIENDLY_CHORDS = new Set([
  "C", "Cmaj7", "D", "Dm", "Dm7", "D7", "E", "Em", "Em7", "E7",
  "Fmaj7", "G", "G7", "A", "Am", "Am7", "A7",
]);

export function parseChordSymbol(symbol: string): { rootPc: number; suffix: string } | null {
  const m = symbol.trim().match(/^([A-G])([#b]?)(.*)$/);
  if (!m) return null;
  const baseMap: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let pc = baseMap[m[1]];
  if (pc === undefined) return null;
  if (m[2] === "#") pc = (pc + 1) % 12;
  if (m[2] === "b") pc = (pc + 11) % 12;
  return { rootPc: pc, suffix: m[3] || "" };
}

export function transposeChordSymbol(symbol: string, semitones: number): string {
  const parsed = parseChordSymbol(symbol);
  if (!parsed) return symbol;
  const nextPc = (parsed.rootPc + semitones + 120) % 12;
  return `${NOTE_NAMES_SHARP[nextPc]}${parsed.suffix}`;
}

export function chordToPitchClasses(symbol: string): number[] {
  const parsed = parseChordSymbol(symbol);
  if (!parsed) return [];
  const { rootPc, suffix } = parsed;
  const s = suffix.toLowerCase();
  let intervals = [0, 4, 7];
  if (s.startsWith("m9")) intervals = [0, 3, 7, 10, 14];
  else if (s.startsWith("m7")) intervals = [0, 3, 7, 10];
  else if (s.startsWith("maj7")) intervals = [0, 4, 7, 11];
  else if (s.startsWith("add9")) intervals = [0, 4, 7, 14];
  else if (s.startsWith("m") && !s.startsWith("maj")) intervals = [0, 3, 7];
  else if (s.startsWith("7sus4")) intervals = [0, 5, 7, 10];
  else if (s.startsWith("7") || s.startsWith("13")) intervals = [0, 4, 7, 10];
  else if (s.startsWith("sus2")) intervals = [0, 2, 7];
  else if (s.startsWith("sus4")) intervals = [0, 5, 7];
  else if (s.startsWith("dim")) intervals = [0, 3, 6];
  return intervals.map((i) => (rootPc + i) % 12);
}

/**
 * Build a pleasant MIDI voicing (root in bass + upper chord tones) for Web Audio strum audition.
 */
export function chordToMidiVoicing(symbol: string, baseOctave = 4): number[] {
  const parsed = parseChordSymbol(symbol);
  if (!parsed) return [];
  const { rootPc, suffix } = parsed;
  const s = suffix.toLowerCase();
  let intervals = [0, 4, 7, 12];
  if (s.startsWith("m9")) intervals = [0, 3, 7, 10, 14];
  else if (s.startsWith("m7")) intervals = [0, 3, 7, 10];
  else if (s.startsWith("maj7")) intervals = [0, 4, 7, 11];
  else if (s.startsWith("add9")) intervals = [0, 4, 7, 14];
  else if (s.startsWith("m") && !s.startsWith("maj")) intervals = [0, 3, 7, 12];
  else if (s.startsWith("7sus4")) intervals = [0, 5, 7, 10];
  else if (s.startsWith("7") || s.startsWith("13")) intervals = [0, 4, 7, 10];
  else if (s.startsWith("sus2")) intervals = [0, 2, 7, 12];
  else if (s.startsWith("sus4")) intervals = [0, 5, 7, 12];
  else if (s.startsWith("dim")) intervals = [0, 3, 6, 9];
  const rootMidi = (baseOctave + 1) * 12 + rootPc - 12; // e.g. C3..B3 bass
  return intervals.map((i) => rootMidi + i);
}

const MAJOR_DEGREES = ["I", "bII", "II", "bIII", "III", "IV", "#IV", "V", "bVI", "VI", "bVII", "VII"];
const MINOR_DEGREES = ["I", "bII", "II", "bIII", "III", "IV", "#IV", "V", "bVI", "VI", "bVII", "VII"];

/**
 * Compute Roman numeral / Nashville degree (e.g. "IVmaj7", "vi7", "V7") relative to the song's key.
 */
export function chordToRomanNumeral(
  symbol: string,
  keyTonic?: string,
  keyMode?: string
): string {
  if (!keyTonic) return "";
  const chord = parseChordSymbol(symbol);
  const tonic = parseChordSymbol(keyTonic);
  if (!chord || !tonic) return "";

  const offset = (chord.rootPc - tonic.rootPc + 12) % 12;
  const table = keyMode?.toLowerCase() === "minor" ? MINOR_DEGREES : MAJOR_DEGREES;
  const baseDeg = table[offset] ?? "";
  const s = chord.suffix;
  const low = s.toLowerCase();
  const isMinor = (low.startsWith("m") && !low.startsWith("maj")) || low.startsWith("dim");

  const roman = isMinor ? baseDeg.toLowerCase() : baseDeg;
  const ext = isMinor && low.startsWith("m") ? s.slice(1) : s;
  return `${roman}${ext}`;
}

export interface CapoRecommendation {
  fret: number;
  friendlyRatio: number;
  sampleShapes: string[];
  label: string;
}

/**
 * Evaluate Capo frets 0..7 and rank by percentage of beginner-friendly open guitar shapes.
 */
export function recommendCapoFrets(
  chords: ChordEvent[],
  transposeSemitones = 0
): CapoRecommendation[] {
  const uniqueSymbols = Array.from(
    new Set(chords.map((c) => transposeChordSymbol(c.symbol, transposeSemitones)))
  );
  if (uniqueSymbols.length === 0) {
    return [{ fret: 0, friendlyRatio: 1, sampleShapes: [], label: "原调不夹 (0品)" }];
  }

  const results: CapoRecommendation[] = [];
  for (let fret = 0; fret <= 7; fret++) {
    const shapes = uniqueSymbols.map((sym) => transposeChordSymbol(sym, -fret));
    const friendly = shapes.filter((sh) => OPEN_FRIENDLY_CHORDS.has(sh)).length;
    const ratio = friendly / shapes.length;
    results.push({
      fret,
      friendlyRatio: ratio,
      sampleShapes: shapes.slice(0, 4),
      label:
        fret === 0
          ? `原调 0 品 (${Math.round(ratio * 100)}% 开放指法)`
          : `夹 ${fret} 品 · ${shapes.slice(0, 3).join("/")} (${Math.round(ratio * 100)}%)`,
    });
  }

  return results.sort((a, b) => {
    if (Math.abs(b.friendlyRatio - a.friendlyRatio) > 0.05) {
      return b.friendlyRatio - a.friendlyRatio;
    }
    return a.fret - b.fret;
  });
}
