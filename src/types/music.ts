export interface AudioMetadata {
  file_path: string;
  file_name: string;
  sample_rate: number;
  channels: number;
  duration_sec: number;
  waveform_peaks: number[];
}

export interface TempoAndLoudness {
  bpm: number;
  confidence: number;
  peak_dbfs: number;
  rms_dbfs: number;
}

export interface ChordEvent {
  start_sec: number;
  end_sec: number;
  symbol: string;
  confidence: number;
}

export type ReharmonizeStyle =
  | "jazz_neosoul"
  | "folk_open"
  | "cinematic_minor"
  | "pop_beginner";

export interface ReharmonizeResult {
  style: string;
  style_label_zh: string;
  description: string;
  chords: ChordEvent[];
}

export interface KeyEstimate {
  tonic: string;
  mode: "major" | "minor";
  label: string;
  confidence: number;
  scale_pitch_classes: number[];
}

export interface SongStructureSegment {
  id: string;
  label: string;
  kind: "intro" | "verse" | "chorus" | "bridge" | "outro" | string;
  start_sec: number;
  end_sec: number;
  energy: number;
}

export interface SectionMarker {
  id: string;
  time_sec: number;
  label: string;
}

export interface DrumHit {
  time_sec: number;
  kind: "kick" | "snare" | "hihat";
  midi_note: number;
  velocity: number;
}

export interface StemMixInput {
  file_path: string;
  gain: number;
  pan: number;
  enabled: boolean;
}

export interface BatchJobOptions {
  file_paths: string[];
  output_root: string;
  export_midi_for_vocals: boolean;
  export_chords_json: boolean;
}

export interface BatchProgressEvent {
  index: number;
  total: number;
  file_name: string;
  stage: string;
  status: string;
  message: string;
}

export interface BatchJobSummary {
  total: number;
  succeeded: number;
  failed: number;
  output_root: string;
}

export interface LyricLine {
  start_sec: number;
  end_sec: number;
  text: string;
}

export interface ModelStatus {
  models_dir: string;
  demucs_installed: boolean;
  demucs_ft_vocals_installed: boolean;
  basic_pitch_installed: boolean;
  critic_installed: boolean;
  coreml_enabled: boolean;
}

export interface ModelItemInfo {
  id: string;
  display_name: string;
  file_name: string;
  default_url: string;
  recommended_source_hint: string;
  direct_download_ready: boolean;
  installed: boolean;
  size_bytes: number;
}

export interface SystemDiagnostics {
  app_version: string;
  os: string;
  arch: string;
  coreml_enabled: boolean;
  basic_pitch_installed: boolean;
  htdemucs_installed: boolean;
  models_dir: string;
  midi_input_count: number;
  saved_projects_count: number;
  practice_records_count: number;
  recorded_takes_count: number;
}

export interface DownloadProgressEvent {
  model_id: string;
  downloaded_bytes: number;
  total_bytes: number;
  percent: number;
  status: string;
}

export interface StemOutput {
  name: string;
  label_zh: string;
  file_path: string;
  waveform_peaks: number[];
  duration_sec: number;
  /** Engine role: lead/backing/drums/perc/bass/other (absent = derive). */
  role?: string | null;
}

export interface StemMixerState {
  muted: boolean;
  solo: boolean;
  gain: number;
  pan: number;
}

export interface MidiNote {
  pitch: number;
  start_sec: number;
  end_sec: number;
  velocity: number;
  confidence: number;
}

export interface TranscriptionResult {
  stem_name: string;
  estimated_bpm: number;
  notes: MidiNote[];
}

export type RelayProtocol =
  | "openai_input_audio"
  | "openai_audio_url"
  | "gemini_compatible"
  | "text_only_midi";

export interface LlmRelayConfig {
  base_url: string;
  api_key: string;
  model: string;
  protocol: RelayProtocol;
}

export interface SongSection {
  label: string;
  time_range: string;
  chords: string;
  arrangement_note: string;
}

export interface ArrangementAnalysis {
  key_signature: string;
  genre_and_mood: string;
  instruments: string[];
  sections: SongSection[];
  practice_tips: string[];
  raw_markdown: string;
}

