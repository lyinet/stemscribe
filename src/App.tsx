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
import { onLanguageChange, t, useLanguage } from "./i18n";
import type { I18nKey } from "./i18n";
import { AiAssistantPanel } from "./components/AiAssistantPanel";
import { BatchQueueModal } from "./components/BatchQueueModal";
import { ChordTrack } from "./components/ChordTrack";
import { CommandPaletteModal, type PaletteCommand } from "./components/CommandPaletteModal";
import { CoverStudioView } from "./components/CoverStudioView";
import { DiagnosticsModal } from "./components/DiagnosticsModal";
import { DrumPatternView } from "./components/DrumPatternView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FallingNotesView } from "./components/FallingNotesView";
import { ImportStemsModal } from "./components/ImportStemsModal";
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
import { RestorePanel } from "./components/restore/RestorePanel";
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
  analyzeAudioQuality,
  askConfirm,
  deleteSetlist,
  detectBpmLocal,
  detectChordsLocal,
  detectDrumHitsLocal,
  detectKeyLocal,
  detectSongStructureLocal,
  setMenuLanguage,
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
  exportRestoredWav,
  listPracticeRecords,
  deleteRecordedTake,
  listRecordedTakes,
  listSavedProjects,
  listSetlists,
  loadProjectFile,
  mixTakeWithStemsWav,
  onMacosMenuAction,
  onNativeFileDrop,
  onRestoreProgress,
  pickAudioFile,
  pickAudioFilesMultiple,
  guessStemRoles,
  importStemsAsMix,
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
  checkFilesExist,
  reharmonizeChordsLocal,
  restoreAgent,
  restoreAudio,
  restoreCompare,
  onAgentProgress,
  stopRestoreAgent,
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
  AgentProgress,
  AgentResult,
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
  QualityReport,
  RestoreProgress,
  RestoreResult,
  RestoreSettings,
  CompareResult,
  ImportStemSpec,
} from "./types/music";
import { DEFAULT_RESTORE_SETTINGS } from "./types/music";

type StudioTab =
  | "restore"
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

const EDITOR_TAB_GROUPS: Array<{ labelKey: I18nKey; tabs: Array<{ id: StudioTab; labelKey: I18nKey }> }> = [
  {
    labelKey: "app.grp.master",
    tabs: [{ id: "restore", labelKey: "app.tab.restore" }],
  },
  {
    labelKey: "app.grp.edit",
    tabs: [
      { id: "score", labelKey: "app.tab.score" },
      { id: "chords", labelKey: "app.tab.chords" },
      { id: "drums", labelKey: "app.tab.drums" },
      { id: "lyrics", labelKey: "app.tab.lyrics" },
      { id: "mixer", labelKey: "app.tab.mixer" },
    ],
  },
  {
    labelKey: "app.grp.practice",
    tabs: [
      { id: "falling", labelKey: "app.tab.falling" },
      { id: "instrument", labelKey: "app.tab.instrument" },
      { id: "coach", labelKey: "app.tab.coach" },
      { id: "cover", labelKey: "app.tab.cover" },
    ],
  },
];

