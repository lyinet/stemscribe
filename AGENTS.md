# StemScribe — Agent Notes

- 与用户沟通请使用中文。
- macOS Apple Silicon 桌面应用：Tauri v2 + Rust (`src-tauri/`) + React 19/TS/Vite (`src/`)。

## 常用命令

- 一键全量校验（提交前必跑）：`npm run check`
  = `verify_project.py`（静态契约检查）+ `tsc && vite build` + `cargo test`
- 前端浏览器调试（不启动 Tauri，`tauriApi.ts` 自动走 mock 数据）：`npm run dev`（端口 1420）
- 桌面端调试：`npm run tauri dev`
- 打包 .dmg：`npm run build:mac`

## 注意事项

- `verify_project.py` 只做正则/文件存在性检查，不能代替真实编译；以 `npm run check` 为准。
- `cargo test` / `tauri::generate_context!` 需要 `dist/` 已存在，先跑 `npm run build`。
- `ort` 必须精确锁定 `=2.0.0-rc.10`：rc 版本间 API 不兼容（rc.15 会产生大量编译错误）。
- `ort-sys` 构建时从 `cdn.pyke.io` 下载 ONNX Runtime，网络偶发失败时重试即可。
- 新增 Tauri 命令：`lib.rs` 写 `#[tauri::command]` 并注册到 `generate_handler!`，同时在 `src/lib/tauriApi.ts` 封装（含非 Tauri 环境 mock）。
- 新增原生菜单项：`menu.rs` 的 id 必须在 `App.tsx` 中有对应 `case "<id>":`。
- 对外版本号为四段 `0.<milestone>.<feature>.<fix>`（如 `0.10.0.0`），存放于 `package.json` 的 `displayVersion`；Cargo/npm/Tauri 需要三段 semver，故 `package.json` `version`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 同步保持前三段（如 `0.10.0`）。发版四处同步；前端版本号用 `__APP_VERSION__`（vite.config.ts 注入 displayVersion）；`verify_project.py` 校验 displayVersion 前三段与三处 semver 一致。
- 推 `v*` tag 前必须先提交 `docs/release-notes/<tag>.md`，Release 正文从这个文件读取（`body_path`），缺文件会导致发布失败。
- HTDemucs 必须走 CPU：CoreML EP 在该图上输出 NaN（静音分轨）且慢约 4 倍。Basic Pitch 输出名为 `StatefulPartitionedCall:1`(note)/`:2`(onset)/`:0`(contour)。
- 模型默认下载地址见 `src-tauri/src/ml/downloader.rs`，下载/导入后经 `validate_onnx_file` 校验。
- release 为 `panic = "unwind"`（abort 会让任何后台 panic 直接闪退），panic 写入 `~/Library/Logs/StemScribe/crash.log`。
- 模型目录：`~/Library/Application Support/StemScribe/models/`（`htdemucs.onnx`、`basic_pitch.onnx`，已被 .gitignore 忽略）。
- 本地打包 `npm run build:mac` 时 Tauri 会调用 `xattr -cr`；若 PATH 中 miniconda 的 `xattr` 抢先（不支持 `-r`），用 `PATH=/usr/bin:$PATH npm run build:mac`。
- 窗口使用 Overlay 标题栏：可拖动区域靠 `data-tauri-drag-region` 属性 + capability `core:window:allow-start-dragging`（`-webkit-app-region` 在 Tauri 中无效）。
- macOS 包为 ad-hoc 签名（`signingIdentity: "-"`，hardened runtime + `Entitlements.plist` 麦克风权限），未公证。