export interface RefinedScoreResponse {
  summary: string;
  guitar_fingering_tips: string[];
  cleaned_notes: MidiNote[];
}

export interface StemScribeProject {
  id: string;
  name: string;
  updated_at: string;
  audio_meta: AudioMetadata;
  stems: StemOutput[];
  chords: ChordEvent[];
  lyrics: LyricLine[];
  markers: SectionMarker[];
  active_stem_name: string;
  bpm: number;
  transpose_semitones: number;
  loop_a: number;
  loop_b: number;
  notes: MidiNote[];
  analysis: ArrangementAnalysis | null;
  restoration?: ProjectRestoration | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updated_at: string;
  file_path: string;
  note_count: number;
}

export interface PracticeRecord {
  id: string;
  song_name: string;
  timestamp: string;
  accuracy_pct: number;
  max_combo: number;
  playback_rate: number;
  rank: string;
  duration_sec: number;
}

export interface SetlistItem {
  project_id: string;
  song_name: string;
  bpm: number;
  key_label: string;
  capo_fret: number;
}

export interface Setlist {
  id: string;
  name: string;
  updated_at: string;
  items: SetlistItem[];
}

export interface LeadSheetInput {
  title: string;
  key_label: string;
  bpm: number;
  capo_fret: number;
  chords: ChordEvent[];
  lyrics: LyricLine[];
  structure: SongStructureSegment[];
}

export interface SavedTakeInfo {
  file_name: string;
  file_path: string;
  size_bytes: number;
}

export interface MidiInputPortInfo {
  index: number;
  name: string;
}

export interface HardwareMidiEvent {
  kind: "noteon" | "noteoff" | string;
  pitch: number;
  velocity: number;
  device_name: string;
}

export interface BandLevel {
  hz: number;
  db: number;
}

export interface QualityIssue {
  id: string;
  severity: "ok" | "warn" | "bad";
  title: string;
  detail: string;
}

export interface HarshPeak {
  hz: number;
  excess_db: number;
}

export interface CriticWindowScore {
  start_sec: number;
  pq: number;
}

export interface CriticScore {
  ce: number;
  cu: number;
  pc: number;
  pq: number;
  duration_sec: number;
  windows: CriticWindowScore[];
}

export interface QualityReport {
  sample_rate: number;
  channels: number;
  bit_depth: number | null;
  duration_sec: number;
  integrated_lufs: number;
  lra_lu: number;
  true_peak_dbtp: number;
  sample_peak_dbfs: number;
  cutoff_hz: number | null;
  low_mid_excess_db: number;
  low_mid_center_hz: number;
  harsh_peaks: HarshPeak[];
  stereo_correlation: number;
  side_mid_ratio_db: number;
  low_band_correlation: number;
  clipped_runs: number;
  dc_offset: [number, number];
  ltas: BandLevel[];
  issues: QualityIssue[];
}

// ---- H2: audio restoration ----

export interface RestoreStemIn {
  name: string;
  file_path: string;
  /** lead/backing/drums/perc/bass/other; empty = derive from name. */
  role?: string;
}

export interface RestoreModules {
  /** Per-module processing amounts 0–1.5 (0 = bypass; 1 = full). */
  vocal_cleanup: number;
  shimmer: number;
  drum_punch: number;
  low_end: number;
  width: number;
  vocal_space: number;
  hf_restore: number;
  glue: number;
  loudness: boolean;
  reference_match: boolean;
  drum_replace: boolean;
}

export interface RestoreSettings {
  /** 0.5 light / 1.0 standard / 1.5 strong */
  strength: number;
  modules: RestoreModules;
  target_lufs: number;
  ceiling_dbtp: number;
  /** 24 or 16 */
  bit_depth: number;
  /** Optional reference track for spectral matching */
  reference_path?: string | null;
  /** 0..1 blend of the reference correction (scaled by strength) */
  match_amount: number;
  /** Take loudness target from the reference instead of target_lufs */
  follow_reference_loudness: boolean;
  /** 0.3 / 0.5 / 0.8 — reinforced-drum mix */
  drum_replace_amount: number;
  /** −3..+3 dB gain on lead-vocal stems */
  vocal_level_db: number;
  /** −3..+3 dB peaking 3.5 kHz on lead vocals */
  vocal_presence_db: number;
  /** −3..+3 dB high-shelf 10 kHz on lead vocals */
  vocal_air_db: number;
  /** −3..+3 dB master low-shelf 100 Hz */
  low_shelf_db: number;
  /** −3..+3 dB master high-shelf 10 kHz */
  high_shelf_db: number;
}