const REHARM_STYLES: Array<{ id: ReharmonizeStyle; labelKey: I18nKey }> = [
  { id: "jazz_neosoul", labelKey: "app.reharm.jazz" },
  { id: "folk_open", labelKey: "app.reharm.folk" },
  { id: "cinematic_minor", labelKey: "app.reharm.cinematic" },
  { id: "pop_beginner", labelKey: "app.reharm.pop" },
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
const THEME_LABEL_KEYS: Record<AppTheme, I18nKey> = {
  dark: "app.theme.dark",
  midnight: "app.theme.midnight",
  light: "app.theme.light",
};

export const App: React.FC = () => {
  const lang = useLanguage();

  useEffect(() => {
    void setMenuLanguage(lang);
    return onLanguageChange((l) => void setMenuLanguage(l));
  }, []);
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
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<RestoreProgress | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [compareSel, setCompareSel] = useState(0);
  const [importStemsDraft, setImportStemsDraft] = useState<{ paths: string[]; roles: string[] } | null>(null);
  const [restoreSettings, setRestoreSettings] = useState<RestoreSettings>(DEFAULT_RESTORE_SETTINGS);
  const [qualityBefore, setQualityBefore] = useState<QualityReport | null>(null);
  const [autoPipelining, setAutoPipelining] = useState(false);
  const [detectingChords, setDetectingChords] = useState(false);
  const [detectingStructure, setDetectingStructure] = useState(false);
  const [detectingDrums, setDetectingDrums] = useState(false);
  const [extractingLyrics, setExtractingLyrics] = useState(false);
  const [transcribingStem, setTranscribingStem] = useState<string | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [statusMsg, setStatusMsg] = useState(t("app.ready"));

  const [relayConfig, setRelayConfig] = useState<LlmRelayConfig>(() => {
    try {
      const saved = localStorage.getItem("stemscribe_relay_config");
      return saved ? { ...DEFAULT_RELAY, ...JSON.parse(saved) } : DEFAULT_RELAY;
    } catch {
      return DEFAULT_RELAY;
    }
  });
  const [highQualitySep, setHighQualitySep] = useState<boolean>(
    () => localStorage.getItem("stemscribe_hq_sep") === "1"
  );
  const applyHighQualitySep = (v: boolean) => {
    setHighQualitySep(v);
    localStorage.setItem("stemscribe_hq_sep", v ? "1" : "0");
  };
  const [analysis, setAnalysis] = useState<ArrangementAnalysis | null>(null);
  const [refineSummary, setRefineSummary] = useState("");
  const [fingeringTips, setFingeringTips] = useState<string[]>([]);

  const applyTheme = (next: AppTheme) => {
    setTheme(next);
    localStorage.setItem("stemscribe_theme", next);
    setStatusMsg(t("app.msg.themeSwitched", { name: t(THEME_LABEL_KEYS[next]) }));
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
      setStatusMsg(t("app.msg.quantized", { n: quantized.length, grid: subdiv * 4 }));
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
      setStatusMsg(t("app.msg.reharmed", { style: res.style_label_zh, desc: res.description }));
    } catch (err) {
      setStatusMsg(t("app.msg.reharmFail", { err: String(err) }));
    }
  };

  const handleRestoreOriginalChords = () => {
    if (!originalChordsBackup) return;
    setChords(originalChordsBackup);
    setOriginalChordsBackup(null);
    setActiveReharmStyle(null);
    setStatusMsg(t("app.msg.reharmReverted"));
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
    setStatusMsg(t("app.msg.takeArchived", { path: saved.file_path }));
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
      setStatusMsg(t("app.msg.demoBounceHint"));
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
    setStatusMsg(t("app.msg.bouncing"));
    const saved = await mixTakeWithStemsWav(inputs, wavBase64, takeGain, takeOffsetMs, savePath);
    setStatusMsg(t("app.msg.bounced", { path: saved }));
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
        setStatusMsg(t("app.msg.midiReady"));
      } else {
        setStatusMsg(t("app.msg.midiConnected", { names: devs.map((d) => d.name).join(" / ") }));
      }
    } catch (err) {
      setStatusMsg(t("app.msg.midiErr", { err: String(err) }));
    }
  }, []);

  const handleLoadDemoSong = useCallback(() => {
    revokeDemoBlobs();
    const demo = createDemoStudioBundle();
    demoBlobUrlsRef.current = demo.blobUrls;

    setAudioMeta(demo.audioMeta);
    setRestoreResult(null);
    setQualityBefore(null);
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
    setActiveStemName(t("demo.stem.vocals"));
    setBpm(120);
    setTransposeSemitones(0);
    setCapoFret(0);
    setUndoStack([]);
    setRedoStack([]);
    setMarkers([
      { id: "demo_m1", label: t("app.demo.m1"), time_sec: 8.0 },
      { id: "demo_m2", label: t("app.demo.m2"), time_sec: 16.0 },
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
    setStatusMsg(t("app.msg.demoLoaded"));
  }, [eq, reverbPreset, reverbWet, metronomeEnabled]);

  const loadAudioByPath = useCallback(
    async (path: string) => {
      setLoadingAudio(true);
      try {
        revokeDemoBlobs();
        setStatusMsg(t("app.msg.analyzing"));
        const meta = await inspectAudioFile(path);
        setAudioMeta(meta);
        setRestoreResult(null);
        setQualityBefore(null);
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
        setStatusMsg(t("app.msg.loaded", { name: meta.file_name, dur: meta.duration_sec.toFixed(1) }));
      } catch (err) {
        setStatusMsg(t("app.msg.loadFail", { err: String(err) }));
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
      setStatusMsg(t("app.msg.taskErr", { err: String(evt.reason) }));
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
      setStatusMsg(t("app.msg.rampUp", { pct: (nextRate * 100).toFixed(0) }));
    });
  }, [progressiveRampEnabled]);

  // The restore panel needs ~400px for its three columns + A/B bar.
  useEffect(() => {
    if (studioTab === "restore" && editorOpen) {
      const maxH = Math.max(EDITOR_MIN_H, window.innerHeight - 280);
      setEditorHeight((h) => Math.min(maxH, Math.max(h, 400)));
    }
  }, [studioTab, editorOpen]);

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
      restoration: restoreResult
        ? {
            output_path: restoreResult.output_path,
            settings: restoreSettings,
            before: restoreResult.before,
            after: restoreResult.after,
            notes: restoreResult.notes,
          }
        : null,
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
    restoreResult,
    restoreSettings,
  ]);

  const handleExportLeadSheetHtml = async (input: LeadSheetInput) => {
    const savePath = await pickHtmlSavePath(`${input.title || "leadsheet"}_A4.html`);
    if (!savePath) return;
    try {
      const saved = await exportLeadsheetHtml(input, savePath);
      setStatusMsg(t("app.msg.leadsheetSaved", { path: saved }));
    } catch (err) {
      setStatusMsg(t("app.msg.leadsheetFail", { err: String(err) }));
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
      setStatusMsg(t("app.msg.recordSaved", { rank: record.rank, acc: record.accuracy_pct.toFixed(1) }));
    } catch (err) {
      setStatusMsg(t("app.msg.recordFail", { err: String(err) }));
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    try {
      const list = await deleteProjectFile(projectId);
      setRecentProjects(list);
      setStatusMsg(t("app.msg.projDeleted"));
    } catch (err) {
      setStatusMsg(t("app.msg.projDeleteFail", { err: String(err) }));
    }
  };

  const handleRenameProject = async (projectId: string, newName: string) => {
    try {
      const list = await renameProjectFile(projectId, newName);
      setRecentProjects(list);
      setStatusMsg(t("app.msg.projRenamed", { name: newName }));
    } catch (err) {
      setStatusMsg(t("app.msg.projRenameFail", { err: String(err) }));
    }
  };

  const handleLoopMarkerSection = (startSec: number, endSec: number, label: string) => {
    setLoopA(startSec);
    setLoopB(endSec);
    setLoopEnabled(true);
    engineRef.current?.setLoop(true, startSec, endSec);
    engineRef.current?.seek(startSec);
    setStatusMsg(t("app.msg.segLocked", { label, a: startSec.toFixed(1), b: endSec.toFixed(1) }));
  };

  const handleDeletePracticeRecord = async (recordId: string) => {
    try {
      const updated = await deletePracticeRecord(recordId);
      setPracticeRecords(updated);
      setStatusMsg(t("app.msg.recordDeleted"));
    } catch (err) {
      setStatusMsg(t("app.msg.recordDeleteFail", { err: String(err) }));
    }
  };

  const handleExportPracticeCsv = async () => {
    if (practiceRecords.length === 0) return;
    const savePath = await pickCsvSavePath(t("app.csvFileName"));
    if (!savePath) return;
    try {
      const saved = await exportPracticeRecordsCsv(savePath);
      setStatusMsg(t("app.msg.csvSaved", { path: saved }));
    } catch (err) {
      setStatusMsg(t("app.msg.csvFail", { err: String(err) }));
    }
  };

  const handleSaveSetlist = async (sl: Setlist) => {
    try {
      const updated = await saveSetlist(sl);
      setSetlists(updated);
    } catch (err) {
      setStatusMsg(t("app.msg.setlistFail", { err: String(err) }));
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
      setStatusMsg(t("app.msg.setlistDeleteFail", { err: String(err) }));
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
            key_label: keyEst?.label ?? t("app.keyUnknown"),
            capo_fret: capoFret,
          },
        ],
      };
      await handleSaveSetlist(next);
      setStatusMsg(t("app.msg.addedToSetlist", { proj: proj.name, sl: sl.name }));
    } catch (err) {
      setStatusMsg(t("app.msg.addSetlistFail", { err: String(err) }));
    }
  };

  const handleLoadProject = useCallback(async (projectId: string, preferredCapo?: number) => {
    try {
      const p = await loadProjectFile(projectId);
      // Stems may point at a shared temp dir that a later separation
      // overwrote — drop missing or duration-mismatched stem files.
      let projectStems = p.stems;
      let stemsStale = false;
      if (p.stems.length > 0) {
        const exists = await checkFilesExist(p.stems.map((s) => s.file_path));
        stemsStale = p.stems.some(
          (s, i) =>
            !exists[i] ||
            !Number.isFinite(s.duration_sec) ||
            Math.abs(s.duration_sec - p.audio_meta.duration_sec) > 0.5
        );
        if (stemsStale) projectStems = [];
      }
      setAudioMeta(p.audio_meta);
      setStems(projectStems);
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
      if (p.restoration) {
        setRestoreResult({
          output_path: p.restoration.output_path,
          sample_rate: p.restoration.after.sample_rate,
          bit_depth: p.restoration.after.bit_depth ?? 24,
          before: p.restoration.before,
          after: p.restoration.after,
          loudness_match_db:
            p.restoration.before.integrated_lufs - p.restoration.after.integrated_lufs,
          limiter_avg_gr_db: 0,
          notes: p.restoration.notes,
          elapsed_ms: 0,
        });
        setQualityBefore(p.restoration.before);
        setRestoreSettings(p.restoration.settings);
      } else {
        setRestoreResult(null);
        setQualityBefore(null);
      }
      setShowProjectsMenu(false);
      setIsPlaying(false);
      setCurrentTime(0);
      if (projectStems.length > 0) {
        engineRef.current?.loadStems(projectStems, (t) => setCurrentTime(t));
      }
      setStatusMsg(
        t("app.msg.projRestored", { name: p.name, stale: stemsStale ? t("app.msg.stemsStale") : "" })
      );
    } catch (err) {
      setStatusMsg(t("app.msg.projLoadFail", { err: String(err) }));
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
    setStatusMsg(t("app.msg.presetSwitched", { name: preset }));
  };

  const handleExportLoopSlice = async () => {
    if (!audioMeta || loopB <= loopA + 0.05) return;
    if (isDemoBlobPath(audioMeta.file_path)) {
      setStatusMsg(t("app.msg.demoSlice"));
      return;
    }
    const savePath = await pickWavSavePath(
      `${audioMeta.file_name}_${loopA.toFixed(0)}s-${loopB.toFixed(0)}s.wav`
    );
    if (!savePath) return;
    try {
      setStatusMsg(t("app.msg.slicing"));
      const saved = await exportAudioSliceWav(audioMeta.file_path, loopA, loopB, savePath);
      setStatusMsg(t("app.msg.sliced", { path: saved }));
    } catch (err) {
      setStatusMsg(t("app.msg.sliceFail", { err: String(err) }));
    }
  };

  const originalStem = useMemo<StemOutput | null>(
    () =>
      audioMeta && stems.length === 0
        ? {
            name: "original",
            label_zh: t("rp.original"),
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
        setStatusMsg(t("app.msg.parsingMidi"));
        const res = await importMidiFile(midiPath);
        setActiveStemName(res.stem_name);
        setBpm(res.estimated_bpm);
        setTransposeSemitones(0);
        engineRef.current?.setTranspose(0);
        commitNotes(res.notes);
        setMidiAuditionEnabled(true);
        setStudioTab("falling");
        setStatusMsg(t("app.msg.midiImported", { name: res.stem_name, n: res.notes.length, bpm: res.estimated_bpm }));
      } catch (err) {
        setStatusMsg(t("app.msg.midiImportFail", { err: String(err) }));
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
      setStatusMsg(t("app.msg.projSaved", { path: saved }));
    } catch (err) {
      setStatusMsg(t("app.msg.projSaveFail", { err: String(err) }));
    }
  }, [buildCurrentProject]);

  const handleExportBundle = useCallback(async () => {
    const proj = buildCurrentProject();
    if (!proj) return;
    const dir = await pickDirectory();
    if (!dir) return;
    try {
      setStatusMsg(t("app.msg.bundling"));
      const outDir = await exportPracticeBundle(proj, keyEst?.label ?? null, dir);
      setStatusMsg(t("app.msg.bundled", { dir: outDir }));
    } catch (err) {
      setStatusMsg(t("app.msg.bundleFail", { err: String(err) }));
    }
  }, [buildCurrentProject, keyEst]);

  const handleExportMidi = useCallback(async () => {
    if (transposedNotes.length === 0) return;
    const savePath = await pickMidiSavePath(`${activeStemName || "stem"}.mid`);
    if (!savePath) return;
    try {
      const saved = await exportMidiFile(transposedNotes, bpm, savePath);
      setStatusMsg(t("app.msg.midiExported", { t: transposeSemitones, path: saved }));
    } catch (err) {
      setStatusMsg(t("app.msg.midiExportFail", { err: String(err) }));
    }
  }, [transposedNotes, activeStemName, bpm, transposeSemitones]);

  const handleExportMidiWithChords = useCallback(async () => {
    if (transposedNotes.length === 0 || chords.length === 0) return;
    const savePath = await pickMidiSavePath(`${activeStemName || "arrangement"}_2track.mid`);
    if (!savePath) return;
    try {
      const saved = await exportMidiWithChords(transposedNotes, chords, bpm, savePath);
      setStatusMsg(t("app.msg.midi2Exported", { path: saved }));
    } catch (err) {
      setStatusMsg(t("app.msg.midi2Fail", { err: String(err) }));
    }
  }, [transposedNotes, chords, activeStemName, bpm]);

  const handleExportMixedWav = useCallback(async () => {
    if (stems.length === 0) return;
    if (stems.some((s) => isDemoBlobPath(s.file_path))) {
      setStatusMsg(t("app.msg.demoMix"));
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
      setStatusMsg(t("app.msg.mixing"));
      const saved = await exportMixedWav(inputs, savePath, -1.0, audioMeta?.sample_rate);
      setStatusMsg(t("app.msg.mixed", { path: saved }));
    } catch (err) {
      setStatusMsg(t("app.msg.mixFail", { err: String(err) }));
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
        case "import_stems":
          handleImportStemsRef.current();
          break;
        case "open_command_palette":
          setShowCommandPalette((v) => !v);
          break;
        case "restore_audio":
          handleRestoreRef.current();
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
        handleAddMarker(t("app.bookmark"), currentTime);
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
    setStatusMsg(t("app.msg.detectingStructure"));
    try {
      const segs = await detectSongStructureLocal(audioMeta.file_path);
      setStructure(segs);
      setStatusMsg(t("app.msg.structureDone", { n: segs.length }));
    } catch (err) {
      setStatusMsg(t("app.msg.structureFail", { err: String(err) }));
    } finally {
      setDetectingStructure(false);
    }
  };

  const handleDetectChords = async () => {
    if (!audioMeta) return;
    setDetectingChords(true);
    setStatusMsg(t("app.msg.detectingChords"));
    try {
      const [res, keyRes] = await Promise.all([
        detectChordsLocal(audioMeta.file_path, 2.0),
        detectKeyLocal(audioMeta.file_path),
      ]);
      setChords(res);
      setOriginalChordsBackup(null);
      setActiveReharmStyle(null);
      setKeyEst(keyRes);
      setStatusMsg(t("app.msg.chordsDone", { key: keyRes.label, n: res.length }));
    } catch (err) {
      setStatusMsg(t("app.msg.chordsFail", { err: String(err) }));
    } finally {
      setDetectingChords(false);
    }
  };

  const handleDetectDrums = async () => {
    const drumStem = stems.find((s) => s.name === "drums");
    if (!drumStem) return;
    setDetectingDrums(true);
    setStatusMsg(t("app.msg.detectingDrums"));
    try {
      const hits = await detectDrumHitsLocal(drumStem.file_path);
      setDrumHits(hits);
      setStatusMsg(t("app.msg.drumsDone", { n: hits.length }));
    } catch (err) {
      setStatusMsg(t("app.msg.drumsFail", { err: String(err) }));
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
      setStatusMsg(t("app.msg.drumMidiSaved", { path: saved }));
    } catch (err) {
      setStatusMsg(t("app.msg.drumMidiFail", { err: String(err) }));
    }
  };

  const handleExtractLyrics = async (useWhisper: boolean) => {
    if (!audioMeta) return;
    const vocalStem = stems.find((s) => s.name === "vocals");
    const targetPath = vocalStem ? vocalStem.file_path : audioMeta.file_path;
    setExtractingLyrics(true);
    setStatusMsg(t("app.msg.extractingLyrics"));
    try {
      const lines = await extractLyricsWithRelay(targetPath, useWhisper, relayConfig);
      setLyrics(lines);
      setStatusMsg(t("app.msg.lyricsDone", { n: lines.length }));
    } catch (err) {
      setStatusMsg(t("app.msg.lyricsFail", { err: String(err) }));
    } finally {
      setExtractingLyrics(false);
    }
  };

  const handleImportLrcByPath = useCallback(async (filePath: string) => {
    try {
      const parsed = await importLrcFile(filePath);
      setLyrics(parsed);
      setStudioTab("lyrics");
      setStatusMsg(t("app.msg.lrcImported", { n: parsed.length }));
    } catch (err) {
      setStatusMsg(t("app.msg.lrcFail", { err: String(err) }));
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
      setStatusMsg(t("app.msg.lrcSaved", { path: saved }));
    } catch (err) {
      setStatusMsg(t("app.msg.lrcExportFail", { err: String(err) }));
    }
  };

  const handleExportSrt = async () => {
    if (lyrics.length === 0) return;
    const savePath = await pickSrtSavePath(`${audioMeta?.file_name || "subtitles"}.srt`);
    if (!savePath) return;
    try {
      const saved = await exportSrtFile(lyrics, savePath);
      setStatusMsg(t("app.msg.srtSaved", { path: saved }));
    } catch (err) {
      setStatusMsg(t("app.msg.srtFail", { err: String(err) }));
    }
  };

  const ensureModelInstalled = async (
    kind: "demucs" | "basic_pitch" | "demucs_ft_vocals"
  ): Promise<boolean> => {
    try {
      const status = await getModelStatus();
      setModelStatus(status);
      const installed =
        kind === "demucs"
          ? status.demucs_installed
          : kind === "demucs_ft_vocals"
            ? status.demucs_ft_vocals_installed
            : status.basic_pitch_installed;
      if (installed) return true;
    } catch {
      return true;
    }
    const message =
      kind === "demucs"
        ? t("app.needModel.demucs")
        : kind === "demucs_ft_vocals"
          ? t("app.needModel.demucsFt")
          : t("app.needModel.bp");
    const yes = await askConfirm(message, t("app.needModel.title"));
    if (yes) {
      setShowModelModal(true);
    } else {
      setStatusMsg(t("app.msg.modelCancelled"));
    }
    return false;
  };

  const performSeparation = useCallback(
    async (filePath: string): Promise<StemOutput[]> => {
      let quality: "standard" | "high" = highQualitySep ? "high" : "standard";
      if (quality === "high" && !(await ensureModelInstalled("demucs_ft_vocals"))) {
        quality = "standard";
      }
      let res: StemOutput[];
      try {
        res = await separateStems(filePath, quality);
      } catch (err) {
        // Model removed after the upfront check → offer the download prompt.
        if (String(err).includes("htdemucs_ft_vocals")) {
          await ensureModelInstalled("demucs_ft_vocals");
        }
        throw err;
      }
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
      return res;
    },
    [eq, reverbPreset, reverbWet, highQualitySep]
  );

  const handleSeparateStems = async () => {
    if (!audioMeta) return;
    if (isDemoBlobPath(audioMeta.file_path)) {
      setStatusMsg(t("app.msg.demoHasStems"));
      return;
    }
    if (!(await ensureModelInstalled("demucs"))) return;
    setSeparating(true);
    setStatusMsg(t("app.msg.separating"));
    try {
      await performSeparation(audioMeta.file_path);
      setStatusMsg(t("app.msg.separated"));
    } catch (err) {
      setStatusMsg(t("app.msg.separateFail", { err: String(err) }));
    } finally {
      setSeparating(false);
    }
  };

  /** Offer AI separation when no stems exist (imported or separated). */
  const ensureStemsForRestore = async (): Promise<StemOutput[]> => {
    let useStems = stems;
    if (useStems.length === 0) {
      const yes = await askConfirm(
        t("app.sepFirstPrompt"),
        t("app.oneClick")
      );
      if (yes && audioMeta && (await ensureModelInstalled("demucs"))) {
        setSeparating(true);
        setStatusMsg(t("app.msg.separating"));
        try {
          useStems = await performSeparation(audioMeta.file_path);
        } finally {
          setSeparating(false);
        }
      }
    }
    return useStems;
  };

  const advisorPrevRef = useRef<{ result: RestoreResult; score: number } | null>(null);
  const [advisorRegress, setAdvisorRegress] = useState<{
    prevResult: RestoreResult;
    prevScore: number;
    newScore: number;
  } | null>(null);

  const handleRestore = async (settingsOverride?: RestoreSettings) => {
    if (!audioMeta || restoring) return;
    if (isDemoBlobPath(audioMeta.file_path)) {
      setStatusMsg(t("app.msg.demoNoRestore"));
      return;
    }
    const effSettings = settingsOverride ?? restoreSettings;
    setStudioTab("restore");
    setEditorOpen(true);
    try {
      if (!qualityBefore) {
        setStatusMsg(t("app.msg.diagnosing"));
        setQualityBefore(await analyzeAudioQuality(audioMeta.file_path));
      }
      const useStems = await ensureStemsForRestore();
      setRestoring(true);
      setRestoreProgress({ stage: "analyze", percent: 0 });
      const unlisten = await onRestoreProgress(setRestoreProgress);
      try {
        const res = await restoreAudio({
          source_path: audioMeta.file_path,
          stems: useStems.map((s) => ({
            name: s.name,
            file_path: s.file_path,
            role: s.role ?? "",
          })),
          settings: effSettings,
          output_path: null,
        });
        setRestoreResult(res);
        setQualityBefore(res.before);
        const prev = advisorPrevRef.current;
        advisorPrevRef.current = null;
        setAdvisorRegress(
          prev && res.objective && res.objective.score > prev.score + 0.5
            ? { prevResult: prev.result, prevScore: prev.score, newScore: res.objective.score }
            : null,
        );
        setStatusMsg(t("app.msg.restored", { name: res.output_path.split("/").pop() ?? "" }));
      } finally {
        unlisten();
        setRestoring(false);
        setRestoreProgress(null);
      }
    } catch (err) {
      setRestoring(false);
      setRestoreProgress(null);
      setStatusMsg(t("app.msg.restoreFail", { err: String(err) }));
    }
  };

  const handleRestoreRef = useRef(handleRestore);
  handleRestoreRef.current = handleRestore;

  /** Adopt an AI-advisor proposal: keep the current render for possible
   *  rollback, apply the proposed settings and run the normal render. */
  const handleApplyAdvisor = (s: RestoreSettings) => {
    advisorPrevRef.current =
      restoreResult?.objective != null
        ? { result: restoreResult, score: restoreResult.objective.score }
        : null;
    setRestoreSettings(s);
    void handleRestore(s);
  };

  const handleRevertAdvisor = () => {
    if (advisorRegress) setRestoreResult(advisorRegress.prevResult);
    setAdvisorRegress(null);
  };

  // ---------- AI 多轮自动修复 ----------
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentRows, setAgentRows] = useState<Record<number, AgentProgress>>({});
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const agentProgressRows = useMemo(
    () => Object.values(agentRows).sort((a, b) => a.round - b.round),
    [agentRows]
  );

  const handleRunAgent = async (userRequest: string) => {
    if (!audioMeta || restoring || agentRunning) return;
    if (isDemoBlobPath(audioMeta.file_path)) {
      setStatusMsg(t("app.msg.demoNoRestore"));
      return;
    }
    setStudioTab("restore");
    setEditorOpen(true);
    try {
      if (!qualityBefore) {
        setStatusMsg(t("app.msg.diagnosing"));
        setQualityBefore(await analyzeAudioQuality(audioMeta.file_path));
      }
      const useStems = await ensureStemsForRestore();
      setAgentRunning(true);
      setAgentResult(null);
      setAgentRows({});
      const unlisten = await onAgentProgress((p) =>
        setAgentRows((m) => ({ ...m, [p.round]: p }))
      );
      try {
        const baseline =
          restoreResult?.objective != null
            ? {
                output_path: restoreResult.output_path,
                report: restoreResult.after,
                score: restoreResult.objective.score,
                terms: restoreResult.objective.terms,
              }
            : null;
        const res = await restoreAgent(
          relayConfig,
          {
            source_path: audioMeta.file_path,
            stems: useStems.map((s) => ({
              name: s.name,
              file_path: s.file_path,
              role: s.role ?? "",
            })),
            settings: restoreSettings,
            output_path: null,
          },
          userRequest,
          3,
          baseline
        );
        setAgentResult(res);
        setRestoreResult(res.best);
        setQualityBefore(res.best.before);
        setStatusMsg(
          t("app.msg.agentDone", { round: res.best_round === 0 ? t("rp.baseline") : t("rp.round", { n: res.best_round }) })
        );
      } finally {
        unlisten();
        setAgentRunning(false);
      }
    } catch (err) {
      setAgentRunning(false);
      setStatusMsg(t("app.msg.agentFail", { err: String(err) }));
    }
  };

  const handleStopAgent = () => {
    void stopRestoreAgent();
  };

  const advisorStemRoles = useMemo(
    () =>
      stems.map((s) => {
        const r = s.role ?? "";
        if (r === "lead") return "lead_vocals";
        if (r === "backing") return "backing_vocals";
        if (r === "perc") return "percussion";
        if (r) return r;
        const n = s.name.toLowerCase();
        if (/vocal|vox/.test(n)) return "lead_vocals";
        if (/drum/.test(n)) return "drums";
        if (/bass/.test(n)) return "bass";
        return "other";
      }),
    [stems]
  );

  const candidateAsResult = useCallback(
    (cmp: CompareResult, i: number): RestoreResult => {
      const c = cmp.candidates[i];
      return {
        output_path: c.output_path,
        sample_rate: c.after.sample_rate,
        bit_depth: restoreSettings.bit_depth,
        before: cmp.before,
        after: c.after,
        loudness_match_db:
          cmp.before.integrated_lufs - c.after.integrated_lufs,
        limiter_avg_gr_db: 0,
        notes: c.notes,
        elapsed_ms: cmp.elapsed_ms,
        reference: null,
        objective: c.objective,
        critic: c.critic ?? null,
        critic_before: cmp.critic_before ?? null,
      };
    },
    [restoreSettings.bit_depth]
  );

  const handleSelectCompare = useCallback(
    (i: number) => {
      setCompareSel(i);
      if (compareResult) setRestoreResult(candidateAsResult(compareResult, i));
    },
    [compareResult, candidateAsResult]
  );

  const handleRestoreCompare = async () => {
    if (!audioMeta || restoring) return;
    if (isDemoBlobPath(audioMeta.file_path)) {
      setStatusMsg(t("app.msg.demoNoRestore"));
      return;
    }
    setStudioTab("restore");
    setEditorOpen(true);
    try {
      if (!qualityBefore) {
        setStatusMsg(t("app.msg.diagnosing"));
        setQualityBefore(await analyzeAudioQuality(audioMeta.file_path));
      }
      const useStems = await ensureStemsForRestore();
      setRestoring(true);
      setRestoreProgress({ stage: "compare_light", percent: 0 });
      const unlisten = await onRestoreProgress(setRestoreProgress);
      try {
        const cmp = await restoreCompare({
          source_path: audioMeta.file_path,
          stems: useStems.map((s) => ({
            name: s.name,
            file_path: s.file_path,
            role: s.role ?? "",
          })),
          settings: restoreSettings,
          output_path: null,
        });
        setCompareResult(cmp);
        setCompareSel(cmp.recommended);
        setRestoreResult(candidateAsResult(cmp, cmp.recommended));
        setQualityBefore(cmp.before);
        setStatusMsg(
          t("app.msg.compareDone", { label: cmp.candidates[cmp.recommended].strength_label, reason: cmp.reason })
        );
      } finally {
        unlisten();
        setRestoring(false);
        setRestoreProgress(null);
      }
    } catch (err) {
      setRestoring(false);
      setRestoreProgress(null);
      setStatusMsg(t("app.msg.compareFail", { err: String(err) }));
    }
  };

  const pickStemFiles = async () => {
    const paths = await pickAudioFilesMultiple();
    if (paths.length === 0) return null;
    const roles = await guessStemRoles(paths);
    return { paths, roles };
  };

  const handleImportStems = async () => {
    try {
      const picked = await pickStemFiles();
      if (picked) setImportStemsDraft(picked);
    } catch (err) {
      setStatusMsg(t("app.msg.pickStemsFail", { err: String(err) }));
    }
  };
  const handleImportStemsRef = useRef(handleImportStems);
  handleImportStemsRef.current = handleImportStems;

  const confirmImportStems = async (
    rows: ImportStemSpec[],
    mixPath: string | null
  ) => {
    setImportStemsDraft(null);
    setStatusMsg(t("app.msg.importingStems"));
    try {
      const imp = await importStemsAsMix(rows, mixPath);
      await loadAudioByPath(imp.mix_path);
      setStems(imp.stems);
      setRestoreResult(null);
      setCompareResult(null);
      const initMixer: Record<string, StemMixerState> = {};
      for (const s of imp.stems) {
        initMixer[s.name] = { muted: false, solo: false, gain: 1.0, pan: 0 };
      }
      setMixer(initMixer);
      engineRef.current?.loadStems(imp.stems, (t) => setCurrentTime(t));
      engineRef.current?.applyMixer(initMixer);
      setStudioTab("restore");
      setEditorOpen(true);
      setStatusMsg(
        imp.notes.length > 0
          ? imp.notes.join("；")
          : t("app.msg.stemsImported", { n: imp.stems.length })
      );
    } catch (err) {
      setStatusMsg(t("app.msg.importStemsFail", { err: String(err) }));
    }
  };

  const handleExportRestored = async (bitDepth: 24 | 16) => {
    if (!restoreResult) return;
    const base = (audioMeta?.file_name || "song").replace(/\.[^.]+$/, "");
    const savePath = await pickWavSavePath(`${base}${t("app.fixedSuffix")}.wav`);
    if (!savePath) return;
    try {
      setStatusMsg(t("app.msg.exporting"));
      const out = await exportRestoredWav(restoreResult.output_path, savePath, bitDepth);
      setStatusMsg(t("app.msg.fixedExported", { bits: bitDepth, path: out }));
    } catch (err) {
      setStatusMsg(t("app.msg.exportFail", { err: String(err) }));
    }
  };

  const handleSmartAutoPipeline = async () => {
    if (!audioMeta) return;
    if (isDemoBlobPath(audioMeta.file_path)) {
      setStatusMsg(t("app.msg.demoPipelineHint"));
      return;
    }
    if (!(await ensureModelInstalled("demucs"))) return;
    const sepQuality: "standard" | "high" =
      highQualitySep && (await ensureModelInstalled("demucs_ft_vocals")) ? "high" : "standard";
    setAutoPipelining(true);
    try {
      setStatusMsg(t("app.msg.pipe1"));
      const resStems = await separateStems(audioMeta.file_path, sepQuality);
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

      setStatusMsg(t("app.msg.pipe2"));
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
        setStatusMsg(t("app.msg.pipe3"));
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
            ? t("app.msg.pipe4NoVocal", { stem: melodyStem.label_zh })
            : t("app.msg.pipe4", { stem: melodyStem.label_zh })
        );
        const tr = await transcribeStemToMidi(melodyStem.file_path, melodyStem.name);
        setActiveStemName(melodyStem.label_zh);
        setBpm(tr.estimated_bpm);
        commitNotes(tr.notes);
      }

      setStatusMsg(t("app.msg.pipeDone"));
    } catch (err) {
      setStatusMsg(t("app.msg.pipeFail", { err: String(err) }));
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
    setStatusMsg(t("app.msg.transcribing", { stem: stem.label_zh }));
    try {
      const res = await transcribeStemToMidi(stem.file_path, stem.name);
      setActiveStemName(stem.label_zh);
      setBpm(res.estimated_bpm);
      engineRef.current?.setMetronome(metronomeEnabled, res.estimated_bpm);
      commitNotes(res.notes);
      setStatusMsg(t("app.msg.transcribed", { n: res.notes.length, bpm: res.estimated_bpm }));
    } catch (err) {
      setStatusMsg(t("app.msg.transcribeFail", { err: String(err) }));
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
      setStatusMsg(t("app.msg.mxmlSaved", { path: saved }));
    } catch (err) {
      setStatusMsg(t("app.msg.mxmlFail", { err: String(err) }));
    }
  };

  const handleAnalyzeArrangement = async (useLoopSlice: boolean) => {
    if (!audioMeta) return;
    setLlmLoading(true);
    setStatusMsg(t("app.msg.llmAnalyzing"));
    try {
      const res = await analyzeArrangementWithLlm(
        audioMeta.file_path,
        bpm,
        useLoopSlice ? loopA : null,
        useLoopSlice ? loopB : null,
        relayConfig
      );
      setAnalysis(res);
      setStatusMsg(t("app.msg.llmDone"));
    } catch (err) {
      setStatusMsg(t("app.msg.llmFail", { err: String(err) }));
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
    setStatusMsg(t("app.msg.refining"));
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
      setStatusMsg(t("app.msg.refined"));
    } catch (err) {
      setStatusMsg(t("app.msg.refineFail", { err: String(err) }));
    } finally {
      setLlmLoading(false);
    }
  };


  const paletteCommands: PaletteCommand[] = [
    { id: "demo", category: t("app.cat.start"), label: t("app.cmd.demo"), shortcut: "Cmd+D", run: handleLoadDemoSong },
    { id: "open_audio", category: t("app.cat.file"), label: t("app.cmd.openAudio"), shortcut: "Cmd+O", run: handleOpenAudio },
    { id: "import_midi", category: t("app.cat.file"), label: t("app.cmd.importMidi"), shortcut: "Cmd+I", run: handleImportMidi },
    { id: "import_lrc", category: t("app.cat.file"), label: t("app.cmd.importLrc"), run: handleImportLrc },
    { id: "export_srt", category: t("app.cat.export"), label: t("app.cmd.exportSrt"), disabled: lyrics.length === 0, run: handleExportSrt },
    { id: "export_practice_csv", category: t("app.cat.export"), label: t("app.cmd.exportCsv"), disabled: practiceRecords.length === 0, run: handleExportPracticeCsv },
    { id: "restore", category: t("app.cat.ai"), label: t("app.cmd.restore"), shortcut: "Cmd+R", disabled: !audioMeta, run: handleRestore },
    { id: "auto_pipe", category: t("app.cat.ai"), label: t("app.cmd.autoPipe"), disabled: !audioMeta, run: handleSmartAutoPipeline },
    { id: "stage", category: t("app.cat.stage"), label: t("app.cmd.stage"), shortcut: "F", disabled: !audioMeta, run: () => setStageModeOpen((v) => !v) },
    { id: "setlist", category: t("app.cat.stage"), label: t("app.cmd.setlist"), shortcut: "Cmd+L", run: () => setShowSetlistModal(true) },
    { id: "leadsheet", category: t("app.cat.export"), label: t("app.cmd.leadsheet"), shortcut: "Cmd+P", disabled: !audioMeta, run: () => setShowLeadSheetModal(true) },
    { id: "share", category: t("app.cat.export"), label: t("app.cmd.share"), disabled: !audioMeta, run: () => setShowShareModal(true) },
    { id: "bundle", category: t("app.cat.export"), label: t("app.cmd.bundle"), shortcut: "Cmd+Shift+E", disabled: !audioMeta, run: handleExportBundle },
    { id: "midi2", category: t("app.cat.export"), label: t("app.cmd.midi2"), disabled: transposedNotes.length === 0 || chords.length === 0, run: handleExportMidiWithChords },
    { id: "tab_falling", category: t("app.cat.view"), label: t("app.cmd.tabFalling"), run: () => setStudioTab("falling") },
    { id: "tab_inst", category: t("app.cat.view"), label: t("app.cmd.tabInst"), run: () => setStudioTab("instrument") },
    { id: "tab_coach", category: t("app.cat.view"), label: t("app.cmd.tabCoach"), run: () => setStudioTab("coach") },
    { id: "tab_cover", category: t("app.cat.view"), label: t("app.cmd.tabCover"), run: () => setStudioTab("cover") },
    { id: "tab_score", category: t("app.cat.view"), label: t("app.cmd.tabScore"), run: () => setStudioTab("score") },
    { id: "tab_drums", category: t("app.cat.view"), label: t("app.cmd.tabDrums"), run: () => setStudioTab("drums") },
    { id: "tab_lyrics", category: t("app.cat.view"), label: t("app.cmd.tabLyrics"), run: () => setStudioTab("lyrics") },
    { id: "reharm_jazz", category: t("app.cat.chords"), label: t("app.cmd.reharmJazz"), disabled: chords.length === 0, run: () => handleReharmonize("jazz_neosoul") },
    { id: "reharm_folk", category: t("app.cat.chords"), label: t("app.cmd.reharmFolk"), disabled: chords.length === 0, run: () => handleReharmonize("folk_open") },
    { id: "usb_midi", category: t("app.cat.hw"), label: t("app.cmd.usbMidi"), run: handleConnectMidi },
    { id: "theme", category: t("app.cat.look"), label: t("app.cmd.theme", { name: t(THEME_LABEL_KEYS[theme]) }), run: handleCycleTheme },
    { id: "focus", category: t("app.cat.look"), label: aiPanelOpen ? t("app.cmd.hideAi") : t("app.cmd.showAi"), run: () => setAiPanelOpen((v) => !v) },
    { id: "settings", category: t("app.cat.settings"), label: t("app.cmd.settings"), shortcut: "Cmd+,", run: () => openSettings("general") },
    { id: "tab_chords", category: t("app.cat.view"), label: t("app.cmd.tabChords"), run: () => setStudioTab("chords") },
    { id: "tab_mixer", category: t("app.cat.view"), label: t("app.cmd.tabMixer"), run: () => setStudioTab("mixer") },
    { id: "models", category: t("app.cat.settings"), label: t("app.cmd.models"), run: () => setShowModelModal(true) },
    { id: "diagnostics", category: t("app.cat.settings"), label: t("app.cmd.diagnostics"), run: () => setShowDiagnosticsModal(true) },
    { id: "projects", category: t("app.cat.file"), label: t("app.cmd.projects"), run: () => setShowProjectLibrary(true) },
    { id: "batch", category: t("app.cat.tools"), label: t("app.cmd.batch"), shortcut: "Cmd+B", run: () => setShowBatchModal(true) },
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
    subtitle: st.name === "original" ? t("app.mixFull") : st.name,
    color: STEM_COLORS[st.name] ?? "#38bdf8",
    peaks: st.waveform_peaks,
    isOriginal: st.name === "original",
  }));

  const activeTabLabel = EDITOR_TAB_GROUPS.flatMap((g) => g.tabs).find(
    (t) => t.id === studioTab
  )?.labelKey;

  const pipelineStep = autoPipelining ? statusMsg.match(/(\d)\/4/)?.[1] : null;
  const busyLabel = restoring
    ? restoreProgress
      ? t("rp.progress", {
          stage:
            (
              {
                analyze: "rp.stage.analyze",
                stems: "rp.stage.stems",
                master: "rp.stage.master",
                limit: "rp.stage.limit",
                write: "rp.stage.write",
                report: "rp.stage.report",
              } as Record<string, string>
            )[restoreProgress.stage]
              ? t(
                  (
                    {
                      analyze: "rp.stage.analyze",
                      stems: "rp.stage.stems",
                      master: "rp.stage.master",
                      limit: "rp.stage.limit",
                      write: "rp.stage.write",
                      report: "rp.stage.report",
                    } as Record<string, string>
                  )[restoreProgress.stage] as I18nKey
                )
              : restoreProgress.stage,
        })
      : t("rp.restoring")
    : separating
      ? t("app.busy.separating")
    : autoPipelining
      ? pipelineStep
        ? t("app.busy.pipe", { n: pipelineStep })
        : t("app.busy.piping")
      : transcribingStem
        ? t("app.busy.transcribing")
        : detectingChords || detectingStructure || detectingDrums
          ? t("app.busy.analyzing")
          : extractingLyrics
            ? t("app.busy.lyrics")
            : loadingAudio
              ? t("app.busy.audio")
              : llmLoading
                ? t("app.busy.llm")
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
            {audioMeta ? audioMeta.file_name : notes.length > 0 ? activeStemName || t("app.midiScore") : t("app.noSong")}
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
          <button className="btn" onClick={handleOpenAudio} title={t("app.importTip")}>
            <FolderOpen size={14} /> {t("app.import")}
          </button>
          <button
            className="btn btn-primary"
            disabled={
              !audioMeta ||
              restoring ||
              autoPipelining ||
              separating ||
              isDemoBlobPath(audioMeta?.file_path)
            }
            onClick={() => handleRestore()}
            title={
              audioMeta && isDemoBlobPath(audioMeta.file_path)
                ? t("app.msg.demoNoRestore")
                : t("app.restoreTip")
            }
          >
            <Sparkles size={14} /> {restoring ? t("app.restoring") : t("app.oneClick")}
          </button>
          <button
            className="btn"
            disabled={!audioMeta || autoPipelining || separating || restoring}
            onClick={handleSmartAutoPipeline}
            title={t("app.autoPipeTip")}
          >
            <Wand2 size={14} /> {autoPipelining ? t("app.piping") : t("app.autoPipe")}
          </button>
          <div className="toolbar-divider" />
          <button
            className={`btn btn-icon ${aiPanelOpen ? "btn-active" : ""}`}
            onClick={() => setAiPanelOpen((v) => !v)}
            title={t("app.aiTip")}
          >
            <Bot size={16} />
          </button>
          <div className="menu-anchor">
            <button
              className={`btn btn-icon ${showProjectsMenu ? "btn-active" : ""}`}
              onClick={() => setShowProjectsMenu((v) => !v)}
              title={t("app.moreTip")}
            >
              <MoreHorizontal size={16} />
            </button>
            {showProjectsMenu && (
              <>
                <div className="menu-backdrop" onClick={() => setShowProjectsMenu(false)} />
                <div className="menu-pop">
                  {(
                    [
                      { icon: <Save size={14} />, label: t("app.menu.save"), hint: "⌘S", disabled: !audioMeta, onClick: handleSaveProject },
                      { icon: <FolderOpen size={14} />, label: t("app.menu.library", { n: recentProjects.length }), hint: "", onClick: () => setShowProjectLibrary(true) },
                      { icon: <Music size={14} />, label: t("app.menu.importMidi"), hint: "⌘I", onClick: handleImportMidi },
                      null,
                      { icon: <Layers size={14} />, label: separating ? t("app.busy.separating") : t("app.menu.separateOnly"), hint: "", disabled: !audioMeta || separating || autoPipelining || stems.length > 0, onClick: handleSeparateStems },
                      { icon: <ListOrdered size={14} />, label: t("app.menu.setlist", { n: setlists.length }), hint: "⌘L", onClick: () => setShowSetlistModal(true) },
                      { icon: <ListMusic size={14} />, label: t("app.menu.batch"), hint: "⌘B", onClick: () => setShowBatchModal(true) },
                      null,
                      { icon: <FileText size={14} />, label: t("app.menu.leadsheet"), hint: "⌘P", disabled: !audioMeta, onClick: () => setShowLeadSheetModal(true) },
                      { icon: <Maximize2 size={14} />, label: t("app.menu.stage"), hint: "F", disabled: !audioMeta, onClick: () => setStageModeOpen(true) },
                      { icon: <Share2 size={14} />, label: t("app.menu.share"), hint: "", disabled: !audioMeta, onClick: () => setShowShareModal(true) },
                      { icon: <Package size={14} />, label: t("app.menu.bundle"), hint: "", disabled: !audioMeta, onClick: handleExportBundle },
                      { icon: <Download size={14} />, label: t("app.menu.mix"), hint: "", disabled: stems.length === 0, onClick: handleExportMixedWav },
                      { icon: <Download size={14} />, label: t("app.menu.loop"), hint: "", disabled: !audioMeta || loopB <= loopA + 0.05, onClick: handleExportLoopSlice },
                      null,
                      { icon: <Search size={14} />, label: t("app.menu.palette"), hint: "⌘K", onClick: () => setShowCommandPalette(true) },
                      { icon: <HelpCircle size={14} />, label: t("app.menu.shortcuts"), hint: "?", onClick: () => setShowShortcutsModal(true) },
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
                      <div className="menu-heading">{t("app.recent")}</div>
                      {recentProjects.slice(0, 5).map((p) => (
                        <button key={p.id} className="menu-item" onClick={() => handleLoadProject(p.id)}>
                          <History size={14} />
                          <span className="menu-label">{p.name}</span>
                          <span className="menu-hint">{t("score.notes", { n: p.note_count })}</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          <button className="btn btn-icon" onClick={() => openSettings("general")} title={t("app.settingsTip")}>
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
              setStatusMsg(t("app.msg.segsToMarkers", { n: converted.length }));
            }}
            onDetectChords={handleDetectChords}
            onOpenChordEditor={() => openEditor("chords")}
            onAddMarker={() => {
              const seg = structure.find((sg) => currentTime >= sg.start_sec && currentTime < sg.end_sec);
              handleAddMarker(seg?.label ?? t("app.bookmarkN", { n: markers.length + 1 }), currentTime);
            }}
            onDeleteMarker={(id) => setMarkers((prev) => prev.filter((m) => m.id !== id))}
            onOpenMidiEditor={() => openEditor("score")}
            emptyState={
              <div className="empty-card">
                <div className="empty-icon">
                  <Music size={26} />
                </div>
                <h2>{t("app.heroTitle")}</h2>
                <p>{t("app.heroSub")}</p>
                <div className="empty-actions">
                  <button className="btn btn-primary btn-lg" onClick={handleOpenAudio}>
                    <FolderOpen size={16} /> {t("app.heroImport")}
                  </button>
                  <button className="btn btn-lg" onClick={handleLoadDemoSong}>
                    <Sparkles size={16} /> {t("app.heroDemo")}
                  </button>
                  <button className="btn btn-lg" onClick={handleImportStems}>
                    <Music size={16} /> {t("app.heroStems")}
                  </button>
                  <button className="btn btn-lg" onClick={handleImportMidi}>
                    <Music size={16} /> {t("app.heroMidi")}
                  </button>
                </div>
                <ol className="empty-steps">
                  <li>
                    <b>1</b>{t("app.step1")}
                  </li>
                  <li>
                    <b>2</b>{t("app.step2")}
                  </li>
                  <li>
                    <b>3</b>{t("app.step3")}
                  </li>
                </ol>
              </div>
            }
          />

          {(audioMeta || notes.length > 0) && (
          <div className={`editor ${editorOpen ? "" : "collapsed"}`} style={editorOpen ? { height: editorHeight } : undefined}>
            {editorOpen && <div className="editor-resize" onMouseDown={startEditorResize} title={t("app.resizeTip")} />}
            <div className="editor-tabs">
              {EDITOR_TAB_GROUPS.map((group) => (
                <div key={group.labelKey} className="editor-tab-group">
                  <span className="editor-group-label">{t(group.labelKey)}</span>
                  {group.tabs.map((tab) => (
                    <button
                      key={tab.id}
                      className={`editor-tab ${editorOpen && studioTab === tab.id ? "on" : ""}`}
                      onClick={() => openEditor(tab.id)}
                    >
                      {t(tab.labelKey)}
                      {editorTabCounts[tab.id] ? <span className="editor-count">{editorTabCounts[tab.id]}</span> : null}
                    </button>
                  ))}
                </div>
              ))}
              <button
                className="icon-btn editor-toggle"
                onClick={() => setEditorOpen((v) => !v)}
                title={editorOpen ? t("app.collapse") : t("app.expand")}
              >
                {editorOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
              </button>
            </div>
            {editorOpen && (
              <div className="editor-body">
            <ErrorBoundary compact resetKey={studioTab} label={activeTabLabel ? t(activeTabLabel) : ""}>
          {studioTab === "restore" && (
            <RestorePanel
              before={qualityBefore}
              result={restoreResult}
              settings={restoreSettings}
              onSettingsChange={setRestoreSettings}
              running={restoring}
              progress={restoreProgress}
              onRun={handleRestore}
              onRunCompare={handleRestoreCompare}
              compareResult={compareResult}
              compareSel={compareSel}
              onSelectCompare={handleSelectCompare}
              onExport={handleExportRestored}
              sourcePath={
                audioMeta && !isDemoBlobPath(audioMeta.file_path) ? audioMeta.file_path : null
              }
              sourceDuration={audioMeta?.duration_sec ?? 0}
              mainIsPlaying={isPlaying}
              onAbPlayingChange={(playing) => {
                if (playing) {
                  engineRef.current?.pause();
                  setIsPlaying(false);
                }
              }}
              llmConfig={relayConfig}
              stemRoles={advisorStemRoles}
              onApplyAdvisor={handleApplyAdvisor}
              advisorRegress={
                advisorRegress
                  ? { prevScore: advisorRegress.prevScore, newScore: advisorRegress.newScore }
                  : null
              }
              onRevertAdvisor={handleRevertAdvisor}
              onOpenAiSettings={() => openSettings("ai")}
              onRunAgent={handleRunAgent}
              agentRunning={agentRunning}
              onStopAgent={handleStopAgent}
              agentProgressRows={agentProgressRows}
              agentResult={agentResult}
            />
          )}

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
                  setStatusMsg(t("app.msg.takeDeleted", { name: fileName }));
                } catch (err) {
                  setStatusMsg(t("app.msg.takeDeleteFail", { err: String(err) }));
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
                <span className="reharm-title">{t("app.reharmTitle")}</span>
                {REHARM_STYLES.map((st) => (
                  <button
                    key={st.id}
                    className={`btn btn-sm ${activeReharmStyle === st.id ? "btn-active" : ""}`}
                    disabled={chords.length === 0}
                    onClick={() => handleReharmonize(st.id)}
                  >
                    {t(st.labelKey)}
                  </button>
                ))}
                {originalChordsBackup && (
                  <button className="btn btn-sm" onClick={handleRestoreOriginalChords}>
                    {t("app.revertOriginal")}
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
                <Bot size={14} /> {t("app.aiPanel")}
              </span>
              <button className="icon-btn" onClick={() => setAiPanelOpen(false)} title={t("app.close")}>
                <ChevronDown size={14} style={{ transform: "rotate(-90deg)" }} />
              </button>
            </div>
            <div className="inspector-body">
              <ErrorBoundary compact label={t("app.aiPanel")}>
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
        themeLabels={{ dark: t(THEME_LABEL_KEYS.dark), midnight: t(THEME_LABEL_KEYS.midnight), light: t(THEME_LABEL_KEYS.light) }}
        relayConfig={relayConfig}
        modelStatus={modelStatus}
        highQualitySep={highQualitySep}
        midiDevices={midiDevices}
        onClose={() => setShowSettings(false)}
        onThemeChange={applyTheme}
        onHighQualitySepChange={applyHighQualitySep}
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

      {importStemsDraft && (
        <ImportStemsModal
          paths={importStemsDraft.paths}
          roles={importStemsDraft.roles}
          onPickMore={pickStemFiles}
          onConfirm={confirmImportStems}
          onCancel={() => setImportStemsDraft(null)}
        />
      )}
    </div>
  );
};
