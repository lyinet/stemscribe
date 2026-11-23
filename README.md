<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="112" alt="StemScribe" />
</p>

<h1 align="center">StemScribe</h1>

<p align="center">
  <b>让 AI 生成的歌，听起来像录音棚做出来的。</b><br/>
  macOS 原生 AI 歌曲音质修复 · 智能诊断 · 分轨修复 · 母带 · 24-bit 导出，外加扒谱、和弦、练习、翻唱，全部在你的 Mac 上离线完成
</p>

<p align="center">
  <a href="https://github.com/lyinet/stemscribe/releases/latest"><img src="https://img.shields.io/github/v/release/lyinet/stemscribe?include_prereleases&label=下载&color=5b8cff&style=flat-square" alt="Release" /></a>
  <a href="https://github.com/lyinet/stemscribe/releases"><img src="https://img.shields.io/github/downloads/lyinet/stemscribe/total?style=flat-square&color=22c55e&label=下载量" alt="Downloads" /></a>
  <a href="https://github.com/lyinet/stemscribe/actions"><img src="https://img.shields.io/github/actions/workflow/status/lyinet/stemscribe/macos-build.yml?branch=main&style=flat-square&label=build" alt="Build" /></a>
  <img src="https://img.shields.io/badge/macOS-13%2B%20·%20Apple%20Silicon-111?style=flat-square&logo=apple" alt="macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/github/license/lyinet/stemscribe?style=flat-square&color=a855f7" alt="License" /></a>
  <a href="https://github.com/lyinet/stemscribe/stargazers"><img src="https://img.shields.io/github/stars/lyinet/stemscribe?style=flat-square&color=f59e0b" alt="Stars" /></a>
</p>

<p align="center">
  <a href="#下载安装">下载安装</a> ·
  <a href="#一键修复-ai-歌曲音质">一键修复</a> ·
  <a href="#功能一览">功能一览</a> ·
  <a href="#性能">性能</a> ·
  <a href="#技术架构">技术架构</a> ·
  <a href="#路线图">路线图</a> ·
  <a href="#english">English</a>
</p>

<p align="center">
  <img src="docs/screenshots/restore.png" alt="StemScribe 一键修复：诊断、频谱对比、等响度 A/B" width="100%" />
</p>

---

## 为什么是 StemScribe

Suno、MiniMax 这些 AI 生成的歌，旋律和编曲已经很好听，但一传到音乐平台、戴上耳机就露馅：高频发闷或者发金属声，低中频浑浊，动态平得像一条线，响度也不达标。专业做法是导进 DAW 分轨、逐轨处理、再做母带，要会一堆插件，一首歌要花一两个小时。

**StemScribe 把这套流程做成了一个按钮**：导入一首 AI 歌，点「一键修复」，它先诊断出具体问题，再用 AI 分轨逐轨修复、做母带，几分钟后给你一个 24-bit 的修复版，还能和原曲等响度 A/B 对比。

- **先诊断再修复**：响度、动态、真峰值、高频截止、低中频堆积、刺耳峰、立体声相位，用白话告诉你哪里有问题、修好了没有。
- **只改该改的**：成品 = 原曲 + 各轨的修改量。没处理的部分和原曲一模一样，分轨产生的瑕疵也相互抵消。
- **完全本地、免费开源**：AI 模型在你的 Mac 上运行，音频不上传；MIT 协议，没有订阅和水印。

## 一键修复 AI 歌曲音质

| 1. 导入歌曲 | 2. 一键修复 | 3. 对比并导出 |
| --- | --- | --- |
| 拖入 WAV / MP3 / FLAC / M4A，自动诊断音质问题 | AI 分轨后逐轨修复人声、鼓、贝斯、伴奏，再做母带 | 原曲和修复版等响度无缝切换、可以盲听，满意后导出 24-bit WAV |

| 处理 | 做了什么 |
| --- | --- |
| 人声 | 清理 2.5–9 kHz 刺耳共振、去齿音、跟随电平的压缩，人声更靠前 |
| 鼓 | 增强瞬态冲击力，压掉 7–16 kHz 的镲片金属声 |
| 贝斯 | 200 Hz 以下收成单声道，加谐波让小音箱也听得见 |
| 伴奏 | 挖掉浑浊的低中频、适度加宽，人声出现时在 2.5 kHz 让位 |
| 参考曲匹配（可选） | 选一首喜欢的歌，频响和立体声宽度往它靠（线性相位，最多 ±6 dB），可跟随它的响度 |
| 鼓替换（实验性） | 识别底鼓、军鼓，按原力度叠加真实原声鼓采样 |
| 母带 | 诊断出的刺耳峰定点压制并复查、粘合压缩、低频单声道、补出截止频率以上的高频、真峰值限制到 −14 LUFS / −1 dBTP |

