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
  basic_pitch_installed: boolean;
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
