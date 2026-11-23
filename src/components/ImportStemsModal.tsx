import React, { useState } from "react";
import { Layers, Plus, X } from "lucide-react";
import type { ImportStemSpec } from "../types/music";

interface Props {
  paths: string[];
  /** inferred role per path: lead/backing/drums/perc/bass/other/mix */
  roles: string[];
  /** re-open the file picker to append more files; returns new paths + roles */
  onPickMore: () => Promise<{ paths: string[]; roles: string[] } | null>;
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

interface Row {
  path: string;
  role: string;
}

export const ImportStemsModal: React.FC<Props> = ({
  paths,
  roles,
  onPickMore,
  onConfirm,
  onCancel,
}) => {
  const [rows, setRows] = useState<Row[]>(
    paths.map((p, i) => ({ path: p, role: roles[i] ?? "other" }))
  );
  const [adding, setAdding] = useState(false);
  const stemCount = rows.filter((r) => r.role !== "mix").length;

  const addMore = async () => {
    setAdding(true);
    try {
      const picked = await onPickMore();
      if (picked && picked.paths.length > 0) {
        setRows((prev) => {
          const seen = new Set(prev.map((r) => r.path));
          const extra = picked.paths
            .map((p, i) => ({ path: p, role: picked.roles[i] ?? "other" }))
            .filter((r) => !seen.has(r.path));
          return [...prev, ...extra];
        });
      }
    } finally {
      setAdding(false);
    }
  };

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
          可一次多选（⌘/⇧-click）或点「继续添加」；已按文件名猜测每轨的角色，可在下方修改。
          标记为「混音（原曲）」的文件将作为修复对照原曲，没有提供混音时会自动把所有分轨相加作为原曲。
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map((r, i) => (
            <div
              key={r.path}
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
                title={r.path}
              >
                {fileName(r.path)}
              </span>
              <select
                value={r.role}
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, role: e.target.value } : x))
                  )
                }
                style={{ minWidth: 110 }}
              >
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-sm"
                title="移除该文件"
                onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <div
          className="row"
          style={{ justifyContent: "space-between", gap: 8, marginTop: 14 }}
        >
          <button className="btn btn-sm" onClick={addMore} disabled={adding}>
            <Plus size={13} /> {adding ? "选择中…" : "继续添加"}
          </button>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={onCancel}>
              取消
            </button>
            <button
              className="btn btn-primary"
              disabled={stemCount === 0}
              onClick={() => {
                const mixPath = rows.find((r) => r.role === "mix")?.path ?? null;
                const stems = rows
                  .filter((r) => r.role !== "mix")
                  .map((r) => ({ file_path: r.path, role: r.role }));
                onConfirm(stems, mixPath);
              }}
            >
              导入 {stemCount} 条分轨
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