export interface AdvisorChange {
  field: string;
  label_zh: string;
  from: number | boolean;
  to: number | boolean;
}

export interface AdvisorLastResult {
  report: QualityReport;
  score: number;
  terms?: unknown;
}

export interface AdvisorInput {
  report: QualityReport;
  stems: string[];
  current: RestoreSettings;
  last_result?: AdvisorLastResult | null;
  user_request: string;
}

export interface AdvisorResult {
  settings: RestoreSettings;
  changes: AdvisorChange[];
  explanation: string[];
  confidence: "low" | "medium" | "high" | string;
  warnings: string[];
  raw: string;
}

export interface RestoreRequest {
  source_path: string;
  stems: RestoreStemIn[];
  settings: RestoreSettings;
  output_path?: string | null;
}

export interface ReferenceInfo {
  path: string;
  report: QualityReport;
  distance_before_db: number;
  distance_after_db: number;
}

export interface RestoreResult {
  output_path: string;
  sample_rate: number;
  bit_depth: number;
  before: QualityReport;
  after: QualityReport;
  loudness_match_db: number;
  limiter_avg_gr_db: number;
  notes: string[];
  elapsed_ms: number;
  reference?: ReferenceInfo | null;
  objective?: ObjectiveScore | null;
  critic?: CriticScore | null;
  critic_before?: CriticScore | null;
}

export interface ObjectiveTerm {
  name: string;
  value: number;
}

/** Rule-based restoration score (lower = better) with term breakdown. */
export interface ObjectiveScore {
  score: number;
  terms: ObjectiveTerm[];
}

export interface CompareCandidate {
  strength: number;
  strength_label: string;
  output_path: string;
  after: QualityReport;
  objective: ObjectiveScore;
  critic?: CriticScore | null;
  notes: string[];
  warning?: string | null;
}

export interface CompareResult {
  before: QualityReport;
  candidates: CompareCandidate[];
  /** index into candidates */
  recommended: number;
  reason: string;
  critic_before?: CriticScore | null;
  elapsed_ms: number;
}

export interface ImportStemSpec {
  file_path: string;
  role?: string;
}

export interface ImportedStems {
  mix_path: string;
  mix_is_synth: boolean;
  stems: StemOutput[];
  notes: string[];
  duration_sec: number;
  sample_rate: number;
}

export type RestoreStage =
  | "analyze"
  | "stems"
  | "master"
  | "limit"
  | "write"
  | "report"
  | "compare_light"
  | "compare_standard"
  | "compare_strong";

export interface RestoreProgress {
  stage: RestoreStage;
  percent: number;
}

export const DEFAULT_RESTORE_SETTINGS: RestoreSettings = {
  strength: 1.0,
  modules: {
    vocal_cleanup: 1.0,
    shimmer: 1.0,
    drum_punch: 1.0,
    low_end: 1.0,
    width: 1.0,
    vocal_space: 1.0,
    hf_restore: 1.0,
    glue: 1.0,
    loudness: true,
    reference_match: true,
    drum_replace: false,
  },
  target_lufs: -14.0,
  ceiling_dbtp: -1.0,
  bit_depth: 24,
  reference_path: null,
  match_amount: 0.7,
  follow_reference_loudness: false,
  drum_replace_amount: 0.5,
  vocal_level_db: 0,
  vocal_presence_db: 0,
  vocal_air_db: 0,
  low_shelf_db: 0,
  high_shelf_db: 0,
};

/** Persisted restoration render, stored inside a saved project. */
export interface ProjectRestoration {
  output_path: string;
  settings: RestoreSettings;
  before: QualityReport;
  after: QualityReport;
  notes: string[];
}
