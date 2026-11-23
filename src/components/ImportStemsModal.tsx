import React, { useState } from "react";
import { Layers, X } from "lucide-react";
import type { ImportStemSpec } from "../types/music";

interface Props {
  paths: string[];
  /** inferred role per path: lead/backing/drums/perc/bass/other/mix */
  roles: string[];
  onConfirm: (stems: ImportStemSpec[], mixPath: string | null) => void;
  onCancel: () => void;
}

const ROLE_OPTIONS: Array<{ v: string; label: string }> = [
  { v: "lead", label: "主唱" },
  { v: "backing", label: "和声" },
  { v: "drums", label: "鼓" },
  { v: "perc", label: "打击乐" },
  { v: "bass", label: "贝斯" },
  { v: "other", label: "其他" },
  { v: "mix", label: "混音（原曲）" },
];

const fileName = (p: string) => p.split("/").pop() ?? p;

export const ImportStemsModal: React.FC<Props> = ({
  paths,
  roles,
  onConfirm,
  onCancel,
}) => {
  const [sel, setSel] = useState<string[]>(roles);
  const stemCount = sel.filter((r) => r !== "mix").length;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 110,
      }}
      onClick={onCancel}
    >
      <div
        className="card"
        style={{ width: 520, maxWidth: "92vw", maxHeight: "86vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <div className="card-title">
            <Layers size={15} /> 导入分轨（Suno 等）
          </div>
          <button className="btn btn-sm" onClick={onCancel}>
            <X size={14} />
          </button>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-3)", margin: "4px 0 10px" }}>
          已按文件名猜测每轨的角色，可在下方修改；标记为「混音（原曲）」的文件将作为修复对照原曲，
          没有提供混音时会自动把所有分轨相加作为原曲。
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {paths.map((p, i) => (
            <div
              key={p}
              className="row"
              style={{ justifyContent: "space-between", gap: 8 }}
            >
              <span
                style={{
                  fontSize: 12,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                }}
                title={p}
              >
                {fileName(p)}
              </span>
              <select
                value={sel[i]}
                onChange={(e) =>
                  setSel((prev) => prev.map((r, j) => (j === i ? e.target.value : r)))
                }
                style={{ minWidth: 110 }}
              >
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <div
          className="row"
          style={{ justifyContent: "flex-end", gap: 8, marginTop: 14 }}
        >
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={stemCount === 0}
            onClick={() => {
              const mixPath =
                paths.find((_, i) => sel[i] === "mix") ?? null;
              const stems = paths
                .map((p, i) => ({ file_path: p, role: sel[i] }))
                .filter((s) => s.role !== "mix");
              onConfirm(stems, mixPath);
            }}
          >
            导入 {stemCount} 条分轨
          </button>
        </div>
      </div>
    </div>
  );
};
