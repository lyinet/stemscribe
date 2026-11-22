import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  ArrangementAnalysis,
  AudioMetadata,
  BatchJobOptions,
  BatchJobSummary,
  BatchProgressEvent,
  ChordEvent,
  DownloadProgressEvent,
  DrumHit,
  HardwareMidiEvent,
  KeyEstimate,
  LeadSheetInput,
  LlmRelayConfig,
  LyricLine,
  MidiInputPortInfo,
  MidiNote,
  ModelItemInfo,
  ModelStatus,
  PracticeRecord,
  ProjectSummary,
  RefinedScoreResponse,
  ReharmonizeResult,
  ReharmonizeStyle,
  SavedTakeInfo,
  Setlist,
  SongStructureSegment,
  StemMixInput,
  StemOutput,
  StemScribeProject,
  SystemDiagnostics,
  TempoAndLoudness,
  TranscriptionResult,
} from "../types/music";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function resolveAudioUrl(filePath: string): string {
  if (filePath.startsWith("blob:") || filePath.startsWith("data:") || filePath.startsWith("http")) {
    return filePath;
  }
  if (!isTauriRuntime()) return filePath;
  return convertFileSrc(filePath);
}

export async function onNativeFileDrop(
  handler: (paths: string[]) => void
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop" && event.payload.paths.length > 0) {
      handler(event.payload.paths);
    }
  });
}