实测（Apple M4，标准档）：

| 歌曲 | 修复前 | 修复后 |
| --- | --- | --- |
| Suno Remastered 4 分 02 秒 | −15.7 LUFS · LRA 3.6 · 2 kHz 刺耳峰 | −14.0 LUFS · LRA 4.3 · 刺耳峰消除 |
| MiniMax 3 分 28 秒（32 kHz 单声道） | −22.5 LUFS · 14 kHz 以上缺失 · 3.6 kHz 刺耳峰 +7.2 dB | −15.1 LUFS · 高频补齐 · 刺耳峰消除 |

修复一首 4 分钟的歌约 40–50 秒（不含 AI 分轨，分轨约为歌曲时长的一半到三分之二），内存峰值约 1.3 GB。

> 关于音乐平台的「录音室音质」标签：它是平台根据自己的发行渠道和处理给出的播放档位，StemScribe 没办法保证你的歌能拿到这个标签。我们能做的是把听感做好。

## 功能一览

<table>
<tr>
<td width="50%" valign="top">

### AI 4 轨分离
- 基于 Meta **HTDemucs**，分出人声、鼓组、贝斯、伴奏
- 每轨独立静音 / 独奏 / 音量，一键切换练习场景（伴奏消人声、去掉鼓、突出贝斯…）
- 分轨结果随工程保存，下次打开秒开

</td>
<td width="50%" valign="top">

### 自动扒谱
- 基于 Spotify **Basic Pitch**，任意音轨一键转 MIDI
- 钢琴卷帘修音：量化、去杂音、八度移动、撤销 / 重做
- 一键切换 **五线谱 / 吉他谱 / 简谱**，导出 MIDI、MusicXML、PDF

</td>
</tr>
<tr>
<td valign="top">

### 和弦 · 调性 · 段落
- 全曲和弦自动识别，显示级数（I–vi），附吉他指法图
- 自动识别调性、BPM、前奏 / 主歌 / 副歌 / 尾奏
- 和弦风格重配：爵士 / City Pop、民谣指弹、暗黑电影感、新手极简

</td>
<td valign="top">

### 练习模式
- 变速不变调（50%–125%）、移调 ±6 半音、A-B 循环、渐进提速
- 节拍器 + 预备拍、Synthesia 式瀑布流、交互琴键 / 吉他指板
- 实时调音器 + 麦克风 / USB-MIDI 跟弹打分，练习记录可导出

</td>
</tr>
<tr>
<td valign="top">

### 翻唱录音棚
- 消掉原唱跟伴奏叠录，可调声卡 / 耳机延迟补偿
- 合轨导出成品 WAV、循环区切片、SRT 字幕
- 一键生成小红书 / B 站分享卡片

</td>
<td valign="top">

### 舞台 & 效率
- 演出歌单（Setlist）+ 全屏提词器模式
- 多曲目批量分轨队列、本地工程库
- ⌘K 命令面板，几乎所有操作都有快捷键

</td>
</tr>
<tr>
<td valign="top">

### AI 编曲助手（可选）
- 接入任意 OpenAI 兼容的大模型服务（填自己的 API Key）
- 分析编曲结构与和声，给出练习与改编建议，AI 精修 MIDI
- 不配置也完全不影响本地功能

</td>
<td valign="top">

### 隐私与稳定
- 模型与音频全部本地处理，不上传、不追踪
- 后台任务异常只会报错，不会让 App 闪退；崩溃日志写入 `~/Library/Logs/StemScribe/`
- 模型文件下载后自动校验，坏文件不会被当成模型

</td>
</tr>
</table>

## 截图

| 多轨编排 | 乐谱 / 钢琴卷帘 |
| --- | --- |
| <img src="docs/screenshots/arrange.png" alt="多轨编排" /> | <img src="docs/screenshots/score.png" alt="乐谱与钢琴卷帘" /> |
| **混音台 & 练习场景** | **瀑布流跟弹** |
| <img src="docs/screenshots/mixer.png" alt="混音台" /> | <img src="docs/screenshots/falling.png" alt="瀑布流" /> |

## 性能

实测于 **Apple M4** 芯片的 Mac，StemScribe v0.10 正式构建：

