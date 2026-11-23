import React, { useMemo, useState } from "react";
import { Check, Edit3, FolderOpen, Search, Trash2, X } from "lucide-react";
import { t } from "../i18n";
import type { ProjectSummary } from "../types/music";

interface Props {
  open: boolean;
  projects: ProjectSummary[];
  onClose: () => void;
  onOpenProject: (projectId: string) => void;
  onRenameProject: (projectId: string, newName: string) => void;
  onDeleteProject: (projectId: string) => void;
}

export const ProjectLibraryModal: React.FC<Props> = ({
  open,
  projects,
  onClose,
  onOpenProject,
  onRenameProject,
  onDeleteProject,
}) => {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.updated_at.toLowerCase().includes(q)
    );
  }, [projects, query]);

  if (!open) return null;

  const commitRename = (id: string) => {
    const trimmed = draftName.trim();
    if (trimmed) {
      onRenameProject(id, trimmed);
    }
    setEditingId(null);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.68)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 120,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 640, maxWidth: "92vw", maxHeight: "82vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <div className="card-title">
            <FolderOpen size={15} /> {t("projects.title", { count: projects.length })}
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="row" style={{ marginBottom: 10 }}>
          <Search size={14} color="var(--muted)" />
          <input
            className="input"
            placeholder={t("projects.filter")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 2 }}>
          {filtered.length === 0 ? (
            <div className="muted" style={{ textAlign: "center", padding: 28 }}>
              {projects.length === 0
                ? t("projects.empty")
                : t("projects.noMatch")}
            </div>
          ) : (
            filtered.map((p) => {
              const isEditing = editingId === p.id;
              return (
                <div
                  key={p.id}
                  className="section-pill"
                  style={{
                    padding: "10px 12px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {isEditing ? (
                      <div className="row" style={{ gap: 6 }}>
                        <input
                          className="input"
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(p.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          autoFocus
                        />
                        <button className="btn btn-sm btn-primary" onClick={() => commitRename(p.id)}>
                          <Check size={12} /> {t("common.confirm")}
                        </button>
                      </div>
                    ) : (
                      <>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: 13.5,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {p.name}
                        </div>
                        <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                          {t("projects.meta", { count: p.note_count, updated: p.updated_at })}
                        </div>
                      </>
                    )}
                  </div>

                  {!isEditing && (
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => {
                          onOpenProject(p.id);
                          onClose();
                        }}
                      >
                        {t("common.open")}
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setEditingId(p.id);
                          setDraftName(p.name);
                        }}
                        title={t("projects.renameTip")}
                      >
                        <Edit3 size={12} />
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => onDeleteProject(p.id)}
                        title={t("projects.deleteTip")}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
