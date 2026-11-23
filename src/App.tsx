import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Music,
  Settings,
  Download,
  FileText,
  FolderOpen,
  HelpCircle,
  History,
  Layers,
  ListMusic,
  ListOrdered,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Package,
  Save,
  Search,
  Share2,
  Sparkles,
  Wand2,
} from "lucide-react";
import { AiAssistantPanel } from "./components/AiAssistantPanel";
import { BatchQueueModal } from "./components/BatchQueueModal";
import { ChordTrack } from "./components/ChordTrack";
import { CommandPaletteModal, type PaletteCommand } from "./components/CommandPaletteModal";
import { CoverStudioView } from "./components/CoverStudioView";
import { DiagnosticsModal } from "./components/DiagnosticsModal";
import { DrumPatternView } from "./components/DrumPatternView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FallingNotesView } from "./components/FallingNotesView";
import { LeadSheetModal } from "./components/LeadSheetModal";
import { LiveInstrumentView } from "./components/LiveInstrumentView";
import { LyricsTimeline } from "./components/LyricsTimeline";
import { ModelManagerModal } from "./components/ModelManagerModal";
import { PracticeCoachView } from "./components/PracticeCoachView";
import { ProjectLibraryModal } from "./components/ProjectLibraryModal";
import { ScoreViewer } from "./components/ScoreViewer";
import { SetlistModal } from "./components/SetlistModal";
import { ShareCardModal } from "./components/ShareCardModal";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { StageModeOverlay } from "./components/StageModeOverlay";
import { SettingsModal, type SettingsSection } from "./components/SettingsModal";
import { Arrangement, type ArrangementTrack } from "./components/daw/Arrangement";
import { MixerPanel, type MixPresetId } from "./components/daw/MixerPanel";
import { TransportBar } from "./components/daw/TransportBar";
import {
  MultiStemAudioEngine,
  type MasterEqState,
  type ReverbPreset,
  type SynthTimbre,
} from "./lib/audioEngine";
import { createDemoStudioBundle } from "./lib/demoStudio";
import { chordToMidiVoicing, keyPrefersFlats, parseChordSymbol } from "./lib/musicTheory";
import {
  analyzeArrangementWithLlm,
  askConfirm,
  deleteSetlist,
  detectBpmLocal,
  detectChordsLocal,
  detectDrumHitsLocal,
  detectKeyLocal,
  detectSongStructureLocal,
  exportAudioSliceWav,
  exportLeadsheetHtml,
  exportLrcFile,
  exportSrtFile,
  importLrcFile,
  exportMidiFile,
  exportMidiWithChords,
  exportMixedWav,
  exportMusicXmlFile,
  exportPracticeBundle,
  extractLyricsWithRelay,
  getModelStatus,
  importMidiFile,
  inspectAudioFile,
  deletePracticeRecord,
  exportPracticeRecordsCsv,
  listPracticeRecords,
  deleteRecordedTake,
  listRecordedTakes,
  listSavedProjects,
  listSetlists,
  loadProjectFile,
  mixTakeWithStemsWav,
  onMacosMenuAction,
  onNativeFileDrop,
  pickAudioFile,
  pickDirectory,
  pickHtmlSavePath,
  pickLrcOpenPath,
  pickLrcSavePath,
  pickCsvSavePath,
  pickSrtSavePath,
  pickMidiOpenPath,
  pickMidiSavePath,
  pickMusicXmlSavePath,
  pickWavSavePath,
  refineMidiWithLlm,
  reharmonizeChordsLocal,
  savePracticeRecord,
  deleteProjectFile,
  renameProjectFile,
  saveProjectFile,
  saveRecordedTakeWav,
  saveSetlist,
  separateStems,
  testLlmRelayConnection,
  transcribeStemToMidi,
} from "./lib/tauriApi";
import { HardwareMidiBridge, type MidiInputDeviceInfo } from "./lib/webMidi";
import type {
  ArrangementAnalysis,
  AudioMetadata,
  ChordEvent,
  DrumHit,
  KeyEstimate,
  LeadSheetInput,
  LlmRelayConfig,
  LyricLine,
  MidiNote,
  ModelStatus,
  PracticeRecord,
  ProjectSummary,
  ReharmonizeStyle,
  SavedTakeInfo,
  SectionMarker,
  Setlist,
  SongStructureSegment,
  StemMixerState,
  StemMixInput,
  StemOutput,
  StemScribeProject,
  TempoAndLoudness,
} from "./types/music";

type StudioTab =
  | "score"
  | "chords"
  | "drums"
  | "lyrics"
  | "mixer"
  | "falling"
  | "instrument"
  | "coach"
  | "cover";

const STEM_COLORS: Record<string, string> = {
  original: "#94a3b8",
  vocals: "#f43f5e",
  drums: "#f59e0b",
  bass: "#a855f7",
  other: "#38bdf8",
};

const EDITOR_MIN_H = 180;

const EDITOR_TAB_GROUPS: Array<{ label: string; tabs: Array<{ id: StudioTab; label: string }> }> = [
  {
    label: "编辑",
    tabs: [
      { id: "score", label: "乐谱 / 卷帘" },
      { id: "chords", label: "和弦" },
      { id: "drums", label: "鼓组" },
      { id: "lyrics", label: "歌词" },
      { id: "mixer", label: "混音" },
    ],
  },
  {
    label: "练习",
    tabs: [
      { id: "falling", label: "瀑布流" },
      { id: "instrument", label: "琴键 / 指板" },
      { id: "coach", label: "跟弹打分" },
      { id: "cover", label: "翻唱录音" },
    ],
  },
];

const REHARM_STYLES: Array<{ id: ReharmonizeStyle; label: string }> = [
  { id: "jazz_neosoul", label: "爵士 / City Pop" },
  { id: "folk_open", label: "民谣指弹" },
  { id: "cinematic_minor", label: "暗黑电影感" },
  { id: "pop_beginner", label: "新手极简" },
];
type AppTheme = "dark" | "midnight" | "light";

function isDemoBlobPath(path: string | undefined): boolean {
  return Boolean(path && (path.startsWith("blob:") || path.startsWith("data:")));
}

const DEFAULT_RELAY: LlmRelayConfig = {
  base_url: "https://api.openai.com/v1",
  api_key: "",
  model: "gemini-2.5-pro",
  protocol: "openai_input_audio",
};

const THEME_CYCLE: AppTheme[] = ["dark", "midnight", "light"];
const THEME_LABELS: Record<AppTheme, string> = {
  dark: "暗黑录音室",
  midnight: "午夜靛蓝",
  light: "明亮纸谱",
};