| 任务 | 输入 | 耗时 |
| --- | --- | --- |
| 导入 + 波形 / BPM / 调性 / 段落分析 | 4 分 21 秒 MP3 | 约 1 秒 |
| AI 4 轨分离（HTDemucs） | 85 秒歌曲 | 约 1 分钟 |
| AI 4 轨分离（HTDemucs） | 4 分 02 秒歌曲 | 约 1 分 50 秒 |
| 人声转 MIDI（Basic Pitch） | 4 分 21 秒人声轨 | 4 秒（895 个音符） |
| **一键扒带全流程**（分轨 + 和弦 + 鼓点 + 转谱） | 4 分 21 秒歌曲 | **2–3.5 分钟** |
| 音质诊断 | 4 分钟 WAV | 约 1.5 秒 |
| **一键修复**（分轨后的逐轨修复 + 母带） | 4 分 02 秒歌曲 | **约 46 秒** |

> 分轨耗时约为歌曲时长的一半到三分之二，期间界面可以正常操作。安装包仅约 10 MB，AI 模型首次使用时按需下载。

## 下载安装

1. 前往 **[Releases](https://github.com/lyinet/stemscribe/releases/latest)** 下载 `StemScribe_x.y.z_aarch64.dmg`
2. 打开 dmg，把 StemScribe 拖进「应用程序」
3. 首次打开如果提示「无法验证开发者」：打开 **系统设置 → 隐私与安全性**，在页面底部点「仍要打开」
   - 或在终端执行：`/usr/bin/xattr -d com.apple.quarantine /Applications/StemScribe.app`

> 当前为预发布版，使用 ad-hoc 签名，尚未经过 Apple 公证，所以会有上面的提示。

**系统要求**：macOS 13 Ventura 及以上 · Apple Silicon（M1 / M2 / M3 / M4）· 建议 8 GB 内存以上

### 首次使用：下载 AI 模型

第一次点「AI 分轨」或「转 MIDI」时，StemScribe 会提示下载模型，点一下即可（也可在 **设置 → 本地模型** 中管理）：

| 模型 | 用途 | 大小 | 来源 | 协议 |
| --- | --- | --- | --- | --- |
| HTDemucs（4 轨） | 人声 / 鼓 / 贝斯 / 伴奏分离 | 约 166 MB | [Meta Demucs](https://github.com/facebookresearch/demucs) · [ONNX 版](https://huggingface.co/StemSplitio/htdemucs-onnx) | MIT |
| Basic Pitch | 音频转 MIDI | 约 230 KB | [Spotify Basic Pitch](https://github.com/spotify/basic-pitch) | Apache-2.0 |
| HTDemucs-FT 人声专家（可选） | 高质量分轨：人声更干净，分轨时间约 2 倍 | 约 166 MB | [Meta Demucs](https://github.com/facebookresearch/demucs) · [ONNX 版](https://huggingface.co/StemSplitio/htdemucs-ft-onnx) | MIT |

模型保存在 `~/Library/Application Support/StemScribe/models/`，下载一次后完全离线可用。网络受限时，可以用浏览器下载后在模型管理器里「从本地导入 .onnx」。

## 常用快捷键

| 操作 | 快捷键 | 操作 | 快捷键 |
| --- | --- | --- | --- |
| 一键修复音质 | `⌘ R` | 命令面板 | `⌘ K` |
| 播放 / 暂停 | `Space` | 设置 | `⌘ ,` |
| 导入音频 | `⌘ O` | 导入 MIDI | `⌘ I` |
| 保存工程 | `⌘ S` | 导出 MIDI | `⌘ E` |
| 设置循环起点 / 终点 | `[` / `]` | 添加书签 | `K` |
| 撤销 / 重做修音 | `⌘ Z` / `⇧ ⌘ Z` | 1/16 量化 | `⌘ U` |
| 演出提词器 | `F` / `⇧ ⌘ F` | 弹唱谱排版打印 | `⌘ P` |
| 全部快捷键 | `?` | | |

## 技术架构

```mermaid
flowchart LR
  subgraph UI["前端 · React 19 + TypeScript"]
    A[DAW 编排视图<br/>走带 / 音轨 / 编辑器]
    B[Web Audio 引擎<br/>多轨混音 · EQ · 混响 · 变速]
    C[VexFlow 乐谱<br/>五线谱 / 吉他谱 / 简谱]
  end
  subgraph Core["Rust 核心 · Tauri v2"]
    D[Symphonia 解码<br/>一次解码 · 全程共享]
    E[DSP 分析<br/>BPM · 调性 · 和弦 · 段落 · 鼓点]
    F[ONNX Runtime<br/>HTDemucs · Basic Pitch]
    G[工程 / MIDI / WAV 读写<br/>CoreMIDI 外接键盘]
    Q[音质诊断<br/>BS.1770 响度 · 真峰值 · 频谱]
    R[修复引擎<br/>逐轨修复 · 母带 · 限制器]
  end
  H[(可选：OpenAI 兼容大模型)]
  A <-- IPC --> D
  D --> E & F & Q
  F --> R
  Q --> R
  F --> G
  A --> B & C
  A -. 用户自配 Key .-> H
```

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Tauri v2（原生 WebKit，安装包约 10 MB） |
| 核心 | Rust 2021 · Symphonia · Hound · Rubato（sinc 重采样）· RealFFT · Midly · Midir（CoreMIDI） |
| AI 推理 | ONNX Runtime（`ort`）· HTDemucs · Basic Pitch |
| 界面 | React 19 · TypeScript · Vite · VexFlow · Lucide |
| 音频 | Web Audio API（多轨混音、EQ、卷积混响、节拍器、合成器） |
| CI / 发布 | GitHub Actions（macOS 15 arm64）自动测试、打包、发布 Release |

<details>
<summary><b>项目结构</b></summary>

```
src/                      React 前端
  components/daw/         走带栏、编排视图、混音台
  components/             乐谱、和弦、鼓组、歌词、练习、翻唱、设置等
  lib/                    IPC 封装、Web Audio 引擎、录音、乐理工具
src-tauri/src/
  audio/                  解码与 DSP 分析（BPM / 调性 / 和弦 / 段落 / 鼓点）
  audio/quality/          响度（BS.1770-4）、LRA、真峰值、频谱与音质诊断
  audio/dsp/ + restore.rs 修复引擎：EQ、动态 EQ、频谱共振抑制、压缩、饱和、激励器、真峰值限制器
  ml/                     HTDemucs 分轨、Basic Pitch 转谱、模型下载与校验
  llm/                    OpenAI 兼容大模型中转
  project/                工程、练习记录、歌单、录音存档
scripts/                  静态校验与辅助脚本
```

</details>

## 从源码构建

需要 Node.js 22+、Rust stable、Xcode Command Line Tools。

```bash
git clone https://github.com/lyinet/stemscribe.git
cd stemscribe
npm ci

npm run tauri dev      # 桌面端开发调试
npm run dev            # 只调前端（浏览器 + 模拟数据，http://localhost:1420）
npm run check          # 提交前全量校验：静态检查 + tsc + vite build + cargo test
npm run build:mac      # 打包 .app 与 .dmg（Apple Silicon）
```

> 如果 `npm run build:mac` 报 `xattr: option -r not recognized`，说明 PATH 中有 Conda 等自带的 `xattr`，改用 `PATH=/usr/bin:$PATH npm run build:mac`。

## 路线图

- [x] **v0.10 一键修复 AI 歌曲音质**：音质诊断、分轨逐轨修复、母带、等响度 A/B 与盲听、24-bit 导出
- [x] **v0.11 参考曲匹配**：选一首你喜欢的歌，把频响、响度、立体声宽度往它靠
- [x] **v0.11 鼓替换（实验性）**：识别底鼓 / 军鼓，叠加真实鼓采样（CC0 授权）
- [x] **v0.12 高质量分轨（可选）**：HTDemucs-FT 人声专家，人声更干净；评估 Apollo / UniverSR / BS-RoFormer 后暂不接入（适用性或许可证原因，见 v0.12 发布说明）
- [x] 经典 DAW 界面：走带 / 多轨编排 / 底部编辑器 / 独立设置页
- [x] 本地 HTDemucs 4 轨分离 + Basic Pitch 扒谱，模型一键下载与校验
- [x] 和弦 / 调性 / BPM / 段落识别，和弦风格重配
- [x] 练习模式：变速不变调、A-B 循环、瀑布流、跟弹打分
- [x] 翻唱叠录与合轨导出、演出歌单与提词器
- [ ] Apple 开发者签名与公证，双击即可打开
- [ ] 6 轨分离（吉他 / 钢琴单独成轨）
- [ ] 歌词自动识别与对齐（Whisper）
- [ ] 吉他六线谱（TAB）自动生成
- [ ] Apple Neural Engine 加速分轨
- [ ] 英文界面 · Intel Mac / Windows 版本

有想要的功能？欢迎在 [Issues](https://github.com/lyinet/stemscribe/issues) 里告诉我们。

## 常见问题

<details>
<summary><b>提示「已损坏，无法打开」或「无法验证开发者」？</b></summary>

这是因为预发布版还没有经过 Apple 公证。到 **系统设置 → 隐私与安全性** 点「仍要打开」，或在终端执行
`/usr/bin/xattr -d com.apple.quarantine /Applications/StemScribe.app`。
</details>

<details>
<summary><b>分轨模型下载失败 / 很慢？</b></summary>

模型托管在 Hugging Face。网络受限时，可以在模型管理器中把下载地址换成镜像地址，或用浏览器下载 `.onnx` 后点「从本地导入 .onnx」。下载的文件会自动校验，不完整或不是模型的文件会被拒绝。
</details>

<details>
<summary><b>我的音频会被上传吗？</b></summary>

不会。分轨、扒谱、和弦识别等全部在本机完成。只有你主动在设置里配置了 AI 编曲助手并点击使用时，才会把和弦 / 段落等文字信息（不含音频）发给你自己配置的大模型服务。
</details>

<details>
<summary><b>App 出问题了怎么反馈？</b></summary>

请在 [Issues](https://github.com/lyinet/stemscribe/issues) 中描述操作步骤，并附上 `~/Library/Logs/StemScribe/crash.log`（如果有）以及 ⌘K 命令面板 →「系统诊断」里一键复制的报告。
</details>

## 致谢

StemScribe 站在这些优秀开源项目的肩膀上：
[Demucs](https://github.com/facebookresearch/demucs) ·
[Basic Pitch](https://github.com/spotify/basic-pitch) ·
[ONNX Runtime](https://github.com/microsoft/onnxruntime) ·
[ort](https://github.com/pykeio/ort) ·
[Tauri](https://github.com/tauri-apps/tauri) ·
[Symphonia](https://github.com/pdeljanov/Symphonia) ·
[VexFlow](https://github.com/0xfe/vexflow) ·
[Lucide](https://github.com/lucide-icons/lucide)

鼓替换采样来自 [Big Rusty Drums](https://github.com/sfzinstruments/karoryfer.big-rusty-drums)（Karoryfer Samples, [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/)）。

## License

[MIT](LICENSE) © 2026 lyinet。HTDemucs 模型遵循 MIT 协议，Basic Pitch 模型遵循 Apache-2.0 协议，版权归各自作者所有。

如果 StemScribe 帮你扒到了想弹的那首歌，**点个 Star** 就是对我们最大的鼓励。

[![Star History Chart](https://api.star-history.com/svg?repos=lyinet/stemscribe&type=Date)](https://star-history.com/#lyinet/stemscribe&Date)

---

## English

**StemScribe** is a native macOS (Apple Silicon) app that makes AI-generated songs (Suno, MiniMax, …) sound closer to a studio production — fully offline.

- **One-click restoration**: diagnoses loudness, dynamics, true peak, HF cutoff, low-mid build-up, harsh resonances and stereo issues; separates stems and repairs each one (vocal resonance/de-ess, drum transients and cymbal shimmer, bass mono, muddy backing), then masters to −14 LUFS / −1 dBTP with HF restoration above the detected cutoff. Output = original + per-stem changes, so untouched content stays bit-identical. Loudness-matched A/B with blind mode, 24-bit export.

- **4-stem separation** (vocals / drums / bass / other) with Meta's HTDemucs, running locally via ONNX Runtime
- **Audio-to-MIDI transcription** with Spotify's Basic Pitch, with piano-roll editing and score / guitar / numbered-notation export (MIDI, MusicXML, PDF)
- **Chord, key, tempo and song-structure detection**, chord re-harmonization in several styles
- **Practice tools**: time-stretch without pitch change, transpose, A-B loop, progressive speed-up, falling notes, tuner and play-along scoring via mic or USB-MIDI
- **Cover studio**: record over the instrumental and export a mixed WAV; setlists and a full-screen prompter for live shows
- Classic DAW layout (transport · tracks · editor), built with Tauri v2 + Rust + React. ~10 MB installer, MIT licensed.

Download the latest `.dmg` from [Releases](https://github.com/lyinet/stemscribe/releases/latest) (macOS 13+, Apple Silicon). The UI is currently in Chinese; English localization is on the roadmap.
