import React, { useState } from "react";
import { ArrowDown, ArrowUp, ListMusic, Play, Plus, Trash2, X } from "lucide-react";
import type { Setlist, SetlistItem } from "../types/music";

interface Props {
  open: boolean;
  setlists: Setlist[];
  activeSetlistId: string | null;
  canAddCurrent: boolean;
  currentSongName: string;
  onClose: () => void;
  onSaveSetlist: (setlist: Setlist) => void;
  onDeleteSetlist: (id: string) => void;
  onAddCurrentSongToSetlist: (setlist: Setlist) => void;
  onStartSetlistSong: (setlist: Setlist, index: number, openStage: boolean) => void;
}

export const SetlistModal: React.FC<Props> = ({
  open,
  setlists,
  activeSetlistId,
  canAddCurrent,
  currentSongName,
  onClose,
  onSaveSetlist,
  onDeleteSetlist,
  onAddCurrentSongToSetlist,
  onStartSetlistSong,
}) => {
  const [newName, setNewName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(activeSetlistId);

  if (!open) return null;

  const active =
    setlists.find((s) => s.id === (selectedId ?? activeSetlistId)) ?? setlists[0] ?? null;

  const handleCreate = () => {
    const trimmed = newName.trim() || `演出歌单 ${setlists.length + 1}`;
    const created: Setlist = {
      id: `setlist_${Date.now()}`,
      name: trimmed,
      updated_at: new Date().toISOString(),
      items: [],
    };
    onSaveSetlist(created);
    setSelectedId(created.id);
    setNewName("");
  };

  const moveItem = (setlist: Setlist, idx: number, dir: -1 | 1) => {
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= setlist.items.length) return;
    const copy: SetlistItem[] = [...setlist.items];
    const [picked] = copy.splice(idx, 1);
    copy.splice(nextIdx, 0, picked);
    onSaveSetlist({ ...setlist, items: copy, updated_at: new Date().toISOString() });
  };

  const removeItem = (setlist: Setlist, idx: number) => {
    const copy = setlist.items.filter((_, i) => i !== idx);
    onSaveSetlist({ ...setlist, items: copy, updated_at: new Date().toISOString() });
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
        zIndex: 140,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 720, maxWidth: "94vw", maxHeight: "86vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <div className="card-title">
            <ListMusic size={16} /> 演出歌单 / 练琴曲单（Setlist 管理）
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="row" style={{ marginBottom: 14 }}>
          <input
            className="input"
            placeholder="新建歌单名称，例如：周五 Livehouse 歌单 / 本周吉他练习..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <button className="btn btn-primary" style={{ whiteSpace: "nowrap" }} onClick={handleCreate}>
            <Plus size={14} /> 新建歌单
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "210px 1fr", gap: 14 }}>
          {/* Left: Setlist list */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {setlists.length === 0 ? (
              <div className="muted">还没有歌单，先新建一个吧。</div>
            ) : (
              setlists.map((s) => (
                <div
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 8,
                    cursor: "pointer",
                    background: active?.id === s.id ? "var(--accent-soft)" : "var(--bg)",
                    border: `1px solid ${active?.id === s.id ? "var(--accent)" : "var(--border)"}`,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</div>
                    <div className="muted" style={{ fontSize: 11 }}>{s.items.length} 首曲目</div>
                  </div>
                  <button
                    className="btn btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSetlist(s.id);
                    }}
                    title="删除歌单"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Right: Active setlist songs */}
          <div
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 12,
              minHeight: 240,
            }}
          >
            {!active ? (
              <div className="muted">请选择或新建一个歌单。</div>
            ) : (
              <>
                <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
                  <strong>{active.name}</strong>
                  <div className="row">
                    <button
                      className="btn btn-sm"
                      disabled={!canAddCurrent}
                      onClick={() => onAddCurrentSongToSetlist(active)}
                      title="自动保存当前工程并加入此歌单"
                    >
                      <Plus size={12} /> 加入当前曲目 ({currentSongName ? currentSongName.slice(0, 12) : "无"})
                    </button>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={active.items.length === 0}
                      onClick={() => onStartSetlistSong(active, 0, true)}
                    >
                      <Play size={12} /> 舞台模式连演
                    </button>
                  </div>
                </div>

                {active.items.length === 0 ? (
                  <div className="muted" style={{ marginTop: 20 }}>
                    当前歌单为空。加载任意曲目后点击右上角「加入当前曲目」，即可编排演出顺序并在全屏演出模式中一键切歌。
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {active.items.map((item, idx) => (
                      <div
                        key={`${item.project_id}_${idx}`}
                        className="row"
                        style={{
                          justifyContent: "space-between",
                          padding: "8px 10px",
                          borderRadius: 8,
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                        }}
                      >
                        <div className="row" style={{ gap: 10 }}>
                          <span className="badge">{idx + 1}</span>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{item.song_name}</div>
                            <div className="muted" style={{ fontSize: 11 }}>
                              {item.key_label} · {item.bpm.toFixed(0)} BPM
                              {item.capo_fret > 0 ? ` · Capo ${item.capo_fret}` : ""}
                            </div>
                          </div>
                        </div>

                        <div className="row">
                          <button
                            className="btn btn-sm"
                            onClick={() => onStartSetlistSong(active, idx, false)}
                            title="载入此曲目"
                          >
                            <Play size={12} />
                          </button>
                          <button
                            className="btn btn-sm"
                            disabled={idx === 0}
                            onClick={() => moveItem(active, idx, -1)}
                          >
                            <ArrowUp size={12} />
                          </button>
                          <button
                            className="btn btn-sm"
                            disabled={idx === active.items.length - 1}
                            onClick={() => moveItem(active, idx, 1)}
                          >
                            <ArrowDown size={12} />
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => removeItem(active, idx)}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