export const App: React.FC = () => {
  const engineRef = useRef<MultiStemAudioEngine | null>(null);
  const midiBridgeRef = useRef<HardwareMidiBridge | null>(null);
  const tapTimesRef = useRef<number[]>([]);
  const demoBlobUrlsRef = useRef<string[]>([]);

  const [theme, setTheme] = useState<AppTheme>(() => {
    const saved = localStorage.getItem("stemscribe_theme") as AppTheme | null;
    return saved && THEME_CYCLE.includes(saved) ? saved : "dark";
  });
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [editorOpen, setEditorOpen] = useState(true);
  const [editorHeight, setEditorHeight] = useState(300);

  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [showModelModal, setShowModelModal] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [showProjectLibrary, setShowProjectLibrary] = useState(false);
  const [showDiagnosticsModal, setShowDiagnosticsModal] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showSetlistModal, setShowSetlistModal] = useState(false);
  const [showLeadSheetModal, setShowLeadSheetModal] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [shareScoreSummary, setShareScoreSummary] = useState<{
    accuracyPct: number;
    maxCombo: number;
    rank: string;
  } | null>(null);
  const [stageModeOpen, setStageModeOpen] = useState(false);
  const [studioTab, setStudioTab] = useState<StudioTab>("score");

  const [midiDevices, setMidiDevices] = useState<MidiInputDeviceInfo[]>([]);
  const [pressedHardwareNotes, setPressedHardwareNotes] = useState<number[]>([]);

  const [setlists, setSetlists] = useState<Setlist[]>([]);
  const [activeSetlistId, setActiveSetlistId] = useState<string | null>(null);
  const [activeSetlistIndex, setActiveSetlistIndex] = useState<number>(-1);
  const [archivedTakes, setArchivedTakes] = useState<SavedTakeInfo[]>([]);

  const [audioMeta, setAudioMeta] = useState<AudioMetadata | null>(null);
  const [tempoInfo, setTempoInfo] = useState<TempoAndLoudness | null>(null);
  const [stems, setStems] = useState<StemOutput[]>([]);
  const [chords, setChords] = useState<ChordEvent[]>([]);
  const [originalChordsBackup, setOriginalChordsBackup] = useState<ChordEvent[] | null>(null);
  const [activeReharmStyle, setActiveReharmStyle] = useState<string | null>(null);
  const [reverbPreset, setReverbPreset] = useState<ReverbPreset>("off");
  const [reverbWet, setReverbWet] = useState<number>(0.25);

  const [keyEst, setKeyEst] = useState<KeyEstimate | null>(null);
  const [structure, setStructure] = useState<SongStructureSegment[]>([]);
  const [markers, setMarkers] = useState<SectionMarker[]>([]);
  const [drumHits, setDrumHits] = useState<DrumHit[]>([]);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [practiceRecords, setPracticeRecords] = useState<PracticeRecord[]>([]);
  const [mixer, setMixer] = useState<Record<string, StemMixerState>>({});
  const [eq, setEq] = useState<MasterEqState>({ lowDb: 0, midDb: 0, highDb: 0 });
  const [recentProjects, setRecentProjects] = useState<ProjectSummary[]>([]);
  const [showProjectsMenu, setShowProjectsMenu] = useState(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);
  const [countInEnabled, setCountInEnabled] = useState(false);
  const [progressiveRampEnabled, setProgressiveRampEnabled] = useState(false);
  const [midiAuditionEnabled, setMidiAuditionEnabled] = useState(false);
  const [synthTimbre, setSynthTimbre] = useState<SynthTimbre>("triangle");
  const [transposeSemitones, setTransposeSemitones] = useState(0);
  const [capoFret, setCapoFret] = useState(0);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopA, setLoopA] = useState(0);
  const [loopB, setLoopB] = useState(8);

  const [activeStemName, setActiveStemName] = useState("");
  const [bpm, setBpm] = useState(120);
  const [notes, setNotes] = useState<MidiNote[]>([]);
  const [undoStack, setUndoStack] = useState<MidiNote[][]>([]);
  const [redoStack, setRedoStack] = useState<MidiNote[][]>([]);

  const [separating, setSeparating] = useState(false);
  const [autoPipelining, setAutoPipelining] = useState(false);
  const [detectingChords, setDetectingChords] = useState(false);
  const [detectingStructure, setDetectingStructure] = useState(false);
  const [detectingDrums, setDetectingDrums] = useState(false);
  const [extractingLyrics, setExtractingLyrics] = useState(false);
  const [transcribingStem, setTranscribingStem] = useState<string | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [statusMsg, setStatusMsg] = useState("就绪");

  const [relayConfig, setRelayConfig] = useState<LlmRelayConfig>(() => {
    try {
      const saved = localStorage.getItem("stemscribe_relay_config");
      return saved ? { ...DEFAULT_RELAY, ...JSON.parse(saved) } : DEFAULT_RELAY;
    } catch {
      return DEFAULT_RELAY;
    }
  });
  const [analysis, setAnalysis] = useState<ArrangementAnalysis | null>(null);
  const [refineSummary, setRefineSummary] = useState("");
  const [fingeringTips, setFingeringTips] = useState<string[]>([]);

  const applyTheme = (next: AppTheme) => {
    setTheme(next);
    localStorage.setItem("stemscribe_theme", next);
    setStatusMsg(`已切换界面主题：${THEME_LABELS[next]}`);
  };

  const handleCycleTheme = () => applyTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]);

  const openSettings = (section: SettingsSection = "general") => {
    setSettingsSection(section);
    setShowSettings(true);
  };

  const revokeDemoBlobs = () => {
    for (const url of demoBlobUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    demoBlobUrlsRef.current = [];
  };

  const commitNotes = useCallback(
    (nextNotes: MidiNote[]) => {
      setUndoStack((prev) => [...prev.slice(-30), notes]);
      setRedoStack([]);
      setNotes(nextNotes);
    },
    [notes]
  );

  const handleUndo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setRedoStack((r) => [...r, notes]);
      setNotes(last);
      return prev.slice(0, -1);
    });
  }, [notes]);

  const handleRedo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const next = prev[prev.length - 1];
      setUndoStack((u) => [...u, notes]);
      setNotes(next);
      return prev.slice(0, -1);
    });
  }, [notes]);

  const handleQuantize = useCallback(
    (subdiv: number) => {
      if (notes.length === 0) return;
      const step = 60 / Math.max(40, bpm) / subdiv;
      const quantized = notes.map((n) => {
        const dur = Math.max(step, Math.round((n.end_sec - n.start_sec) / step) * step);
        const start = Math.max(0, Math.round(n.start_sec / step) * step);
        return { ...n, start_sec: start, end_sec: start + dur };
      });
      commitNotes(quantized);
      setStatusMsg(`已将 ${quantized.length} 个音符量化对齐到 1/${subdiv * 4} 网格。`);
    },
    [notes, bpm, commitNotes]
  );

  const handleReharmonize = async (style: ReharmonizeStyle) => {
    if (chords.length === 0) return;
    const base = originalChordsBackup ?? chords;
    if (!originalChordsBackup) {
      setOriginalChordsBackup(chords);
    }
    try {
      const res = await reharmonizeChordsLocal(base, style);
      setChords(res.chords);
      setActiveReharmStyle(style);
      setStatusMsg(`已应用「${res.style_label_zh}」和弦重配：${res.description}`);
    } catch (err) {
      setStatusMsg(`和弦重配失败: ${String(err)}`);
    }
  };

  const handleRestoreOriginalChords = () => {
    if (!originalChordsBackup) return;
    setChords(originalChordsBackup);
    setOriginalChordsBackup(null);
    setActiveReharmStyle(null);
    setStatusMsg("已还原为原始识别和弦走向。");
  };

  const handleReverbChange = (preset: ReverbPreset, wet: number) => {
    setReverbPreset(preset);
    setReverbWet(wet);
    engineRef.current?.setReverb(preset, wet);
  };

  const handleArchiveTake = async (songName: string, label: string, wavBase64: string) => {
    const saved = await saveRecordedTakeWav(songName, label, wavBase64);
    const updated = await listRecordedTakes().catch(() => [saved]);
    setArchivedTakes(updated.length > 0 ? updated : [saved]);
    setStatusMsg(`已归档叠录 WAV：${saved.file_path}`);
    return saved.file_path;
  };

  const handleBounceCoverWav = async (
    label: string,
    wavBase64: string,
    takeGain: number,
    takeOffsetMs: number
  ): Promise<string | null> => {
    if (stems.length === 0) return null;
    if (stems.some((s) => isDemoBlobPath(s.file_path))) {
      setStatusMsg("内置演示曲支持直接导出「干声 WAV」；若需伴奏+人声合轨成品 WAV，请先导入本地音频文件。");
      return null;
    }
    const savePath = await pickWavSavePath(
      `${(audioMeta?.file_name || "cover").replace(/\.[^.]+$/, "")}_${label}_final_mix.wav`
    );
    if (!savePath) return null;
    const anySolo = Object.values(mixer).some((m) => m.solo);
    const inputs: StemMixInput[] = stems.map((s) => {
      const st = mixer[s.name] ?? { muted: false, solo: false, gain: 1, pan: 0 };
      const enabled = anySolo ? st.solo : !st.muted;
      return { file_path: s.file_path, gain: st.gain, pan: st.pan ?? 0, enabled };
    });
    setStatusMsg("正在合轨导出成品 WAV…");
    const saved = await mixTakeWithStemsWav(inputs, wavBase64, takeGain, takeOffsetMs, savePath);
    setStatusMsg(`成品翻唱 WAV 已导出：${saved}`);
    return saved;
  };

  const handleConnectMidi = useCallback(async () => {
    try {
      if (!midiBridgeRef.current) midiBridgeRef.current = new HardwareMidiBridge();
      const devs = await midiBridgeRef.current.connect(
        (evt) => {
          if (evt.type === "noteon") {
            engineRef.current?.playSingleNote(evt.pitch, 0.45, evt.velocity);
            setPressedHardwareNotes((prev) =>
              prev.includes(evt.pitch) ? prev : [...prev, evt.pitch]
            );
          } else {
            setPressedHardwareNotes((prev) => prev.filter((p) => p !== evt.pitch));
          }
        },
        (devices) => setMidiDevices(devices)
      );
      if (devs.length === 0) {
        setStatusMsg("Web MIDI 已就绪，但暂未检测到外接 USB-MIDI 键盘（插入设备后将自动热连接）。");
      } else {
        setStatusMsg(`已连接硬件 MIDI 设备：${devs.map((d) => d.name).join(" / ")}`);
      }
    } catch (err) {
      setStatusMsg(`MIDI 接入提示：${String(err)}`);
    }
  }, []);

  const handleLoadDemoSong = useCallback(() => {
    revokeDemoBlobs();
    const demo = createDemoStudioBundle();
    demoBlobUrlsRef.current = demo.blobUrls;

    setAudioMeta(demo.audioMeta);
    setTempoInfo(demo.tempoInfo);
    setKeyEst(demo.keyEst);
    setStructure(demo.structure);
    setStems(demo.stems);
    setChords(demo.chords);
    setOriginalChordsBackup(null);
    setActiveReharmStyle(null);
    setDrumHits(demo.drumHits);
    setLyrics(demo.lyrics);
    setNotes(demo.notes);
    setActiveStemName("人声");
    setBpm(120);
    setTransposeSemitones(0);
    setCapoFret(0);
    setUndoStack([]);
    setRedoStack([]);
    setMarkers([
      { id: "demo_m1", label: "副歌入口", time_sec: 8.0 },
      { id: "demo_m2", label: "第二遍副歌", time_sec: 16.0 },
    ]);
    setLoopA(8);
    setLoopB(16);
    setLoopEnabled(false);

    const initMixer: Record<string, StemMixerState> = {};
    for (const s of demo.stems) {
      initMixer[s.name] = { muted: false, solo: false, gain: 1.0, pan: 0 };
    }
    setMixer(initMixer);
    engineRef.current?.loadStems(demo.stems, (t) => setCurrentTime(t));
    engineRef.current?.applyMixer(initMixer);
    engineRef.current?.setMasterEq(eq);
    engineRef.current?.setReverb(reverbPreset, reverbWet);
    engineRef.current?.setMetronome(metronomeEnabled, 120);
    setIsPlaying(false);
    setCurrentTime(0);
    setStudioTab("falling");
    setStatusMsg("已载入演示曲《星海漫游》");
  }, [eq, reverbPreset, reverbWet, metronomeEnabled]);

  const loadAudioByPath = useCallback(
    async (path: string) => {
      setLoadingAudio(true);
      try {
        revokeDemoBlobs();
        setStatusMsg("正在分析音频…");
        const meta = await inspectAudioFile(path);
        setAudioMeta(meta);
        setStems([]);
        setChords([]);
        setOriginalChordsBackup(null);
        setActiveReharmStyle(null);
        setStructure([]);
        setMarkers([]);
        setDrumHits([]);
        setLyrics([]);
        setNotes([]);
        setUndoStack([]);
        setRedoStack([]);
        setCapoFret(0);
        setLoopA(0);
        setLoopB(Math.min(8, meta.duration_sec));
        detectKeyLocal(path).then(setKeyEst).catch(() => setKeyEst(null));
        detectSongStructureLocal(path).then(setStructure).catch(() => setStructure([]));
        detectBpmLocal(path)
          .then((t) => {
            setTempoInfo(t);
            setBpm(t.bpm);
            engineRef.current?.setMetronome(metronomeEnabled, t.bpm);
          })
          .catch(() => setTempoInfo(null));
        setStatusMsg(`已载入：${meta.file_name} (${meta.duration_sec.toFixed(1)}s)`);
      } catch (err) {
        setStatusMsg(`音频加载失败: ${String(err)}`);
      } finally {
        setLoadingAudio(false);
      }
    },
    [metronomeEnabled]
  );

  const refreshModelStatus = () => {
    getModelStatus().then(setModelStatus).catch(() => {});
  };

  useEffect(() => {
    const onUnhandledRejection = (evt: PromiseRejectionEvent) => {
      setStatusMsg(`后台任务出错: ${String(evt.reason)}`);
    };
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => window.removeEventListener("unhandledrejection", onUnhandledRejection);
  }, []);

  useEffect(() => {
    engineRef.current = new MultiStemAudioEngine();
    refreshModelStatus();
    listSavedProjects().then(setRecentProjects).catch(() => {});
    listPracticeRecords().then(setPracticeRecords).catch(() => {});
    listSetlists().then(setSetlists).catch(() => {});
    listRecordedTakes().then(setArchivedTakes).catch(() => {});
    return () => {
      engineRef.current?.dispose();
      midiBridgeRef.current?.disconnect();
      revokeDemoBlobs();
    };
  }, []);


  const transposedNotes = useMemo(() => {
    if (transposeSemitones === 0) return notes;
    return notes.map((n) => ({
      ...n,
      pitch: Math.max(21, Math.min(108, n.pitch + transposeSemitones)),
    }));
  }, [notes, transposeSemitones]);

  useEffect(() => {
    engineRef.current?.setMidiAudition(midiAuditionEnabled, transposedNotes, synthTimbre);
  }, [midiAuditionEnabled, transposedNotes, synthTimbre]);

  useEffect(() => {
    engineRef.current?.setProgressiveRamp(progressiveRampEnabled, (nextRate) => {
      setPlaybackRate(nextRate);
      setStatusMsg(`渐进提速：当前循环倍速已提升至 ${(nextRate * 100).toFixed(0)}%`);
    });
  }, [progressiveRampEnabled]);

  const transposedScale = useMemo(() => {
    if (!keyEst) return undefined;
    return keyEst.scale_pitch_classes.map((pc) => (pc + transposeSemitones + 120) % 12);
  }, [keyEst, transposeSemitones]);

  const useFlats = useMemo(() => {
    if (!keyEst) return undefined;
    const tonic = parseChordSymbol(keyEst.tonic);
    if (!tonic) return undefined;
    const shiftedPc = (tonic.rootPc + transposeSemitones + 120) % 12;
    return keyPrefersFlats(shiftedPc, keyEst.mode === "minor") ?? undefined;
  }, [keyEst, transposeSemitones]);

  const buildCurrentProject = useCallback((): StemScribeProject | null => {
    if (!audioMeta) return null;
    return {
      id: audioMeta.file_name.replace(/[^a-zA-Z0-9_-]/g, "_"),
      name: audioMeta.file_name,
      updated_at: new Date().toISOString(),
      audio_meta: audioMeta,
      stems,
      chords,
      lyrics,
      markers,
      active_stem_name: activeStemName,
      bpm,
      transpose_semitones: transposeSemitones,
      loop_a: loopA,
      loop_b: loopB,
      notes: transposedNotes,
      analysis,
    };
  }, [
    audioMeta,
    stems,
    chords,
    lyrics,
    markers,
    activeStemName,
    bpm,
    transposeSemitones,
    loopA,
    loopB,
    transposedNotes,
    analysis,
  ]);

  const handleExportLeadSheetHtml = async (input: LeadSheetInput) => {
    const savePath = await pickHtmlSavePath(`${input.title || "leadsheet"}_A4.html`);
    if (!savePath) return;
    try {
      const saved = await exportLeadsheetHtml(input, savePath);
      setStatusMsg(`已导出可打印 A4 弹唱谱 HTML：${saved}`);
    } catch (err) {
      setStatusMsg(`导出弹唱谱失败: ${String(err)}`);
    }
  };

  const handleSavePracticeRecord = async (record: PracticeRecord) => {
    try {
      const updated = await savePracticeRecord(record);
      setPracticeRecords(updated);
      setShareScoreSummary({
        accuracyPct: record.accuracy_pct,
        maxCombo: record.max_combo,
        rank: record.rank,
      });
      setStatusMsg(`已保存练琴记录：${record.rank} 级 (${record.accuracy_pct.toFixed(1)}%)`);
    } catch (err) {
      setStatusMsg(`保存练琴记录失败: ${String(err)}`);
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    try {
      const list = await deleteProjectFile(projectId);
      setRecentProjects(list);
      setStatusMsg("已从本地工程库删除该工程。");
    } catch (err) {
      setStatusMsg(`删除工程失败: ${String(err)}`);
    }
  };

  const handleRenameProject = async (projectId: string, newName: string) => {
    try {
      const list = await renameProjectFile(projectId, newName);
      setRecentProjects(list);
      setStatusMsg(`已重命名工程为：${newName}`);
    } catch (err) {
      setStatusMsg(`重命名工程失败: ${String(err)}`);
    }
  };

  const handleLoopMarkerSection = (startSec: number, endSec: number, label: string) => {
    setLoopA(startSec);
    setLoopB(endSec);
    setLoopEnabled(true);
    engineRef.current?.setLoop(true, startSec, endSec);
    engineRef.current?.seek(startSec);
    setStatusMsg(`已锁定段落循环「${label}」：${startSec.toFixed(1)}s - ${endSec.toFixed(1)}s`);
  };

  const handleDeletePracticeRecord = async (recordId: string) => {
    try {
      const updated = await deletePracticeRecord(recordId);
      setPracticeRecords(updated);
      setStatusMsg("已删除该条练琴记录。");
    } catch (err) {
      setStatusMsg(`删除练琴记录失败: ${String(err)}`);
    }
  };

  const handleExportPracticeCsv = async () => {
    if (practiceRecords.length === 0) return;
    const savePath = await pickCsvSavePath("StemScribe_练琴记录.csv");
    if (!savePath) return;
    try {
      const saved = await exportPracticeRecordsCsv(savePath);
      setStatusMsg(`已导出练琴成长日志 CSV：${saved}`);
    } catch (err) {
      setStatusMsg(`导出练琴日志失败: ${String(err)}`);
    }
  };

  const handleSaveSetlist = async (sl: Setlist) => {
    try {
      const updated = await saveSetlist(sl);
      setSetlists(updated);
    } catch (err) {
      setStatusMsg(`保存歌单失败: ${String(err)}`);
    }
  };

  const handleDeleteSetlist = async (id: string) => {
    try {
      const updated = await deleteSetlist(id);
      setSetlists(updated);
      if (activeSetlistId === id) {
        setActiveSetlistId(null);
        setActiveSetlistIndex(-1);
      }
    } catch (err) {
      setStatusMsg(`删除歌单失败: ${String(err)}`);
    }
  };

  const handleAddCurrentSongToSetlist = async (sl: Setlist) => {
    const proj = buildCurrentProject();
    if (!proj) return;
    try {
      await saveProjectFile(proj);
      const list = await listSavedProjects();
      setRecentProjects(list);
      const next: Setlist = {
        ...sl,
        updated_at: new Date().toISOString(),
        items: [
          ...sl.items,
          {
            project_id: proj.id,
            song_name: proj.name,
            bpm: proj.bpm,
            key_label: keyEst?.label ?? "未定调",
            capo_fret: capoFret,
          },
        ],
      };
      await handleSaveSetlist(next);
      setStatusMsg(`已将「${proj.name}」加入歌单「${sl.name}」`);
    } catch (err) {
      setStatusMsg(`加入歌单失败: ${String(err)}`);
    }
  };

  const handleLoadProject = useCallback(async (projectId: string, preferredCapo?: number) => {
    try {
      const p = await loadProjectFile(projectId);
      setAudioMeta(p.audio_meta);
      setStems(p.stems);
      setChords(p.chords);
      setOriginalChordsBackup(null);
      setActiveReharmStyle(null);
      setLyrics(p.lyrics ?? []);
      setMarkers(p.markers ?? []);
      setActiveStemName(p.active_stem_name);
      setBpm(p.bpm);
      setTransposeSemitones(p.transpose_semitones);
      setCapoFret(preferredCapo ?? 0);
      engineRef.current?.setTranspose(p.transpose_semitones);
      setLoopA(p.loop_a);
      setLoopB(p.loop_b);
      setNotes(p.notes);
      setUndoStack([]);
      setRedoStack([]);
      setAnalysis(p.analysis);
      setShowProjectsMenu(false);
      setIsPlaying(false);
      setCurrentTime(0);
      if (p.stems.length > 0) {
        engineRef.current?.loadStems(p.stems, (t) => setCurrentTime(t));
      }
      setStatusMsg(`已恢复工程：${p.name}`);
    } catch (err) {
      setStatusMsg(`加载工程失败: ${String(err)}`);
    }
  }, []);

  const handleStartSetlistSong = useCallback(
    async (sl: Setlist, index: number, openStage: boolean) => {
      const item = sl.items[index];
      if (!item) return;
      setActiveSetlistId(sl.id);
      setActiveSetlistIndex(index);
      await handleLoadProject(item.project_id, item.capo_fret);
      setShowSetlistModal(false);
      if (openStage) setStageModeOpen(true);
    },
    [handleLoadProject]
  );

  const activeSetlist = useMemo(
    () => setlists.find((s) => s.id === activeSetlistId) ?? null,
    [setlists, activeSetlistId]
  );

  const handleApplyMixPreset = (preset: MixPresetId) => {
    const next: Record<string, StemMixerState> = {};
    for (const s of stems) {
      let muted = false;
      let solo = false;
      if (preset === "karaoke" && s.name === "vocals") muted = true;
      if (preset === "no_drums" && s.name === "drums") muted = true;
      if (preset === "bass_focus") solo = s.name === "bass";
      if (preset === "vocals_only") solo = s.name === "vocals";
      next[s.name] = { muted, solo, gain: 1.0, pan: 0 };
    }
    setMixer(next);
    engineRef.current?.applyMixer(next);

    const eqMap: Record<MixPresetId, MasterEqState> = {
      original: { lowDb: 0, midDb: 0, highDb: 0 },
      karaoke: { lowDb: 1, midDb: -1, highDb: 1 },
      no_drums: { lowDb: 0, midDb: 2, highDb: 0 },
      bass_focus: { lowDb: 4, midDb: 2, highDb: -3 },
      vocals_only: { lowDb: -4, midDb: 3, highDb: 2 },
    };
    const nextEq = eqMap[preset];
    setEq(nextEq);
    engineRef.current?.setMasterEq(nextEq);
    setStatusMsg(`已切换混音预设：${preset}`);
  };

  const handleExportLoopSlice = async () => {
    if (!audioMeta || loopB <= loopA + 0.05) return;
    if (isDemoBlobPath(audioMeta.file_path)) {
      setStatusMsg("当前为内置演示曲，请先导入本地音频文件后再导出 A-B WAV 切片。");
      return;
    }
    const savePath = await pickWavSavePath(
      `${audioMeta.file_name}_${loopA.toFixed(0)}s-${loopB.toFixed(0)}s.wav`
    );
    if (!savePath) return;
    try {
      setStatusMsg("正在导出 A-B 选区 WAV 切片（含 15ms 防爆音淡入淡出）...");
      const saved = await exportAudioSliceWav(audioMeta.file_path, loopA, loopB, savePath);
      setStatusMsg(`已导出 A-B 切片：${saved}`);
    } catch (err) {
      setStatusMsg(`导出切片失败: ${String(err)}`);
    }
  };

  const originalStem = useMemo<StemOutput | null>(
    () =>
      audioMeta && stems.length === 0
        ? {
            name: "original",
            label_zh: "原曲",
            file_path: audioMeta.file_path,
            waveform_peaks: audioMeta.waveform_peaks,
            duration_sec: audioMeta.duration_sec,
          }
        : null,
    [audioMeta, stems.length]
  );
  const playableStems = useMemo(() => (stems.length > 0 ? stems : originalStem ? [originalStem] : []), [stems, originalStem]);

  useEffect(() => {
    if (!originalStem) return;
    const init = { original: { muted: false, solo: false, gain: 1, pan: 0 } };
    setMixer(init);
    engineRef.current?.loadStems([originalStem], (t) => setCurrentTime(t));
    engineRef.current?.applyMixer(init);
    setIsPlaying(false);
    setCurrentTime(0);
  }, [originalStem]);

  const handleAddMarker = useCallback((label: string, timeSec: number) => {
    setMarkers((prev) =>
      [...prev, { id: `${Date.now()}_${Math.random()}`, label, time_sec: timeSec }].sort(
        (a, b) => a.time_sec - b.time_sec
      )
    );
  }, []);

  const handleTapTempo = () => {
    const now = performance.now();
    const recent = tapTimesRef.current.filter((t) => now - t < 2500);
    recent.push(now);
    tapTimesRef.current = recent.slice(-6);
    engineRef.current?.playClick(true);
    if (recent.length >= 2) {
      let sum = 0;
      for (let i = 1; i < recent.length; i++) sum += recent[i] - recent[i - 1];
      const avgMs = sum / (recent.length - 1);
      const nextBpm = Math.max(40, Math.min(240, Math.round((60000 / avgMs) * 2) / 2));
      setBpm(nextBpm);
      engineRef.current?.setMetronome(metronomeEnabled, nextBpm);
    }
  };

  const handleTogglePlay = useCallback(async () => {
    if (!engineRef.current || playableStems.length === 0) return;
    if (isPlaying) {
      engineRef.current.pause();
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      await engineRef.current.playWithCountIn(countInEnabled);
    }
  }, [isPlaying, playableStems.length, countInEnabled]);

  const handleOpenAudio = useCallback(async () => {
    const path = await pickAudioFile();
    if (path) await loadAudioByPath(path);
  }, [loadAudioByPath]);

  const handleImportMidiByPath = useCallback(
    async (midiPath: string) => {
      try {
        setStatusMsg("正在解析本地 MIDI 文件...");
        const res = await importMidiFile(midiPath);
        setActiveStemName(res.stem_name);
        setBpm(res.estimated_bpm);
        setTransposeSemitones(0);
        engineRef.current?.setTranspose(0);
        commitNotes(res.notes);
        setMidiAuditionEnabled(true);
        setStudioTab("falling");
        setStatusMsg(`已导入 MIDI「${res.stem_name}」：共 ${res.notes.length} 个音符 (${res.estimated_bpm} BPM)`);
      } catch (err) {
        setStatusMsg(`导入 MIDI 失败: ${String(err)}`);
      }
    },
    [commitNotes]
  );

  const handleImportMidi = useCallback(async () => {
    const path = await pickMidiOpenPath();
    if (path) await handleImportMidiByPath(path);
  }, [handleImportMidiByPath]);

  const handleSaveProject = useCallback(async () => {
    const proj = buildCurrentProject();
    if (!proj) return;
    try {
      const saved = await saveProjectFile(proj);
      const list = await listSavedProjects();
      setRecentProjects(list);
      setStatusMsg(`工程已保存：${saved}`);
    } catch (err) {
      setStatusMsg(`保存工程失败: ${String(err)}`);
    }
  }, [buildCurrentProject]);

  const handleExportBundle = useCallback(async () => {
    const proj = buildCurrentProject();
    if (!proj) return;
    const dir = await pickDirectory();
    if (!dir) return;
    try {
      setStatusMsg("正在导出练习资料包…");
      const outDir = await exportPracticeBundle(proj, keyEst?.label ?? null, dir);
      setStatusMsg(`资料包已导出至：${outDir}`);
    } catch (err) {
      setStatusMsg(`导出资料包失败: ${String(err)}`);
    }
  }, [buildCurrentProject, keyEst]);

  const handleExportMidi = useCallback(async () => {
    if (transposedNotes.length === 0) return;
    const savePath = await pickMidiSavePath(`${activeStemName || "stem"}.mid`);
    if (!savePath) return;
    try {
      const saved = await exportMidiFile(transposedNotes, bpm, savePath);
      setStatusMsg(`已导出 MIDI 文件（含移调 ${transposeSemitones}）：${saved}`);
    } catch (err) {
      setStatusMsg(`导出 MIDI 失败: ${String(err)}`);
    }
  }, [transposedNotes, activeStemName, bpm, transposeSemitones]);

  const handleExportMidiWithChords = useCallback(async () => {
    if (transposedNotes.length === 0 || chords.length === 0) return;
    const savePath = await pickMidiSavePath(`${activeStemName || "arrangement"}_2track.mid`);
    if (!savePath) return;
    try {
      const saved = await exportMidiWithChords(transposedNotes, chords, bpm, savePath);
      setStatusMsg(`已导出双轨 MIDI（轨 1 主旋律 + 轨 2 和弦伴奏）：${saved}`);
    } catch (err) {
      setStatusMsg(`导出双轨 MIDI 失败: ${String(err)}`);
    }
  }, [transposedNotes, chords, activeStemName, bpm]);

  const handleExportMixedWav = useCallback(async () => {
    if (stems.length === 0) return;
    if (stems.some((s) => isDemoBlobPath(s.file_path))) {
      setStatusMsg("当前为内置演示曲，请先导入本地音频并完成分轨后再导出混音 WAV。");
      return;
    }
    const savePath = await pickWavSavePath(`${audioMeta?.file_name || "backing"}_mix.wav`);
    if (!savePath) return;
    const anySolo = Object.values(mixer).some((m) => m.solo);
    const inputs: StemMixInput[] = stems.map((s) => {
      const st = mixer[s.name] ?? { muted: false, solo: false, gain: 1, pan: 0 };
      const enabled = anySolo ? st.solo : !st.muted;
      return { file_path: s.file_path, gain: st.gain, pan: st.pan ?? 0, enabled };
    });
    try {
      setStatusMsg("正在导出混音 WAV…");
      const saved = await exportMixedWav(inputs, savePath, -1.0, audioMeta?.sample_rate);
      setStatusMsg(`已导出标准化混音 WAV：${saved}`);
    } catch (err) {
      setStatusMsg(`导出混音 WAV 失败: ${String(err)}`);
    }
  }, [stems, audioMeta, mixer]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onMacosMenuAction((action) => {
      switch (action) {
        case "open_audio":
          handleOpenAudio();
          break;
        case "import_midi":
          handleImportMidi();
          break;
        case "open_command_palette":
          setShowCommandPalette((v) => !v);
          break;
        case "load_demo_song":
          handleLoadDemoSong();
          break;
        case "open_setlist":
          setShowSetlistModal(true);
          break;
        case "open_batch":
          setShowBatchModal(true);
          break;
        case "save_project":
          handleSaveProject();
          break;
        case "export_midi":
          handleExportMidi();
          break;
        case "export_wav":
          handleExportMixedWav();
          break;
        case "export_bundle":
          handleExportBundle();
          break;
        case "open_leadsheet":
          setShowLeadSheetModal(true);
          break;
        case "open_share_card":
          setShowShareModal(true);
          break;
        case "undo":
          handleUndo();
          break;
        case "redo":
          handleRedo();
          break;
        case "quantize":
          handleQuantize(4);
          break;
        case "toggle_play":
          handleTogglePlay();
          break;
        case "toggle_metronome": {
          const next = !metronomeEnabled;
          setMetronomeEnabled(next);
          engineRef.current?.setMetronome(next, bpm);
          break;
        }
        case "toggle_loop": {
          const next = !loopEnabled;
          setLoopEnabled(next);
          engineRef.current?.setLoop(next, loopA, loopB);
          break;
        }
        case "toggle_stage_mode":
          setStageModeOpen((v) => !v);
          break;
        case "open_models":
          setShowModelModal(true);
          break;
        case "open_settings":
          openSettings("general");
          break;
        default:
          break;
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [
    handleOpenAudio,
    handleImportMidi,
    handleLoadDemoSong,
    handleSaveProject,
    handleExportMidi,
    handleExportMixedWav,
    handleExportBundle,
    handleUndo,
    handleRedo,
    handleQuantize,
    handleTogglePlay,
    metronomeEnabled,
    bpm,
    loopEnabled,
    loopA,
    loopB,
  ]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      const inputType = tag === "INPUT" ? (target as HTMLInputElement).type : "";
      if ((tag === "INPUT" && !["range", "checkbox", "button"].includes(inputType)) || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Escape" && stageModeOpen) {
        e.preventDefault();
        setStageModeOpen(false);
      } else if (e.key.toLowerCase() === "f" && !e.metaKey && !e.ctrlKey && audioMeta) {
        e.preventDefault();
        setStageModeOpen((v) => !v);
      } else if (e.key === "?") {
        e.preventDefault();
        setShowShortcutsModal((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowCommandPalette((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        handleImportMidi();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p" && audioMeta) {
        e.preventDefault();
        setShowLeadSheetModal((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        handleLoadDemoSong();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setShowSetlistModal((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSaveProject();
      } else if (e.code === "Space") {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.key.toLowerCase() === "k" && audioMeta) {
        handleAddMarker("书签", currentTime);
      } else if (e.key === "[") {
        setLoopA(currentTime);
        engineRef.current?.setLoop(loopEnabled, currentTime, loopB);
      } else if (e.key === "]") {
        setLoopB(currentTime);
        engineRef.current?.setLoop(loopEnabled, loopA, currentTime);
      } else if (e.key.toLowerCase() === "l") {
        const next = !loopEnabled;
        setLoopEnabled(next);
        engineRef.current?.setLoop(next, loopA, loopB);
      } else if (e.key.toLowerCase() === "m") {
        const next = !metronomeEnabled;
        setMetronomeEnabled(next);
        engineRef.current?.setMetronome(next, bpm);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    stageModeOpen,
    handleImportMidi,
    handleLoadDemoSong,
    handleUndo,
    handleRedo,
    handleTogglePlay,
    handleSaveProject,
    handleAddMarker,
    audioMeta,
    currentTime,
    loopEnabled,
    loopA,
    loopB,
    metronomeEnabled,
    bpm,
  ]);

  const updateRelayConfig = (next: LlmRelayConfig) => {
    setRelayConfig(next);
    localStorage.setItem("stemscribe_relay_config", JSON.stringify(next));
  };

  const handleDetectStructure = async () => {
    if (!audioMeta) return;
    setDetectingStructure(true);
    setStatusMsg("正在识别曲式段落…");
    try {
      const segs = await detectSongStructureLocal(audioMeta.file_path);
      setStructure(segs);
      setStatusMsg(`曲式分析完成：共识别 ${segs.length} 个段落，双击任意段落即可设为 A-B 循环。`);
    } catch (err) {
      setStatusMsg(`曲式分析失败: ${String(err)}`);
    } finally {
      setDetectingStructure(false);
    }
  };

  const handleDetectChords = async () => {
    if (!audioMeta) return;
    setDetectingChords(true);
    setStatusMsg("正在识别和弦与调性…");
    try {
      const [res, keyRes] = await Promise.all([
        detectChordsLocal(audioMeta.file_path, 2.0),
        detectKeyLocal(audioMeta.file_path),
      ]);
      setChords(res);
      setOriginalChordsBackup(null);
      setActiveReharmStyle(null);
      setKeyEst(keyRes);
      setStatusMsg(`识别完成：${keyRes.label} · 共检测到 ${res.length} 个和弦段落。`);
    } catch (err) {
      setStatusMsg(`和弦识别失败: ${String(err)}`);
    } finally {
      setDetectingChords(false);
    }
  };

  const handleDetectDrums = async () => {
    const drumStem = stems.find((s) => s.name === "drums");
    if (!drumStem) return;
    setDetectingDrums(true);
    setStatusMsg("正在识别鼓组节奏…");
    try {
      const hits = await detectDrumHitsLocal(drumStem.file_path);
      setDrumHits(hits);
      setStatusMsg(`鼓组节奏识别完成：共检测到 ${hits.length} 个底鼓/军鼓/踩镲打击点。`);
    } catch (err) {
      setStatusMsg(`鼓组识别失败: ${String(err)}`);
    } finally {
      setDetectingDrums(false);
    }
  };

  const handleExportDrumMidi = async () => {
    if (drumHits.length === 0) return;
    const savePath = await pickMidiSavePath("drums_pattern.mid");
    if (!savePath) return;
    const drumNotes: MidiNote[] = drumHits.map((h) => ({
      pitch: h.midi_note,
      start_sec: h.time_sec,
      end_sec: h.time_sec + 0.08,
      velocity: h.velocity,
      confidence: 1.0,
    }));
    try {
      const saved = await exportMidiFile(drumNotes, bpm, savePath);
      setStatusMsg(`已导出鼓组 MIDI：${saved}`);
    } catch (err) {
      setStatusMsg(`导出鼓组 MIDI 失败: ${String(err)}`);
    }
  };

  const handleExtractLyrics = async (useWhisper: boolean) => {
    if (!audioMeta) return;
    const vocalStem = stems.find((s) => s.name === "vocals");
    const targetPath = vocalStem ? vocalStem.file_path : audioMeta.file_path;
    setExtractingLyrics(true);
    setStatusMsg("正在提取并对齐人声歌词时间轴...");
    try {
      const lines = await extractLyricsWithRelay(targetPath, useWhisper, relayConfig);
      setLyrics(lines);
      setStatusMsg(`歌词提取完成：共对齐 ${lines.length} 句歌词。`);
    } catch (err) {
      setStatusMsg(`歌词提取失败: ${String(err)}`);
    } finally {
      setExtractingLyrics(false);
    }
  };

  const handleImportLrcByPath = useCallback(async (filePath: string) => {
    try {
      const parsed = await importLrcFile(filePath);
      setLyrics(parsed);
      setStudioTab("lyrics");
      setStatusMsg(`已导入本地 LRC 歌词：共 ${parsed.length} 句，支持实时打点微调与导出 .srt。`);
    } catch (err) {
      setStatusMsg(`导入 LRC 失败: ${String(err)}`);
    }
  }, []);

  const handleImportLrc = useCallback(async () => {
    const filePath = await pickLrcOpenPath();
    if (filePath) await handleImportLrcByPath(filePath);
  }, [handleImportLrcByPath]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onNativeFileDrop((paths) => {
      const audioPath = paths.find((p) => /\.(wav|mp3|flac|m4a|ogg)$/i.test(p));
      if (audioPath) {
        loadAudioByPath(audioPath);
        return;
      }
      const midiPath = paths.find((p) => /\.midi?$/i.test(p));
      if (midiPath) {
        handleImportMidiByPath(midiPath);
        return;
      }
      const lrcPath = paths.find((p) => /\.lrc$/i.test(p));
      if (lrcPath) handleImportLrcByPath(lrcPath);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [loadAudioByPath, handleImportMidiByPath, handleImportLrcByPath]);


  const handleExportLrc = async () => {
    if (lyrics.length === 0) return;
    const savePath = await pickLrcSavePath(`${audioMeta?.file_name || "lyrics"}.lrc`);
    if (!savePath) return;
    try {
      const saved = await exportLrcFile(audioMeta?.file_name || "StemScribe", lyrics, savePath);
      setStatusMsg(`已导出 LRC 歌词文件：${saved}`);
    } catch (err) {
      setStatusMsg(`导出 LRC 失败: ${String(err)}`);
    }
  };

  const handleExportSrt = async () => {
    if (lyrics.length === 0) return;
    const savePath = await pickSrtSavePath(`${audioMeta?.file_name || "subtitles"}.srt`);
    if (!savePath) return;
    try {
      const saved = await exportSrtFile(lyrics, savePath);
      setStatusMsg(`已导出 SRT 视频字幕（兼容剪映 / FCP / B 站）：${saved}`);
    } catch (err) {
      setStatusMsg(`导出 SRT 失败: ${String(err)}`);
    }
  };

  const ensureModelInstalled = async (kind: "demucs" | "basic_pitch"): Promise<boolean> => {
    try {
      const status = await getModelStatus();
      setModelStatus(status);
      const installed = kind === "demucs" ? status.demucs_installed : status.basic_pitch_installed;
      if (installed) return true;
    } catch {
      return true;
    }
    const message =
      kind === "demucs"
        ? "AI 分轨需要下载 HTDemucs 模型（约 166 MB，只需一次，之后完全离线运行）。现在打开模型管理器下载吗？"
        : "扒谱需要下载 Basic Pitch 模型（约 230 KB）。现在下载吗？";
    const yes = await askConfirm(message, "需要下载 AI 模型");
    if (yes) {
      setShowModelModal(true);
    } else {
      setStatusMsg("已取消：缺少本地 AI 模型，可在「设置 → 模型」中随时下载。");
    }
    return false;
  };

  const handleSeparateStems = async () => {
    if (!audioMeta) return;
    if (isDemoBlobPath(audioMeta.file_path)) {
      setStatusMsg("内置演示曲已自带 4 条独立音轨，无需再次分轨。");
      return;
    }
    if (!(await ensureModelInstalled("demucs"))) return;
    setSeparating(true);
    setStatusMsg("正在 AI 4 轨分离（耗时约为歌曲时长的一半）...");
    try {
      const res = await separateStems(audioMeta.file_path);
      setStems(res);
      const initMixer: Record<string, StemMixerState> = {};
      for (const s of res) {
        initMixer[s.name] = { muted: false, solo: false, gain: 1.0, pan: 0 };
      }
      setMixer(initMixer);
      engineRef.current?.loadStems(res, (t) => setCurrentTime(t));
      engineRef.current?.applyMixer(initMixer);
      engineRef.current?.setMasterEq(eq);
      engineRef.current?.setReverb(reverbPreset, reverbWet);
      setStatusMsg("4 轨分离完成");
    } catch (err) {
      setStatusMsg(`分轨失败: ${String(err)}`);
    } finally {
      setSeparating(false);
    }
  };

  const handleSmartAutoPipeline = async () => {
    if (!audioMeta) return;
    if (isDemoBlobPath(audioMeta.file_path)) {
      setStatusMsg("内置演示曲已预置完整 4 轨、和弦、曲式与乐谱；拖入任意本地音频即可体验一键全自动扒带。");
      return;
    }
    if (!(await ensureModelInstalled("demucs"))) return;
    setAutoPipelining(true);
    try {
      setStatusMsg("一键扒带 1/4 · AI 分轨中…");
      const resStems = await separateStems(audioMeta.file_path);
      setStems(resStems);
      const initMixer: Record<string, StemMixerState> = {};
      for (const s of resStems) {
        initMixer[s.name] = { muted: false, solo: false, gain: 1.0, pan: 0 };
      }
      setMixer(initMixer);
      engineRef.current?.loadStems(resStems, (t) => setCurrentTime(t));
      engineRef.current?.applyMixer(initMixer);
      engineRef.current?.setMasterEq(eq);
      engineRef.current?.setReverb(reverbPreset, reverbWet);

      setStatusMsg("一键扒带 2/4 · 识别和弦、调性与段落…");
      const [resChords, resKey, resStruct] = await Promise.all([
        detectChordsLocal(audioMeta.file_path, 2.0),
        detectKeyLocal(audioMeta.file_path),
        detectSongStructureLocal(audioMeta.file_path),
      ]);
      setChords(resChords);
      setOriginalChordsBackup(null);
      setActiveReharmStyle(null);
      setKeyEst(resKey);
      setStructure(resStruct);

      const drumStem = resStems.find((s) => s.name === "drums");
      if (drumStem) {
        setStatusMsg("一键扒带 3/4 · 识别鼓组节奏…");
        const hits = await detectDrumHitsLocal(drumStem.file_path);
        setDrumHits(hits);
      }

      const stemMean = (s: StemOutput) =>
        s.waveform_peaks.length > 0
          ? s.waveform_peaks.reduce((a, b) => a + b, 0) / s.waveform_peaks.length
          : 0;
      const vocalsStem = resStems.find((s) => s.name === "vocals");
      const vocalsMean = vocalsStem ? stemMean(vocalsStem) : 0;
      const loudestMean = resStems.reduce((m, s) => Math.max(m, stemMean(s)), 0);
      const vocalsWeak = !vocalsStem || vocalsMean < 0.05 || vocalsMean < loudestMean * 0.15;
      const melodyStem = vocalsWeak
        ? resStems.find((s) => s.name === "other") ?? resStems[0]
        : vocalsStem;
      if (melodyStem && (await ensureModelInstalled("basic_pitch"))) {
        setStatusMsg(
          vocalsWeak
            ? `一键扒带 4/4 · 未检测到人声，改为转录「${melodyStem.label_zh}」旋律…`
            : `一键扒带 4/4 · 转录「${melodyStem.label_zh}」…`
        );
        const tr = await transcribeStemToMidi(melodyStem.file_path, melodyStem.name);
        setActiveStemName(melodyStem.label_zh);
        setBpm(tr.estimated_bpm);
        commitNotes(tr.notes);
      }

      setStatusMsg("扒带完成");
    } catch (err) {
      setStatusMsg(`自动扒带中断: ${String(err)}`);
    } finally {
      setAutoPipelining(false);
    }
  };

  const handleMixerChange = (stemName: string, patch: Partial<StemMixerState>) => {
    setMixer((prev) => {
      const next = {
        ...prev,
        [stemName]: {
          ...(prev[stemName] ?? { muted: false, solo: false, gain: 1, pan: 0 }),
          ...patch,
        },
      };
      engineRef.current?.applyMixer(next);
      return next;
    });
  };

  const handleTranscribe = async (stem: StemOutput) => {
    if (!(await ensureModelInstalled("basic_pitch"))) return;
    setTranscribingStem(stem.name);
    setStatusMsg(`正在使用 Basic Pitch 本地转录「${stem.label_zh}」...`);
    try {
      const res = await transcribeStemToMidi(stem.file_path, stem.name);
      setActiveStemName(stem.label_zh);
      setBpm(res.estimated_bpm);
      engineRef.current?.setMetronome(metronomeEnabled, res.estimated_bpm);
      commitNotes(res.notes);
      setStatusMsg(`转谱完成：识别到 ${res.notes.length} 个音符 (BPM ≈ ${res.estimated_bpm})`);
    } catch (err) {
      setStatusMsg(`转谱失败: ${String(err)}`);
    } finally {
      setTranscribingStem(null);
    }
  };

  const handleExportMusicXml = async () => {
    if (transposedNotes.length === 0) return;
    const savePath = await pickMusicXmlSavePath(`${activeStemName || "score"}.musicxml`);
    if (!savePath) return;
    try {
      const saved = await exportMusicXmlFile(
        audioMeta?.file_name || "StemScribe Score",
        transposedNotes,
        chords,
        bpm,
        savePath
      );
      setStatusMsg(`已导出 MusicXML 4.0 乐谱：${saved}`);
    } catch (err) {
      setStatusMsg(`导出 MusicXML 失败: ${String(err)}`);
    }
  };

  const handleAnalyzeArrangement = async (useLoopSlice: boolean) => {
    if (!audioMeta) return;
    setLlmLoading(true);
    setStatusMsg("正在压缩音频并通过第三方中转平台分析编曲...");
    try {
      const res = await analyzeArrangementWithLlm(
        audioMeta.file_path,
        bpm,
        useLoopSlice ? loopA : null,
        useLoopSlice ? loopB : null,
        relayConfig
      );
      setAnalysis(res);
      setStatusMsg("多模态编曲拆解完成。");
    } catch (err) {
      setStatusMsg(`大模型分析失败: ${String(err)}`);
    } finally {
      setLlmLoading(false);
    }
  };

  const handleRefineMidi = async (
    instrument: string,
    prompt: string,
    useLoopSlice: boolean
  ) => {
    if (!audioMeta || notes.length === 0) return;
    setLlmLoading(true);
    setStatusMsg("正在结合音频与初版 MIDI 进行乐理校对与智能修谱...");
    try {
      const res = await refineMidiWithLlm(
        audioMeta.file_path,
        transposedNotes,
        instrument,
        prompt,
        useLoopSlice ? loopA : null,
        useLoopSlice ? loopB : null,
        relayConfig
      );
      setTransposeSemitones(0);
      engineRef.current?.setTranspose(0);
      commitNotes(res.cleaned_notes);
      setRefineSummary(res.summary);
      setFingeringTips(res.guitar_fingering_tips);
      setStatusMsg("智能修谱完成，钢琴卷帘与乐谱视图已更新（支持 Cmd+Z 撤销）。");
    } catch (err) {
      setStatusMsg(`智能修谱失败: ${String(err)}`);
    } finally {
      setLlmLoading(false);
    }
  };


  const paletteCommands: PaletteCommand[] = [
    { id: "demo", category: "入门", label: "体验内置 4 轨演示曲（星海漫游）", shortcut: "Cmd+D", run: handleLoadDemoSong },
    { id: "open_audio", category: "文件", label: "导入本地音频文件...", shortcut: "Cmd+O", run: handleOpenAudio },
    { id: "import_midi", category: "文件", label: "导入本地 MIDI 乐谱 (.mid)...", shortcut: "Cmd+I", run: handleImportMidi },
    { id: "import_lrc", category: "文件", label: "导入本地 LRC 歌词时间轴 (.lrc)...", run: handleImportLrc },
    { id: "export_srt", category: "导出", label: "导出翻唱视频标准字幕 (.srt)", disabled: lyrics.length === 0, run: handleExportSrt },
    { id: "export_practice_csv", category: "导出", label: "导出练琴成长历史日志 (.csv)", disabled: practiceRecords.length === 0, run: handleExportPracticeCsv },
    { id: "auto_pipe", category: "AI 引擎", label: "一键全自动扒带（4轨+和弦+曲式+鼓组+转谱）", disabled: !audioMeta, run: handleSmartAutoPipeline },
    { id: "stage", category: "舞台", label: "进入 / 退出全屏演出提词器模式", shortcut: "F", disabled: !audioMeta, run: () => setStageModeOpen((v) => !v) },
    { id: "setlist", category: "舞台", label: "打开演出歌单 / Setlist 管理", shortcut: "Cmd+L", run: () => setShowSetlistModal(true) },
    { id: "leadsheet", category: "导出", label: "A4 吉他弹唱和弦谱排版 / 打印", shortcut: "Cmd+P", disabled: !audioMeta, run: () => setShowLeadSheetModal(true) },
    { id: "share", category: "导出", label: "生成小红书 / B 站高清分享卡片", disabled: !audioMeta, run: () => setShowShareModal(true) },
    { id: "bundle", category: "导出", label: "一键导出完整扒带资料包", shortcut: "Cmd+Shift+E", disabled: !audioMeta, run: handleExportBundle },
    { id: "midi2", category: "导出", label: "导出双轨主旋律+和弦 MIDI (.mid)", disabled: transposedNotes.length === 0 || chords.length === 0, run: handleExportMidiWithChords },
    { id: "tab_falling", category: "视图", label: "切换到：Synthesia 瀑布流跟弹视图", run: () => setStudioTab("falling") },
    { id: "tab_inst", category: "视图", label: "切换到：实时交互琴键与吉他指板", run: () => setStudioTab("instrument") },
    { id: "tab_coach", category: "视图", label: "切换到：AI 练琴教练与实时调音打分", run: () => setStudioTab("coach") },
    { id: "tab_cover", category: "视图", label: "切换到：伴奏叠录翻唱棚与合轨导出", run: () => setStudioTab("cover") },
    { id: "tab_score", category: "视图", label: "切换到：VexFlow 五线谱与钢琴卷帘", run: () => setStudioTab("score") },
    { id: "tab_drums", category: "视图", label: "切换到：鼓组 16 步进视图", run: () => setStudioTab("drums") },
    { id: "tab_lyrics", category: "视图", label: "切换到：人声歌词时间轴", run: () => setStudioTab("lyrics") },
    { id: "reharm_jazz", category: "和弦", label: "一键重配和弦：爵士 / City Pop 色彩", disabled: chords.length === 0, run: () => handleReharmonize("jazz_neosoul") },
    { id: "reharm_folk", category: "和弦", label: "一键重配和弦：民谣指弹清新", disabled: chords.length === 0, run: () => handleReharmonize("folk_open") },
    { id: "usb_midi", category: "硬件", label: "连接外接 USB-MIDI 键盘 / 电钢琴", run: handleConnectMidi },
    { id: "theme", category: "外观", label: `切换视觉主题（当前：${THEME_LABELS[theme]}）`, run: handleCycleTheme },
    { id: "focus", category: "外观", label: aiPanelOpen ? "隐藏右侧 AI 助手面板" : "显示右侧 AI 助手面板", run: () => setAiPanelOpen((v) => !v) },
    { id: "settings", category: "设置", label: "打开设置（主题 / AI 服务 / 模型 / MIDI）", shortcut: "Cmd+,", run: () => openSettings("general") },
    { id: "tab_chords", category: "视图", label: "切换到：和弦编辑与风格重配", run: () => setStudioTab("chords") },
    { id: "tab_mixer", category: "视图", label: "切换到：混音台（EQ / 混响 / 练习场景）", run: () => setStudioTab("mixer") },
    { id: "models", category: "设置", label: "打开本地 CoreML / ONNX 模型管理器", run: () => setShowModelModal(true) },
    { id: "diagnostics", category: "设置", label: "打开系统诊断与环境自检（一键复制报告）", run: () => setShowDiagnosticsModal(true) },
    { id: "projects", category: "文件", label: "打开本地扒带工程库（搜索 / 重命名 / 删除）", run: () => setShowProjectLibrary(true) },
    { id: "batch", category: "工具", label: "打开多曲目批量分轨队列", shortcut: "Cmd+B", run: () => setShowBatchModal(true) },
  ];

  const openEditor = (tab: StudioTab) => {
    setStudioTab(tab);
    setEditorOpen(true);
  };

  const startEditorResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorHeight;
    const move = (ev: MouseEvent) => {
      const maxH = Math.max(EDITOR_MIN_H, window.innerHeight - 280);
      setEditorHeight(Math.max(EDITOR_MIN_H, Math.min(maxH, startH + (startY - ev.clientY))));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const arrangementTracks: ArrangementTrack[] = playableStems.map((st) => ({
    id: st.name,
    name: st.label_zh,
    subtitle: st.name === "original" ? "未分轨 · 完整混音" : st.name,
    color: STEM_COLORS[st.name] ?? "#38bdf8",
    peaks: st.waveform_peaks,
    isOriginal: st.name === "original",
  }));

  const activeTabLabel = EDITOR_TAB_GROUPS.flatMap((g) => g.tabs).find(
    (t) => t.id === studioTab
  )?.label;

  const pipelineStep = autoPipelining ? statusMsg.match(/(\d)\/4/)?.[1] : null;
  const busyLabel = separating
    ? "AI 分轨中"
    : autoPipelining
      ? pipelineStep
        ? `扒带 ${pipelineStep}/4`
        : "一键扒带中"
      : transcribingStem
        ? "转谱中"
        : detectingChords || detectingStructure || detectingDrums
          ? "分析中"
          : extractingLyrics
            ? "提取歌词中"
            : loadingAudio
              ? "分析音频中"
              : llmLoading
                ? "AI 分析中"
                : null;

  const editorTabCounts: Partial<Record<StudioTab, number>> = {
    score: transposedNotes.length,
    chords: chords.length,
    drums: drumHits.length,
    lyrics: lyrics.length,
    coach: practiceRecords.length,
    cover: archivedTakes.length,
  };

  return (
    <div className="app-shell" data-theme={theme}>
      <header className="topbar" data-tauri-drag-region>
        <div className="topbar-left" data-tauri-drag-region>
          <span className="brand" data-tauri-drag-region>StemScribe</span>
          <span className="song-title" data-tauri-drag-region title={audioMeta?.file_name}>
            {audioMeta ? audioMeta.file_name : notes.length > 0 ? activeStemName || "MIDI 乐谱" : "未打开歌曲"}
          </span>
          {busyLabel && (
            <span className="task-pill">
              <Loader2 size={11} className="spin" />
              {busyLabel}
            </span>
          )}
        </div>

        <TransportBar
          canPlay={playableStems.length > 0}
          isPlaying={isPlaying}
          currentTime={currentTime}
          durationSec={audioMeta?.duration_sec ?? 0}
          bpm={bpm}
          keyLabel={keyEst?.label ?? null}
          playbackRate={playbackRate}
          transposeSemitones={transposeSemitones}
          loopEnabled={loopEnabled}
          progressiveRampEnabled={progressiveRampEnabled}
          metronomeEnabled={metronomeEnabled}
          countInEnabled={countInEnabled}
          onTogglePlay={handleTogglePlay}
          onStop={() => {
            engineRef.current?.pause();
            setIsPlaying(false);
            engineRef.current?.seek(0);
          }}
          onRewind={() => engineRef.current?.seek(0)}
          onToggleLoop={() => {
            const next = !loopEnabled;
            setLoopEnabled(next);
            engineRef.current?.setLoop(next, loopA, loopB);
          }}
          onToggleProgressiveRamp={() => setProgressiveRampEnabled((v) => !v)}
          onToggleMetronome={() => {
            const next = !metronomeEnabled;
            setMetronomeEnabled(next);
            engineRef.current?.setMetronome(next, bpm);
          }}
          onToggleCountIn={() => setCountInEnabled((v) => !v)}
          onBpmChange={(nextBpm) => {
            setBpm(nextBpm);
            engineRef.current?.setMetronome(metronomeEnabled, nextBpm);
          }}
          onTapTempo={handleTapTempo}
          onRateChange={(r) => {
            setPlaybackRate(r);
            engineRef.current?.setPlaybackRate(r);
          }}
          onTransposeChange={(semi) => {
            setTransposeSemitones(semi);
            engineRef.current?.setTranspose(semi);
          }}
        />

        <div className="topbar-right">
          <button className="btn" onClick={handleOpenAudio} title="导入音频文件 (⌘O)">
            <FolderOpen size={14} /> 导入
          </button>
          <button
            className="btn btn-primary"
            disabled={!audioMeta || autoPipelining || separating}
            onClick={handleSmartAutoPipeline}
            title="自动完成：AI 分 4 轨 → 识别和弦/调性/段落 → 鼓组 → 主旋律扒谱"
          >
            <Wand2 size={14} /> {autoPipelining ? "扒带中..." : "一键扒带"}
          </button>
          <div className="toolbar-divider" />
          <button
            className={`btn btn-icon ${aiPanelOpen ? "btn-active" : ""}`}
            onClick={() => setAiPanelOpen((v) => !v)}
            title="AI 助手（编曲分析 / 智能修谱）"
          >
            <Bot size={16} />
          </button>
          <div className="menu-anchor">
            <button
              className={`btn btn-icon ${showProjectsMenu ? "btn-active" : ""}`}
              onClick={() => setShowProjectsMenu((v) => !v)}
              title="更多工具：工程库、歌单、导出、模型管理等"
            >
              <MoreHorizontal size={16} />
            </button>
            {showProjectsMenu && (
              <>
                <div className="menu-backdrop" onClick={() => setShowProjectsMenu(false)} />
                <div className="menu-pop">
                  {(
                    [
                      { icon: <Save size={14} />, label: "保存工程", hint: "⌘S", disabled: !audioMeta, onClick: handleSaveProject },
                      { icon: <FolderOpen size={14} />, label: `工程库 (${recentProjects.length})`, hint: "", onClick: () => setShowProjectLibrary(true) },
                      { icon: <Music size={14} />, label: "导入 MIDI 文件", hint: "⌘I", onClick: handleImportMidi },
                      null,
                      { icon: <Layers size={14} />, label: separating ? "AI 分轨中..." : "仅 AI 分轨（不扒谱）", hint: "", disabled: !audioMeta || separating || autoPipelining || stems.length > 0, onClick: handleSeparateStems },
                      { icon: <ListOrdered size={14} />, label: `演出歌单 (${setlists.length})`, hint: "⌘L", onClick: () => setShowSetlistModal(true) },
                      { icon: <ListMusic size={14} />, label: "批量处理", hint: "⌘B", onClick: () => setShowBatchModal(true) },
                      null,
                      { icon: <FileText size={14} />, label: "弹唱谱排版 / 打印", hint: "⌘P", disabled: !audioMeta, onClick: () => setShowLeadSheetModal(true) },
                      { icon: <Maximize2 size={14} />, label: "演出提词器", hint: "F", disabled: !audioMeta, onClick: () => setStageModeOpen(true) },
                      { icon: <Share2 size={14} />, label: "导出分享图", hint: "", disabled: !audioMeta, onClick: () => setShowShareModal(true) },
                      { icon: <Package size={14} />, label: "导出练习资料包", hint: "", disabled: !audioMeta, onClick: handleExportBundle },
                      { icon: <Download size={14} />, label: "导出混音 WAV", hint: "", disabled: stems.length === 0, onClick: handleExportMixedWav },
                      { icon: <Download size={14} />, label: "导出循环区 WAV", hint: "", disabled: !audioMeta || loopB <= loopA + 0.05, onClick: handleExportLoopSlice },
                      null,
                      { icon: <Search size={14} />, label: "命令面板", hint: "⌘K", onClick: () => setShowCommandPalette(true) },
                      { icon: <HelpCircle size={14} />, label: "快捷键", hint: "?", onClick: () => setShowShortcutsModal(true) },
                    ] as Array<{ icon: React.ReactNode; label: string; hint: string; disabled?: boolean; onClick: () => void } | null>
                  ).map((item, idx) =>
                    item === null ? (
                      <div key={`sep_${idx}`} className="menu-sep" />
                    ) : (
                      <button
                        key={item.label}
                        className="menu-item"
                        disabled={item.disabled}
                        onClick={() => {
                          setShowProjectsMenu(false);
                          item.onClick();
                        }}
                      >
                        {item.icon}
                        <span className="menu-label">{item.label}</span>
                        {item.hint && <span className="menu-hint">{item.hint}</span>}
                      </button>
                    )
                  )}
                  {recentProjects.length > 0 && (
                    <>
                      <div className="menu-sep" />
                      <div className="menu-heading">最近工程</div>
                      {recentProjects.slice(0, 5).map((p) => (
                        <button key={p.id} className="menu-item" onClick={() => handleLoadProject(p.id)}>
                          <History size={14} />
                          <span className="menu-label">{p.name}</span>
                          <span className="menu-hint">{p.note_count} 音符</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          <button className="btn btn-icon" onClick={() => openSettings("general")} title="设置 (⌘,)">
            <Settings size={16} />
          </button>
        </div>
      </header>

      <main className={`workspace ${aiPanelOpen ? "with-inspector" : ""}`}>
        <section className="center-pane">
          <Arrangement
            durationSec={audioMeta?.duration_sec ?? 0}
            currentTime={currentTime}
            isPlaying={isPlaying}
            bpm={bpm}
            tracks={arrangementTracks}
            mixer={mixer}
            transcribingStem={transcribingStem}
            separating={separating}
            structure={structure}
            detectingStructure={detectingStructure}
            chords={chords}
            detectingChords={detectingChords}
            transposeSemitones={transposeSemitones}
            useFlats={useFlats}
            markers={markers}
            notes={transposedNotes}
            midiLabel={activeStemName}
            loopEnabled={loopEnabled}
            loopA={loopA}
            loopB={loopB}
            onSeek={(sec) => engineRef.current?.seek(sec)}
            onSetLoop={(a, b) => {
              setLoopA(a);
              setLoopB(b);
              setLoopEnabled(true);
              engineRef.current?.setLoop(true, a, b);
            }}
            onMixerChange={handleMixerChange}
            onTranscribeTrack={(id) => {
              const stem = stems.find((st) => st.name === id);
              if (stem) handleTranscribe(stem);
            }}
            onSeparate={handleSeparateStems}
            onDetectStructure={handleDetectStructure}
            onConvertStructureToMarkers={() => {
              const converted = structure.map((sg) => ({
                id: `mk_sec_${sg.id}_${Math.round(sg.start_sec * 10)}`,
                time_sec: sg.start_sec,
                label: sg.label,
              }));
              setMarkers(converted);
              setStatusMsg(`已将 ${converted.length} 个段落转为书签。`);
            }}
            onDetectChords={handleDetectChords}
            onOpenChordEditor={() => openEditor("chords")}
            onAddMarker={() => {
              const seg = structure.find((sg) => currentTime >= sg.start_sec && currentTime < sg.end_sec);
              handleAddMarker(seg?.label ?? `书签 ${markers.length + 1}`, currentTime);
            }}
            onDeleteMarker={(id) => setMarkers((prev) => prev.filter((m) => m.id !== id))}
            onOpenMidiEditor={() => openEditor("score")}
            emptyState={
              <div className="empty-card">
                <div className="empty-icon">
                  <Music size={26} />
                </div>
                <h2>导入一首歌，开始扒带</h2>
                <p>
                  支持 MP3 / WAV / FLAC / M4A，可直接从访达拖进窗口。AI 会把歌曲拆成人声、鼓、贝斯、伴奏 4 轨，并自动识别和弦、段落和旋律。
                </p>
                <div className="empty-actions">
                  <button className="btn btn-primary btn-lg" onClick={handleOpenAudio}>
                    <FolderOpen size={16} /> 导入音频
                  </button>
                  <button className="btn btn-lg" onClick={handleLoadDemoSong}>
                    <Sparkles size={16} /> 试试演示曲
                  </button>
                  <button className="btn btn-lg" onClick={handleImportMidi}>
                    <Music size={16} /> 导入 MIDI
                  </button>
                </div>
                <ol className="empty-steps">
                  <li>
                    <b>1</b>导入歌曲
                  </li>
                  <li>
                    <b>2</b>点「一键扒带」
                  </li>
                  <li>
                    <b>3</b>在下方看谱、编辑、跟弹
                  </li>
                </ol>
              </div>
            }
          />

          {(audioMeta || notes.length > 0) && (
          <div className={`editor ${editorOpen ? "" : "collapsed"}`} style={editorOpen ? { height: editorHeight } : undefined}>
            {editorOpen && <div className="editor-resize" onMouseDown={startEditorResize} title="拖动调整高度" />}
            <div className="editor-tabs">
              {EDITOR_TAB_GROUPS.map((group) => (
                <div key={group.label} className="editor-tab-group">
                  <span className="editor-group-label">{group.label}</span>
                  {group.tabs.map((t) => (
                    <button
                      key={t.id}
                      className={`editor-tab ${editorOpen && studioTab === t.id ? "on" : ""}`}
                      onClick={() => openEditor(t.id)}
                    >
                      {t.label}
                      {editorTabCounts[t.id] ? <span className="editor-count">{editorTabCounts[t.id]}</span> : null}
                    </button>
                  ))}
                </div>
              ))}
              <button
                className="icon-btn editor-toggle"
                onClick={() => setEditorOpen((v) => !v)}
                title={editorOpen ? "收起编辑器" : "展开编辑器"}
              >
                {editorOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
              </button>
            </div>
            {editorOpen && (
              <div className="editor-body">
            <ErrorBoundary compact resetKey={studioTab} label={activeTabLabel}>
          {studioTab === "falling" && (
            <FallingNotesView
              notes={transposedNotes}
              currentTime={currentTime}
              bpm={bpm}
              pressedHardwareNotes={pressedHardwareNotes}
              scalePitchClasses={transposedScale}
              useFlats={useFlats}
              onAuditionNote={(midi) => engineRef.current?.playSingleNote(midi)}
            />
          )}

          {studioTab === "instrument" && (
            <LiveInstrumentView
              notes={transposedNotes}
              chords={chords}
              currentTime={currentTime}
              transposeSemitones={transposeSemitones}
              useFlats={useFlats}
              capoFret={capoFret}
              scalePitchClasses={transposedScale}
              midiDevices={midiDevices}
              pressedHardwareNotes={pressedHardwareNotes}
              onConnectMidi={handleConnectMidi}
              onCapoChange={setCapoFret}
              onAuditionNote={(midi) => engineRef.current?.playSingleNote(midi)}
            />
          )}

          {studioTab === "coach" && (
            <PracticeCoachView
              songName={audioMeta?.file_name ?? ""}
              isPlaying={isPlaying}
              currentTime={currentTime}
              playbackRate={playbackRate}
              transposeSemitones={transposeSemitones}
              useFlats={useFlats}
              notes={transposedNotes}
              chords={chords}
              records={practiceRecords}
              pressedHardwareNotes={pressedHardwareNotes}
              midiDeviceCount={midiDevices.length}
              onConnectMidi={handleConnectMidi}
              onSaveRecord={handleSavePracticeRecord}
              onDeleteRecord={handleDeletePracticeRecord}
              onExportRecordsCsv={handleExportPracticeCsv}
              onOpenShareCard={(summary) => {
                setShareScoreSummary(summary);
                setShowShareModal(true);
              }}
            />
          )}

          {studioTab === "cover" && (
            <CoverStudioView
              songName={audioMeta?.file_name ?? ""}
              hasStems={stems.length > 0}
              isPlaying={isPlaying}
              playbackRate={playbackRate}
              archivedTakes={archivedTakes}
              onStartBackingPlayback={() => {
                if (!isPlaying && stems.length > 0) handleTogglePlay();
              }}
              onStopBackingPlayback={() => {
                if (isPlaying) handleTogglePlay();
              }}
              onArchiveTake={handleArchiveTake}
              onDeleteArchivedTake={async (fileName) => {
                try {
                  const updated = await deleteRecordedTake(fileName);
                  setArchivedTakes(updated);
                  setStatusMsg(`已从磁盘删除归档 Take：${fileName}`);
                } catch (err) {
                  setStatusMsg(`删除归档失败: ${String(err)}`);
                }
              }}
              onBounceCoverWav={handleBounceCoverWav}
            />
          )}

          {studioTab === "score" && (
            <ScoreViewer
              stemName={activeStemName}
              bpm={bpm}
              currentTime={currentTime}
              notes={transposedNotes}
              hasChords={chords.length > 0}
              keyTonic={keyEst?.tonic}
              scalePitchClasses={transposedScale}
              midiAuditionEnabled={midiAuditionEnabled}
              synthTimbre={synthTimbre}
              canUndo={undoStack.length > 0}
              canRedo={redoStack.length > 0}
              onToggleMidiAudition={() => setMidiAuditionEnabled((v) => !v)}
              onTimbreChange={setSynthTimbre}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onQuantize={handleQuantize}
              onNotesChange={(edited) => {
                setTransposeSemitones(0);
                engineRef.current?.setTranspose(0);
                commitNotes(edited);
              }}
              onExportMidi={handleExportMidi}
              onExportMidiWithChords={handleExportMidiWithChords}
              onExportMusicXml={handleExportMusicXml}
            />
          )}

          {studioTab === "drums" && (
            <DrumPatternView
              hits={drumHits}
              bpm={bpm}
              currentTime={currentTime}
              durationSec={audioMeta?.duration_sec ?? 0}
              hasDrumStem={stems.some((s) => s.name === "drums")}
              loading={detectingDrums}
              onDetectDrums={handleDetectDrums}
              onChangeHits={setDrumHits}
              onExportDrumMidi={handleExportDrumMidi}
            />
          )}

          {studioTab === "lyrics" && (
            <LyricsTimeline
              lyrics={lyrics}
              currentTime={currentTime}
              hasAudio={Boolean(audioMeta)}
              loading={extractingLyrics}
              onExtractLyrics={handleExtractLyrics}
              onChangeLyrics={setLyrics}
              onSeek={(sec) => engineRef.current?.seek(sec)}
              onImportLrc={handleImportLrc}
              onExportLrc={handleExportLrc}
              onExportSrt={handleExportSrt}
            />
          )}
          {studioTab === "chords" && (
            <div className="chord-editor">
              <div className="reharm-row">
                <span className="reharm-title">风格重配</span>
                {REHARM_STYLES.map((st) => (
                  <button
                    key={st.id}
                    className={`btn btn-sm ${activeReharmStyle === st.id ? "btn-active" : ""}`}
                    disabled={chords.length === 0}
                    onClick={() => handleReharmonize(st.id)}
                  >
                    {st.label}
                  </button>
                ))}
                {originalChordsBackup && (
                  <button className="btn btn-sm" onClick={handleRestoreOriginalChords}>
                    还原原版
                  </button>
                )}
              </div>
            <ChordTrack
              chords={chords}
              durationSec={audioMeta?.duration_sec ?? 0}
              currentTime={currentTime}
              transposeSemitones={transposeSemitones}
              useFlats={useFlats}
              keyTonic={keyEst?.tonic}
              keyMode={keyEst?.mode}
              detecting={detectingChords}
              onDetectChords={handleDetectChords}
              onChordsChange={setChords}
              onSeek={(sec) => engineRef.current?.seek(sec)}
              onAuditionChord={(sym) => {
                const pitches = chordToMidiVoicing(sym, 4);
                pitches.forEach((p, idx) => {
                  window.setTimeout(() => {
                    engineRef.current?.playSingleNote(p, 0.75, 86);
                  }, idx * 35);
                });
              }}
            />
            </div>
          )}

          {studioTab === "mixer" && (
            <MixerPanel
              hasStems={stems.length > 0}
              isPlaying={isPlaying}
              eq={eq}
              reverbPreset={reverbPreset}
              reverbWet={reverbWet}
              getMasterPeak={() => engineRef.current?.getMasterPeakLevel() ?? 0}
              getFrequencyBins={(out) => engineRef.current?.getFrequencyBins(out) ?? false}
              onApplyMixPreset={handleApplyMixPreset}
              onEqChange={(nextEq) => {
                setEq(nextEq);
                engineRef.current?.setMasterEq(nextEq);
              }}
              onReverbChange={handleReverbChange}
            />
          )}
            </ErrorBoundary>
              </div>
            )}
          </div>
          )}
        </section>

        {aiPanelOpen && (
          <aside className="inspector">
            <div className="inspector-header">
              <span>
                <Bot size={14} /> AI 助手
              </span>
              <button className="icon-btn" onClick={() => setAiPanelOpen(false)} title="关闭">
                <ChevronDown size={14} style={{ transform: "rotate(-90deg)" }} />
              </button>
            </div>
            <div className="inspector-body">
              <ErrorBoundary compact label="AI 助手">
              <AiAssistantPanel
                configured={Boolean(relayConfig.base_url.trim() && relayConfig.api_key.trim())}
                onOpenSettings={() => openSettings("ai")}
                hasAudio={Boolean(audioMeta)}
                loopEnabled={loopEnabled}
                loopA={loopA}
                loopB={loopB}
                notes={transposedNotes}
                loading={llmLoading}
                analysis={analysis}
                refineSummary={refineSummary}
                fingeringTips={fingeringTips}
                onAnalyzeArrangement={handleAnalyzeArrangement}
                onRefineMidi={handleRefineMidi}
              />
              </ErrorBoundary>
            </div>
          </aside>
        )}
      </main>

      <footer className="statusbar">
        <span className="statusbar-msg" title={statusMsg}>
          {busyLabel && <Loader2 size={11} className="spin" />}
          {statusMsg}
        </span>
        <span className="statusbar-meta">ONNX Runtime · v{__APP_VERSION__}</span>
      </footer>

      <SettingsModal
        open={showSettings}
        initialSection={settingsSection}
        appVersion={__APP_VERSION__}
        theme={theme}
        themeLabels={THEME_LABELS}
        relayConfig={relayConfig}
        modelStatus={modelStatus}
        midiDevices={midiDevices}
        onClose={() => setShowSettings(false)}
        onThemeChange={applyTheme}
        onRelayConfigChange={updateRelayConfig}
        onTestRelay={() => testLlmRelayConnection(relayConfig)}
        onOpenModelManager={() => setShowModelModal(true)}
        onConnectMidi={handleConnectMidi}
        onOpenDiagnostics={() => setShowDiagnosticsModal(true)}
        onOpenShortcuts={() => setShowShortcutsModal(true)}
      />

      <StageModeOverlay
        open={stageModeOpen}
        songTitle={audioMeta?.file_name ?? ""}
        isPlaying={isPlaying}
        currentTime={currentTime}
        durationSec={audioMeta?.duration_sec ?? 0}
        bpm={bpm}
        playbackRate={playbackRate}
        transposeSemitones={transposeSemitones}
        useFlats={useFlats}
        capoFret={capoFret}
        loopEnabled={loopEnabled}
        chords={chords}
        lyrics={lyrics}
        structure={structure}
        activeSetlist={activeSetlist}
        activeSetlistIndex={activeSetlistIndex}
        onClose={() => setStageModeOpen(false)}
        onTogglePlay={handleTogglePlay}
        onRateChange={(r) => {
          setPlaybackRate(r);
          engineRef.current?.setPlaybackRate(r);
        }}
        onCapoChange={setCapoFret}
        onToggleLoop={() => {
          const next = !loopEnabled;
          setLoopEnabled(next);
          engineRef.current?.setLoop(next, loopA, loopB);
        }}
        onJumpSetlistSong={(nextIdx) => {
          if (activeSetlist) handleStartSetlistSong(activeSetlist, nextIdx, true);
        }}
      />

      <LeadSheetModal
        open={showLeadSheetModal}
        songName={audioMeta?.file_name ?? ""}
        bpm={bpm}
        keyEst={keyEst}
        transposeSemitones={transposeSemitones}
        useFlats={useFlats}
        capoFret={capoFret}
        chords={chords}
        lyrics={lyrics}
        structure={structure}
        onClose={() => setShowLeadSheetModal(false)}
        onExportHtml={handleExportLeadSheetHtml}
      />

      <SetlistModal
        open={showSetlistModal}
        setlists={setlists}
        activeSetlistId={activeSetlistId}
        canAddCurrent={Boolean(audioMeta)}
        currentSongName={audioMeta?.file_name ?? ""}
        onClose={() => setShowSetlistModal(false)}
        onSaveSetlist={handleSaveSetlist}
        onDeleteSetlist={handleDeleteSetlist}
        onAddCurrentSongToSetlist={handleAddCurrentSongToSetlist}
        onStartSetlistSong={handleStartSetlistSong}
      />

      <ShareCardModal
        open={showShareModal}
        songName={audioMeta?.file_name ?? ""}
        bpm={bpm}
        keyEst={keyEst}
        transposeSemitones={transposeSemitones}
        useFlats={useFlats}
        capoFret={capoFret}
        chords={chords}
        structure={structure}
        scoreSummary={shareScoreSummary}
        onClose={() => setShowShareModal(false)}
      />

      <DiagnosticsModal
        open={showDiagnosticsModal}
        relayConfig={relayConfig}
        onClose={() => setShowDiagnosticsModal(false)}
      />

      <ProjectLibraryModal
        open={showProjectLibrary}
        projects={recentProjects}
        onClose={() => setShowProjectLibrary(false)}
        onOpenProject={(id) => handleLoadProject(id)}
        onRenameProject={handleRenameProject}
        onDeleteProject={handleDeleteProject}
      />

      <ModelManagerModal
        open={showModelModal}
        modelsDir={modelStatus?.models_dir ?? "~/Library/Application Support/StemScribe/models"}
        onClose={() => setShowModelModal(false)}
        onModelsUpdated={refreshModelStatus}
      />

      <BatchQueueModal open={showBatchModal} onClose={() => setShowBatchModal(false)} />

      <CommandPaletteModal open={showCommandPalette} commands={paletteCommands} onClose={() => setShowCommandPalette(false)} />

      <ShortcutsModal open={showShortcutsModal} onClose={() => setShowShortcutsModal(false)} />
    </div>
  );
};
