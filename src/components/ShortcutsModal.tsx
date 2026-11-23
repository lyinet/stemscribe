import React from "react";
import { t } from "../i18n";
import { Keyboard, X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS: Array<[string, string]> = [
  ["Cmd + K", t("shortcut.cmdk")],
  ["Space", t("shortcut.space")],
  ["F / Esc", t("shortcut.stage")],
  [t("shortcut.k.arrows"), t("shortcut.stageNav")],
  [t("shortcut.k.keys"), t("shortcut.keyplay")],
  ["[  /  ]", t("shortcut.abMark")],
  ["L", t("shortcut.abToggle")],
  ["M", t("shortcut.metro")],
  ["K", t("shortcut.bookmark")],
  ["Cmd + I", t("shortcut.importMidi")],
  ["Cmd + P", t("shortcut.leadsheet")],
  ["Cmd + L", t("shortcut.setlist")],
  ["Cmd + D", t("shortcut.demo")],
  ["Cmd + O", t("shortcut.import")],
  ["Cmd + B", t("shortcut.batch")],
  ["Cmd + S", t("shortcut.save")],
  ["Cmd + E / Cmd + Shift + E", t("shortcut.export")],
  ["Cmd + Z / Cmd + Shift + Z", t("shortcut.undo")],
  ["Cmd + U", t("shortcut.quantize")],
  ["Cmd + ,", t("shortcut.settings")],
  [t("shortcut.k.drag"), t("shortcut.selectLoop")],
  ["?", t("shortcut.cheatsheet")],
];

export const ShortcutsModal: React.FC<Props> = ({ open, onClose }) => {
  if (!open) return null;

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
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 560, maxWidth: "92vw", maxHeight: "86vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <div className="card-title">
            <Keyboard size={15} /> {t("shortcut.title")}
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {SHORTCUTS.map(([keys, desc]) => (
            <div
              key={keys}
              className="row"
              style={{
                justifyContent: "space-between",
                padding: "6px 10px",
                borderRadius: 8,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                fontSize: 12.5,
              }}
            >
              <span className="badge" style={{ fontFamily: "ui-monospace, monospace" }}>
                {keys}
              </span>
              <span className="muted" style={{ color: "var(--text)" }}>
                {desc}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
