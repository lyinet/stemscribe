import React, { useEffect, useMemo, useRef, useState } from "react";
import { Command, Search, X } from "lucide-react";

export interface PaletteCommand {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

interface Props {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}

export const CommandPaletteModal: React.FC<Props> = ({ open, commands, onClose }) => {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q) ||
        (c.shortcut ?? "").toLowerCase().includes(q)
    );
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  if (!open) return null;

  const execute = (cmd: PaletteCommand | undefined) => {
    if (!cmd || cmd.disabled) return;
    onClose();
    cmd.run();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      execute(filtered[selectedIdx]);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.62)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "11vh",
        zIndex: 220,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: 580,
          maxWidth: "94vw",
          padding: 0,
          overflow: "hidden",
          boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div
          className="row"
          style={{
            padding: "12px 14px",
            borderBottom: "1px solid var(--border)",
            background: "var(--surface)",
          }}
        >
          <Search size={16} color="var(--muted)" />
          <input
            ref={inputRef}
            className="input"
            style={{ border: "none", background: "transparent", padding: "4px 6px", fontSize: 14 }}
            placeholder="搜索任意功能、视图、导出或主题（如：瀑布流、弹唱谱、MIDI、爵士）..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="badge" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
            <Command size={10} />K
          </span>
          <button className="btn btn-sm" onClick={onClose}>
            <X size={13} />
          </button>
        </div>

        <div style={{ maxHeight: 380, overflowY: "auto", padding: 8 }}>
          {filtered.length === 0 ? (
            <div className="muted" style={{ padding: "18px 12px", textAlign: "center" }}>
              未找到匹配命令，试试搜索「演示曲」「弹唱谱」「混响」或「主题」
            </div>
          ) : (
            filtered.map((cmd, idx) => (
              <div
                key={cmd.id}
                onMouseEnter={() => setSelectedIdx(idx)}
                onClick={() => execute(cmd)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "9px 12px",
                  borderRadius: 8,
                  cursor: cmd.disabled ? "not-allowed" : "pointer",
                  opacity: cmd.disabled ? 0.45 : 1,
                  background: idx === selectedIdx ? "var(--accent-soft)" : "transparent",
                  color: idx === selectedIdx ? "var(--accent)" : "var(--text)",
                  marginBottom: 2,
                }}
              >
                <div className="row" style={{ gap: 10 }}>
                  <span className="badge" style={{ fontSize: 10.5 }}>
                    {cmd.category}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: idx === selectedIdx ? 600 : 400 }}>
                    {cmd.label}
                  </span>
                </div>
                {cmd.shortcut && (
                  <span className="badge" style={{ fontFamily: "ui-monospace, monospace" }}>
                    {cmd.shortcut}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
