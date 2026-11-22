import React from "react";
import { Keyboard, X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS: Array<[string, string]> = [
  ["Cmd + K", "打开全局快捷命令面板（Spotlight 模糊搜索任意功能）"],
  ["Space", "播放 / 暂停多轨音频（含 MIDI 同步试听）"],
  ["F / Esc", "进入 / 退出全屏演出提词器模式（Stage Mode）"],
  ["←  /  →（舞台模式）", "全屏演出模式下切换歌单上一首 / 下一首"],
  ["A–L / W–P（键盘弹琴）", "开启「电脑键盘弹琴」后直接演奏琴键，Z / X 切换八度"],
  ["[  /  ]", "将当前播放头设为 A-B 循环起点 / 终点"],
  ["L", "开启 / 关闭 A-B 循环"],
  ["M", "开启 / 关闭同步节拍器"],
  ["K", "在当前位置快速打段落书签"],
  ["Cmd + I", "直接导入本地 .mid 乐谱文件到瀑布流与卷帘"],
  ["Cmd + P", "打开 A4 吉他弹唱和弦谱排版 / 打印预览"],
  ["Cmd + L", "打开演出歌单 / 练琴曲单（Setlist）"],
  ["Cmd + D", "一键加载内置 4 轨交互演示曲"],
  ["Cmd + O", "导入本地音频（也支持直接从 Finder 拖入音频 / .mid / .lrc）"],
  ["Cmd + B", "打开多曲目批量分轨队列"],
  ["Cmd + S", "保存当前 .stemscribe.json 工程"],
  ["Cmd + E / Cmd + Shift + E", "导出 .mid / 一键导出 7 文件全量扒带资料包"],
  ["Cmd + Z / Cmd + Shift + Z", "钢琴卷帘修音撤销 / 重做"],
  ["Cmd + Q", "一键 1/16 拍节奏量化对齐"],
  ["?", "打开 / 关闭本快捷键速查表"],
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
            <Keyboard size={15} /> macOS 快捷键速查表
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