export async function pickAudioFile(): Promise<string | null> {
  if (!isTauriRuntime()) return "demo_song.wav";
  const selected = await open({
    multiple: false,
    filters: [{ name: "Audio Files", extensions: ["wav", "mp3", "flac", "m4a", "ogg"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export async function pickAudioFilesMultiple(): Promise<string[]> {
  if (!isTauriRuntime()) return ["demo_song_1.wav", "demo_song_2.mp3"];
  const selected = await open({
    multiple: true,
    filters: [{ name: "Audio Files", extensions: ["wav", "mp3", "flac", "m4a", "ogg"] }],
  });
  if (Array.isArray(selected)) return selected;
  return typeof selected === "string" ? [selected] : [];
}

export async function pickDirectory(): Promise<string | null> {
  if (!isTauriRuntime()) return "~/Desktop/StemScribe_Export";
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export async function pickMidiOpenPath(): Promise<string | null> {
  if (!isTauriRuntime()) return "imported_melody.mid";
  const selected = await open({
    multiple: false,
    filters: [{ name: "MIDI File", extensions: ["mid", "midi"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export async function pickMidiSavePath(defaultName: string): Promise<string | null> {
  if (!isTauriRuntime()) return defaultName;
  return save({ defaultPath: defaultName, filters: [{ name: "MIDI File", extensions: ["mid"] }] });
}

export async function pickMusicXmlSavePath(defaultName: string): Promise<string | null> {
  if (!isTauriRuntime()) return defaultName;
  return save({
    defaultPath: defaultName,
    filters: [{ name: "MusicXML Score", extensions: ["musicxml", "xml"] }],
  });
}

export async function pickLrcOpenPath(): Promise<string | null> {
  if (!isTauriRuntime()) return "imported_lyrics.lrc";
  const selected = await open({
    multiple: false,
    filters: [{ name: "LRC Lyrics", extensions: ["lrc", "txt"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export async function pickLrcSavePath(defaultName: string): Promise<string | null> {
  if (!isTauriRuntime()) return defaultName;
  return save({ defaultPath: defaultName, filters: [{ name: "LRC Lyrics", extensions: ["lrc"] }] });
}

export async function pickSrtSavePath(defaultName: string): Promise<string | null> {
  if (!isTauriRuntime()) return defaultName;
  return save({ defaultPath: defaultName, filters: [{ name: "SRT Subtitles", extensions: ["srt"] }] });
}

export async function pickCsvSavePath(defaultName: string): Promise<string | null> {
  if (!isTauriRuntime()) return defaultName;
  return save({ defaultPath: defaultName, filters: [{ name: "CSV Spreadsheet", extensions: ["csv"] }] });
}

export async function pickOnnxOpenPath(): Promise<string | null> {
  if (!isTauriRuntime()) return "local_model.onnx";
  const selected = await open({
    multiple: false,
    filters: [{ name: "ONNX Model", extensions: ["onnx"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export async function pickWavSavePath(defaultName: string): Promise<string | null> {
  if (!isTauriRuntime()) return defaultName;
  return save({ defaultPath: defaultName, filters: [{ name: "WAV Audio", extensions: ["wav"] }] });
}

export async function pickHtmlSavePath(defaultName: string): Promise<string | null> {
  if (!isTauriRuntime()) return defaultName;
  return save({
    defaultPath: defaultName,
    filters: [{ name: "Printable HTML Lead Sheet", extensions: ["html"] }],
  });
}

export async function inspectAudioFile(filePath: string): Promise<AudioMetadata> {
  if (!isTauriRuntime()) {
    return {
      file_path: filePath,
      file_name: filePath,
      sample_rate: 44100,
      channels: 2,
      duration_sec: 16,
      waveform_peaks: Array.from({ length: 320 }, (_, i) =>
        Math.abs(Math.sin(i * 0.14) * 0.65 + Math.cos(i * 0.05) * 0.25)
      ),
    };
  }
  return invoke<AudioMetadata>("inspect_audio_file", { filePath });
}

export async function detectBpmLocal(filePath: string): Promise<TempoAndLoudness> {
  if (!isTauriRuntime()) {
    return { bpm: 120, confidence: 0.89, peak_dbfs: -0.8, rms_dbfs: -11.4 };
  }
  return invoke<TempoAndLoudness>("detect_bpm_local", { filePath });
}

export async function detectChordsLocal(
  filePath: string,
  windowSec = 2.0
): Promise<ChordEvent[]> {
  if (!isTauriRuntime()) {
    return [
      { start_sec: 0, end_sec: 4, symbol: "C", confidence: 0.91 },
      { start_sec: 4, end_sec: 8, symbol: "Am", confidence: 0.88 },
      { start_sec: 8, end_sec: 12, symbol: "F", confidence: 0.86 },
      { start_sec: 12, end_sec: 16, symbol: "G7", confidence: 0.9 },
    ];
  }
  return invoke<ChordEvent[]>("detect_chords_local", { filePath, windowSec });
}

export async function reharmonizeChordsLocal(
  chords: ChordEvent[],
  style: ReharmonizeStyle
): Promise<ReharmonizeResult> {
  if (!isTauriRuntime()) {
    const transformed = chords.map((c, idx) => {
      const m = c.symbol.match(/^([A-G][#b]?)(.*)$/);
      if (!m) return c;
      const root = m[1];
      const suf = m[2].toLowerCase();
      const isMin = suf.startsWith("m") && !suf.startsWith("maj");
      const isDom7 = suf.startsWith("7");
      let next = c.symbol;
      if (style === "jazz_neosoul") next = isMin ? `${root}m9` : isDom7 ? `${root}13` : `${root}maj7`;
      else if (style === "folk_open") next = isMin ? `${root}m7` : isDom7 ? `${root}7sus4` : idx % 2 === 0 ? `${root}add9` : `${root}maj7`;
      else if (style === "cinematic_minor") next = isMin ? `${root}m9` : `${root}sus2`;
      else next = isMin ? `${root}m` : root;
      return { ...c, symbol: next };
    });
    return {
      style,
      style_label_zh: style,
      description: "预览模式已应用和弦风格变奏",
      chords: transformed,
    };
  }
  return invoke<ReharmonizeResult>("reharmonize_chords_local", { chords, style });
}

export async function detectKeyLocal(filePath: string): Promise<KeyEstimate> {
  if (!isTauriRuntime()) {
    return {
      tonic: "C",
      mode: "major",
      label: "C 大调 (Major)",
      confidence: 0.92,
      scale_pitch_classes: [0, 2, 4, 5, 7, 9, 11],
    };
  }
  return invoke<KeyEstimate>("detect_key_local", { filePath });
}

export async function detectSongStructureLocal(
  filePath: string
): Promise<SongStructureSegment[]> {
  if (!isTauriRuntime()) {
    return [
      { id: "sec_0", label: "前奏 Intro", kind: "intro", start_sec: 0, end_sec: 4, energy: 0.35 },
      { id: "sec_1", label: "主歌 Verse", kind: "verse", start_sec: 4, end_sec: 8, energy: 0.62 },
      { id: "sec_2", label: "副歌 Chorus", kind: "chorus", start_sec: 8, end_sec: 12, energy: 0.94 },
      { id: "sec_3", label: "尾奏 Outro", kind: "outro", start_sec: 12, end_sec: 16, energy: 0.4 },
    ];
  }
  return invoke<SongStructureSegment[]>("detect_song_structure_local", { filePath });
}

export async function detectDrumHitsLocal(drumStemPath: string): Promise<DrumHit[]> {
  if (!isTauriRuntime()) {
    const hits: DrumHit[] = [];
    for (let i = 0; i < 16; i++) {
      const t = i * 0.25;
      hits.push({ time_sec: t, kind: "hihat", midi_note: 42, velocity: 82 });
      if (i % 4 === 0) hits.push({ time_sec: t, kind: "kick", midi_note: 36, velocity: 110 });
      if (i % 4 === 2) hits.push({ time_sec: t, kind: "snare", midi_note: 38, velocity: 104 });
    }
    return hits;
  }
  return invoke<DrumHit[]>("detect_drum_hits_local", { drumStemPath });
}

export async function exportAudioSliceWav(
  filePath: string,
  startSec: number,
  endSec: number,
  savePath: string
): Promise<string> {
  if (!isTauriRuntime()) return savePath;
  return invoke<string>("export_audio_slice_wav", { filePath, startSec, endSec, savePath });
}

export async function exportMixedWav(
  inputs: StemMixInput[],
  savePath: string,
  targetPeakDbfs = -1.0
): Promise<string> {
  if (!isTauriRuntime()) return savePath;
  return invoke<string>("export_mixed_wav", { inputs, savePath, targetPeakDbfs });
}

export async function saveRecordedTakeWav(
  songName: string,
  label: string,
  wavBase64: string
): Promise<SavedTakeInfo> {
  if (!isTauriRuntime()) {
    const fileName = `${songName}_${label}.wav`;
    return {
      file_name: fileName,
      file_path: `~/Library/Application Support/StemScribe/takes/${fileName}`,
      size_bytes: Math.round((wavBase64.length * 3) / 4),
    };
  }
  return invoke<SavedTakeInfo>("save_recorded_take_wav", { songName, label, wavBase64 });
}

export async function mixTakeWithStemsWav(
  stems: StemMixInput[],
  takeWavBase64: string,
  takeGain: number,
  takeOffsetMs: number,
  savePath: string
): Promise<string> {
  if (!isTauriRuntime()) return savePath;
  return invoke<string>("mix_take_with_stems_wav", {
    stems,
    takeWavBase64,
    takeGain,
    takeOffsetMs,
    savePath,
  });
}


export async function listMidiInputs(): Promise<MidiInputPortInfo[]> {
  if (!isTauriRuntime()) return [];
  return invoke<MidiInputPortInfo[]>("list_midi_inputs");
}

export async function connectMidiInput(portIndex: number): Promise<string> {
  if (!isTauriRuntime()) return "Preview MIDI";
  return invoke<string>("connect_midi_input", { portIndex });
}

export async function disconnectMidiInput(): Promise<void> {
  if (!isTauriRuntime()) return;
  return invoke<void>("disconnect_midi_input");
}

export async function onHardwareMidiNote(
  handler: (evt: HardwareMidiEvent) => void
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return listen<HardwareMidiEvent>("hardware-midi-note", (e) => handler(e.payload));
}

export async function listRecordedTakes(): Promise<SavedTakeInfo[]> {
  if (!isTauriRuntime()) return [];
  return invoke<SavedTakeInfo[]>("list_recorded_takes");
}

export async function deleteRecordedTake(fileName: string): Promise<SavedTakeInfo[]> {
  if (!isTauriRuntime()) return [];
  return invoke<SavedTakeInfo[]>("delete_recorded_take", { fileName });
}

export async function runBatchJob(options: BatchJobOptions): Promise<BatchJobSummary> {
  if (!isTauriRuntime()) {
    return {
      total: options.file_paths.length,
      succeeded: options.file_paths.length,
      failed: 0,
      output_root: options.output_root,
    };
  }
  return invoke<BatchJobSummary>("run_batch_job", { options });
}

export async function exportPracticeBundle(
  project: StemScribeProject,
  keyLabel: string | null,
  targetDir: string
): Promise<string> {
  if (!isTauriRuntime()) return `${targetDir}/${project.name}_StemScribe_Bundle`;
  return invoke<string>("export_practice_bundle", { project, keyLabel, targetDir });
}

export async function exportLeadsheetHtml(
  input: LeadSheetInput,
  savePath: string
): Promise<string> {
  if (!isTauriRuntime()) return savePath;
  return invoke<string>("export_leadsheet_html", { input, savePath });
}

export async function savePracticeRecord(record: PracticeRecord): Promise<PracticeRecord[]> {
  if (!isTauriRuntime()) {
    const prev = await listPracticeRecords();
    const next = [record, ...prev].slice(0, 100);
    localStorage.setItem("stemscribe_practice_logs", JSON.stringify(next));
    return next;
  }
  return invoke<PracticeRecord[]>("save_practice_record", { record });
}

export async function listPracticeRecords(): Promise<PracticeRecord[]> {
  if (!isTauriRuntime()) {
    try {
      const raw = localStorage.getItem("stemscribe_practice_logs");
      return raw ? (JSON.parse(raw) as PracticeRecord[]) : [];
    } catch {
      return [];
    }
  }
  return invoke<PracticeRecord[]>("list_practice_records");
}

export async function deletePracticeRecord(recordId: string): Promise<PracticeRecord[]> {
  if (!isTauriRuntime()) {
    const prev = await listPracticeRecords();
    const next = prev.filter((r) => r.id !== recordId);
    localStorage.setItem("stemscribe_practice_logs", JSON.stringify(next));
    return next;
  }
  return invoke<PracticeRecord[]>("delete_practice_record", { recordId });
}

export async function exportPracticeRecordsCsv(savePath: string): Promise<string> {
  if (!isTauriRuntime()) return savePath;
  return invoke<string>("export_practice_records_csv", { savePath });
}

export async function saveSetlist(setlist: Setlist): Promise<Setlist[]> {
  if (!isTauriRuntime()) {
    const prev = await listSetlists();
    const idx = prev.findIndex((s) => s.id === setlist.id);
    const next = idx >= 0 ? prev.map((s) => (s.id === setlist.id ? setlist : s)) : [setlist, ...prev];
    localStorage.setItem("stemscribe_setlists", JSON.stringify(next));
    return next;
  }
  return invoke<Setlist[]>("save_setlist", { setlist });
}

export async function listSetlists(): Promise<Setlist[]> {
  if (!isTauriRuntime()) {
    try {
      const raw = localStorage.getItem("stemscribe_setlists");
      return raw ? (JSON.parse(raw) as Setlist[]) : [];
    } catch {
      return [];
    }
  }
  return invoke<Setlist[]>("list_setlists");
}

export async function deleteSetlist(setlistId: string): Promise<Setlist[]> {
  if (!isTauriRuntime()) {
    const prev = await listSetlists();
    const next = prev.filter((s) => s.id !== setlistId);
    localStorage.setItem("stemscribe_setlists", JSON.stringify(next));
    return next;
  }
  return invoke<Setlist[]>("delete_setlist", { setlistId });
}

export async function onBatchJobProgress(
  handler: (evt: BatchProgressEvent) => void
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return listen<BatchProgressEvent>("batch-job-progress", (e) => handler(e.payload));
}

export async function onMacosMenuAction(
  handler: (actionId: string) => void
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return listen<string>("menu-action", (e) => handler(e.payload));
}

export async function getSystemDiagnostics(): Promise<SystemDiagnostics> {
  if (!isTauriRuntime()) {
    return {
      app_version: "0.9.9",
      os: "macos (preview)",
      arch: "aarch64",
      coreml_enabled: true,
      basic_pitch_installed: false,
      htdemucs_installed: false,
      models_dir: "~/Library/Application Support/StemScribe/models",
      midi_input_count: 0,
      saved_projects_count: 0,
      practice_records_count: 0,
      recorded_takes_count: 0,
    };
  }
  return invoke<SystemDiagnostics>("get_system_diagnostics");
}

export async function getModelStatus(): Promise<ModelStatus> {
  if (!isTauriRuntime()) {
    return {
      models_dir: "~/Library/Application Support/StemScribe/models",
      demucs_installed: false,
      basic_pitch_installed: false,
      coreml_enabled: true,
    };
  }
  return invoke<ModelStatus>("get_model_status");
}

export async function listOnnxModels(): Promise<ModelItemInfo[]> {
  if (!isTauriRuntime()) {
    return [
      {
        id: "basic_pitch",
        display_name: "Basic Pitch (音频转 MIDI)",
        file_name: "basic_pitch.onnx",
        default_url:
          "https://huggingface.co/spaces/spotify/basic-pitch/resolve/main/basic_pitch/saved_models/icassp_2022/nmp.onnx",
        recommended_source_hint: "支持一键在线下载官方 Spotify ONNX 模型，或替换为国内 HF 镜像 / 离线导入。",
        direct_download_ready: true,
        installed: false,
        size_bytes: 0,
      },
      {
        id: "htdemucs",
        display_name: "HTDemucs 4-Stem (人声/鼓/贝斯/伴奏)",
        file_name: "htdemucs.onnx",
        default_url: "",
        recommended_source_hint: "请运行 scripts/export_models_onnx.py 本地导出后点击「从本地导入 .onnx」，或填入自建镜像 URL。",
        direct_download_ready: false,
        installed: false,
        size_bytes: 0,
      },
    ];
  }
  return invoke<ModelItemInfo[]>("list_onnx_models");
}

export async function downloadOnnxModel(modelId: string, customUrl: string): Promise<string> {
  if (!isTauriRuntime()) {
    return `预览模式：请在 macOS 桌面端执行下载 (${modelId})`;
  }
  return invoke<string>("download_onnx_model", { modelId, customUrl });
}

export async function importOnnxModel(modelId: string, sourcePath: string): Promise<string> {
  if (!isTauriRuntime()) return `~/Library/Application Support/StemScribe/models/${modelId}.onnx`;
  return invoke<string>("import_onnx_model", { modelId, sourcePath });
}

export async function deleteOnnxModel(modelId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  return invoke<void>("delete_onnx_model", { modelId });
}

export async function onModelDownloadProgress(
  handler: (evt: DownloadProgressEvent) => void
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return listen<DownloadProgressEvent>("model-download-progress", (e) => handler(e.payload));
}

export async function separateStems(filePath: string): Promise<StemOutput[]> {
  if (!isTauriRuntime()) {
    const names: Array<[string, string]> = [
      ["vocals", "人声"],
      ["drums", "鼓组"],
      ["bass", "贝斯"],
      ["other", "伴奏/其他"],
    ];
    return names.map(([name, label_zh], idx) => ({
      name,
      label_zh,
      file_path: `${name}.wav`,
      duration_sec: 16,
      waveform_peaks: Array.from({ length: 240 }, (_, i) =>
        Math.abs(Math.sin(i * (0.09 + idx * 0.03) + idx) * 0.75)
      ),
    }));
  }
  return invoke<StemOutput[]>("separate_stems", { filePath, outputDir: null });
}

export async function transcribeStemToMidi(
  stemPath: string,
  stemName: string
): Promise<TranscriptionResult> {
  if (!isTauriRuntime()) {
    const demoPitches = [60, 64, 67, 72, 71, 67, 64, 62, 60, 62, 64, 67, 69, 67, 64, 60];
    const notes: MidiNote[] = demoPitches.map((pitch, idx) => ({
      pitch,
      start_sec: idx * 0.5,
      end_sec: idx * 0.5 + 0.44,
      velocity: 92,
      confidence: 0.91,
    }));
    return { stem_name: stemName, estimated_bpm: 120, notes };
  }
  return invoke<TranscriptionResult>("transcribe_stem_to_midi", { stemPath, stemName });
}

export async function importMidiFile(midiPath: string): Promise<TranscriptionResult> {
  if (!isTauriRuntime()) {
    const pitches = [60, 62, 64, 67, 69, 67, 64, 60];
    return {
      stem_name: midiPath.replace(/\.midi?$/i, ""),
      estimated_bpm: 120,
      notes: pitches.map((pitch, idx) => ({
        pitch,
        start_sec: idx * 0.5,
        end_sec: idx * 0.5 + 0.45,
        velocity: 96,
        confidence: 1.0,
      })),
    };
  }
  return invoke<TranscriptionResult>("import_midi_file", { midiPath });
}

export async function exportMidiFile(
  notes: MidiNote[],
  bpm: number,
  savePath: string
): Promise<string> {
  if (!isTauriRuntime()) return savePath;
  return invoke<string>("export_midi_file", { notes, bpm, savePath });
}

export async function exportMidiWithChords(
  notes: MidiNote[],
  chords: ChordEvent[],
  bpm: number,
  savePath: string
): Promise<string> {
  if (!isTauriRuntime()) return savePath;
  return invoke<string>("export_midi_with_chords", { notes, chords, bpm, savePath });
}

export async function exportMusicXmlFile(
  title: string,
  notes: MidiNote[],
  chords: ChordEvent[],
  bpm: number,
  savePath: string
): Promise<string> {
  if (!isTauriRuntime()) return savePath;
  return invoke<string>("export_musicxml_file", { title, notes, chords, bpm, savePath });
}

export async function extractLyricsWithRelay(
  audioPath: string,
  useWhisperEndpoint: boolean,
  config: LlmRelayConfig
): Promise<LyricLine[]> {
  if (!isTauriRuntime()) {
    return [
      { start_sec: 0.5, end_sec: 3.8, text: "（预览示例）夜色漫过窗台的微光" },
      { start_sec: 4.0, end_sec: 7.6, text: "琴弦轻轻拨动熟悉的方向" },
      { start_sec: 8.1, end_sec: 11.8, text: "每一拍心跳都和鼓点共振" },
      { start_sec: 12.0, end_sec: 15.6, text: "在副歌响起时回到最初的旋律" },
    ];
  }
  return invoke<LyricLine[]>("extract_lyrics_with_relay", {
    audioPath,
    useWhisperEndpoint,
    config,
  });
}

export async function importLrcFile(filePath: string): Promise<LyricLine[]> {
  if (!isTauriRuntime()) {
    return [
      { start_sec: 0.5, end_sec: 4.0, text: "（预览导入）微风吹过指尖的旋律" },
      { start_sec: 4.0, end_sec: 8.0, text: "把每一句歌词对齐到节拍里" },
    ];
  }
  return invoke<LyricLine[]>("import_lrc_file", { filePath });
}

export async function exportLrcFile(
  title: string,
  lines: LyricLine[],
  savePath: string
): Promise<string> {
  if (!isTauriRuntime()) return savePath;
  return invoke<string>("export_lrc_file", { title, lines, savePath });
}

export async function exportSrtFile(
  lines: LyricLine[],
  savePath: string
): Promise<string> {
  if (!isTauriRuntime()) return savePath;
  return invoke<string>("export_srt_file", { lines, savePath });
}

export async function saveProjectFile(project: StemScribeProject): Promise<string> {
  if (!isTauriRuntime()) {
    localStorage.setItem(`stemscribe_proj_${project.id}`, JSON.stringify(project));
    return `localStorage:${project.id}`;
  }
  return invoke<string>("save_project_file", { project });
}

export async function loadProjectFile(projectId: string): Promise<StemScribeProject> {
  if (!isTauriRuntime()) {
    const raw = localStorage.getItem(`stemscribe_proj_${projectId}`);
    if (!raw) throw new Error("未找到本地预览工程");
    return JSON.parse(raw);
  }
  return invoke<StemScribeProject>("load_project_file", { projectId });
}

export async function listSavedProjects(): Promise<ProjectSummary[]> {
  if (!isTauriRuntime()) {
    const out: ProjectSummary[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("stemscribe_proj_")) {
        const p = JSON.parse(localStorage.getItem(k)!) as StemScribeProject;
        out.push({
          id: p.id,
          name: p.name,
          updated_at: p.updated_at,
          file_path: k,
          note_count: p.notes.length,
        });
      }
    }
    return out;
  }
  return invoke<ProjectSummary[]>("list_saved_projects");
}

export async function deleteProjectFile(projectId: string): Promise<ProjectSummary[]> {
  if (!isTauriRuntime()) {
    localStorage.removeItem(`stemscribe_proj_${projectId}`);
    return listSavedProjects();
  }
  return invoke<ProjectSummary[]>("delete_project_file", { projectId });
}

export async function renameProjectFile(
  projectId: string,
  newName: string
): Promise<ProjectSummary[]> {
  if (!isTauriRuntime()) {
    const raw = localStorage.getItem(`stemscribe_proj_${projectId}`);
    if (raw) {
      const p = JSON.parse(raw) as StemScribeProject;
      p.name = newName;
      localStorage.setItem(`stemscribe_proj_${projectId}`, JSON.stringify(p));
    }
    return listSavedProjects();
  }
  return invoke<ProjectSummary[]>("rename_project_file", { projectId, newName });
}

export async function testLlmRelayConnection(config: LlmRelayConfig): Promise<string> {
  if (!isTauriRuntime()) {
    return `预览模式模拟连通 (${config.protocol} · ${config.model})`;
  }
  return invoke<string>("test_llm_relay_connection", { config });
}

export async function analyzeArrangementWithLlm(
  audioPath: string,
  bpm: number | null,
  sliceStartSec: number | null,
  sliceEndSec: number | null,
  config: LlmRelayConfig
): Promise<ArrangementAnalysis> {
  return invoke<ArrangementAnalysis>("analyze_arrangement_with_llm", {
    audioPath,
    bpm,
    sliceStartSec,
    sliceEndSec,
    config,
  });
}

export async function refineMidiWithLlm(
  audioPath: string,
  notes: MidiNote[],
  instrument: string,
  userPrompt: string,
  sliceStartSec: number | null,
  sliceEndSec: number | null,
  config: LlmRelayConfig
): Promise<RefinedScoreResponse> {
  return invoke<RefinedScoreResponse>("refine_midi_with_llm", {
    audioPath,
    notes,
    instrument,
    userPrompt,
    sliceStartSec,
    sliceEndSec,
    config,
  });
}
