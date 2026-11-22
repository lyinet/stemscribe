# StemScribe v0.9.15（Pre-Release）— macOS Apple Silicon AI 音乐扒带、成品翻唱 & 舞台工作站

StemScribe 是专为 **macOS (Apple Silicon M1/M2/M3/M4)** 打造的原生级 AI 音乐分轨、自动扒谱、伴奏叠录成品合轨、和弦智能重配与舞台连演工作站，基于 **Tauri v2 + Rust (`ort` CoreML, `midir` CoreMIDI) + React/TypeScript + VexFlow + Web Audio API** 构建。（正式发版前版本号统一保持在 `0.x.y` 预发布序列。）

## 下载安装

前往 [Releases](https://github.com/lyinet/stemscribe/releases) 下载最新 `StemScribe_*_aarch64.dmg`（macOS 13+，Apple Silicon），拖入「应用程序」。

当前为 ad-hoc 签名预发布版（未经 Apple 公证），首次打开会被拦截：
- 打开「系统设置 → 隐私与安全性」，在底部点「仍要打开」；或
- 终端执行：`xattr -d com.apple.quarantine /Applications/StemScribe.app`

## v0.9.15 更新

- 修复 v0.9.14 前端/Rust 编译错误，锁定 `ort` 版本并提交 lockfile，CI 迁移至 `macos-15`。
- macOS 整包 ad-hoc 签名 + 麦克风 entitlement，修复下载后提示「已损坏，无法打开」。

## v0.9.14 打磨亮点（MacBook 电脑键盘弹琴模式 & 曲式一键转书签）

1. **MacBook 电脑键盘直弹模式 (`LiveInstrumentView.tsx`)**
   - 灵感源自 GarageBand 音乐键入：无外接 MIDI 键盘时，一键开启「电脑键盘弹琴」，即可用 `A S D F G H J K L ;`（白键）与 `W E T Y U O P`（黑键）直接在 MacBook 键盘上实时弹奏并点亮琴键，按 `Z` / `X` 随时升降八度（聚焦输入框时自动静音不冲突）。
2. **智能曲式段落一键导入书签 (`SongStructureBar.tsx`) & 快捷键速查表同步 (`ShortcutsModal.tsx`)**
   - 自动识别前奏/主歌/副歌/桥段/尾奏后，点击「全部转为书签」一键同步到工程段落书签栏（并随工程持久化及资料包导出）；同步补齐全部最新快捷键说明。

## 推送到 GitHub 公开仓库并触发云端编译

```bash
./scripts/push_to_github.sh stemscribe
# 或指定已有公开仓库地址：
# ./scripts/push_to_github.sh https://github.com/<你的用户名>/stemscribe.git
```
