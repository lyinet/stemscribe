import React, { useEffect, useRef, useState } from "react";
import { Download, Share2, X } from "lucide-react";
import { recommendCapoFrets, transposeChordSymbol } from "../lib/musicTheory";
import type { ChordEvent, KeyEstimate, SongStructureSegment } from "../types/music";

interface Props {
  open: boolean;
  songName: string;
  bpm: number;
  keyEst: KeyEstimate | null;
  transposeSemitones: number;
  capoFret: number;
  chords: ChordEvent[];
  structure: SongStructureSegment[];
  scoreSummary: { accuracyPct: number; maxCombo: number; rank: string } | null;
  onClose: () => void;
}

type CardAspect = "portrait_4_5" | "landscape_16_9";

export const ShareCardModal: React.FC<Props> = ({
  open,
  songName,
  bpm,
  keyEst,
  transposeSemitones,
  capoFret,
  chords,
  structure,
  scoreSummary,
  onClose,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [aspect, setAspect] = useState<CardAspect>("portrait_4_5");

  useEffect(() => {
    if (!open || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const W = aspect === "portrait_4_5" ? 1080 : 1600;
    const H = aspect === "portrait_4_5" ? 1350 : 900;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Background gradient
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#0b1120");
    bg.addColorStop(0.55, "#172554");
    bg.addColorStop(1, "#1e1b4b");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Decorative ambient glow
    const glow = ctx.createRadialGradient(W * 0.82, H * 0.18, 20, W * 0.82, H * 0.18, 420);
    glow.addColorStop(0, "rgba(56, 189, 248, 0.28)");
    glow.addColorStop(1, "rgba(56, 189, 248, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Header badge
    ctx.fillStyle = "rgba(59, 130, 246, 0.22)";
    ctx.fillRect(72, 68, 360, 44);
    ctx.fillStyle = "#93c5fd";
    ctx.font = "600 22px -apple-system, BlinkMacSystemFont, PingFang SC, sans-serif";
    ctx.fillText("STEMSCRIBE · AI 扒带战报卡片", 92, 98);

    // Song title
    ctx.fillStyle = "#f8fafc";
    ctx.font = "800 54px -apple-system, BlinkMacSystemFont, PingFang SC, sans-serif";
    const cleanTitle = (songName || "StemScribe Studio").replace(/\.(wav|mp3|flac|m4a|ogg)$/i, "");
    ctx.fillText(cleanTitle.slice(0, 24), 72, 194);

    // Metadata pills
    const topCapo = recommendCapoFrets(chords, transposeSemitones)[0];
    const metaLine = [
      `调性 ${keyEst?.label ?? "待识别"}`,
      `${bpm.toFixed(0)} BPM`,
      capoFret > 0 ? `变调夹 ${capoFret} 品` : topCapo ? topCapo.label : "原调",
    ].join("   ·   ");
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "500 26px -apple-system, BlinkMacSystemFont, PingFang SC, sans-serif";
    ctx.fillText(metaLine, 72, 248);

    // Practice Score Card Box
    const scoreY = 296;
    ctx.fillStyle = "rgba(15, 23, 42, 0.72)";
    ctx.fillRect(72, scoreY, W - 144, 180);
    ctx.strokeStyle = "rgba(96, 165, 250, 0.45)";
    ctx.lineWidth = 2;
    ctx.strokeRect(72, scoreY, W - 144, 180);

    const acc = scoreSummary && scoreSummary.accuracyPct > 0 ? `${scoreSummary.accuracyPct.toFixed(1)}%` : "待测试";
    const rank = scoreSummary && scoreSummary.accuracyPct > 0 ? scoreSummary.rank : "★";
    const combo = scoreSummary ? `${scoreSummary.maxCombo}` : "0";

    ctx.fillStyle = "#fbbf24";
    ctx.font = "800 92px -apple-system, sans-serif";
    ctx.fillText(rank, 118, scoreY + 122);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "500 22px -apple-system, PingFang SC, sans-serif";
    ctx.fillText("音准命中率", 270, scoreY + 64);
    ctx.fillText("最高连击", 530, scoreY + 64);
    ctx.fillText("曲式段落", 740, scoreY + 64);

    ctx.fillStyle = "#ffffff";
    ctx.font = "700 42px -apple-system, sans-serif";
    ctx.fillText(acc, 270, scoreY + 124);
    ctx.fillText(combo, 530, scoreY + 124);
    ctx.fillText(`${structure.length} 段`, 740, scoreY + 124);

    // Chord Progression Grid
    const chordY = 530;
    ctx.fillStyle = "#93c5fd";
    ctx.font = "600 26px -apple-system, PingFang SC, sans-serif";
    ctx.fillText("核心和弦进行" + (capoFret > 0 ? `（变调夹 ${capoFret} 品指法）` : ""), 72, chordY);

    const uniqueChords = chords.slice(0, aspect === "portrait_4_5" ? 12 : 8);
    const cols = 4;
    const cardW = (W - 144 - (cols - 1) * 18) / cols;
    const cardH = 92;
    uniqueChords.forEach((ch, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const x = 72 + col * (cardW + 18);
      const y = chordY + 26 + row * (cardH + 16);
      const sounding = transposeChordSymbol(ch.symbol, transposeSemitones);
      const shown = capoFret > 0 ? transposeChordSymbol(sounding, -capoFret) : sounding;

      ctx.fillStyle = "rgba(30, 41, 59, 0.85)";
      ctx.fillRect(x, y, cardW, cardH);
      ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
      ctx.strokeRect(x, y, cardW, cardH);

      ctx.fillStyle = "#f8fafc";
      ctx.font = "700 34px -apple-system, sans-serif";
      ctx.fillText(shown, x + 20, y + 48);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "400 18px -apple-system, sans-serif";
      ctx.fillText(`${ch.start_sec.toFixed(0)}s – ${ch.end_sec.toFixed(0)}s`, x + 20, y + 76);
    });

    // Footer branding
    ctx.fillStyle = "#64748b";
    ctx.font = "500 22px -apple-system, PingFang SC, sans-serif";
    ctx.fillText("Powered by StemScribe for macOS (Apple Silicon CoreML) · 4 轨分轨 / 自动扒谱 / 演出提词", 72, H - 54);
  }, [open, aspect, songName, bpm, keyEst, transposeSemitones, capoFret, chords, structure, scoreSummary]);

  if (!open) return null;

  const handleDownloadPng = () => {
    if (!canvasRef.current) return;
    const url = canvasRef.current.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(songName || "stemscribe").replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_")}_share.png`;
    a.click();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 150,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 680, maxWidth: "94vw", maxHeight: "92vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <div className="card-title">
            <Share2 size={15} /> 一键生成扒带 / 练琴分享卡片（小红书 / B 站适配）
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <div className="row">
            <button
              className={`btn btn-sm ${aspect === "portrait_4_5" ? "btn-active" : ""}`}
              onClick={() => setAspect("portrait_4_5")}
            >
              4:5 竖屏（小红书/朋友圈）
            </button>
            <button
              className={`btn btn-sm ${aspect === "landscape_16_9" ? "btn-active" : ""}`}
              onClick={() => setAspect("landscape_16_9")}
            >
              16:9 横屏（B 站/YouTube 封面）
            </button>
          </div>

          <button className="btn btn-primary btn-sm" onClick={handleDownloadPng}>
            <Download size={13} /> 导出高清 PNG
          </button>
        </div>

        <div style={{ display: "flex", justifyContent: "center", background: "#090b10", padding: 12, borderRadius: 10 }}>
          <canvas
            ref={canvasRef}
            style={{
              maxWidth: "100%",
              maxHeight: "62vh",
              borderRadius: 8,
              boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
            }}
          />
        </div>
      </div>
    </div>
  );
};
