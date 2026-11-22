#!/usr/bin/env bash
set -euo pipefail

VERSION=$(python3 -c 'import json; print(json.load(open("package.json"))["version"])' 2>/dev/null || echo "0.9.8")
echo "=== 构建 StemScribe v${VERSION} macOS (.app / .dmg) ==="

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[提示] 检测到当前系统不是 macOS，请在 Apple Silicon Mac 上运行本脚本以打包 .app / .dmg。"
  exit 1
fi

rustup target add aarch64-apple-darwin >/dev/null 2>&1 || true
npm install
npm run build:mac

echo ""
echo "=== 打包完成 ==="
echo "macOS 应用路径: src-tauri/target/aarch64-apple-darwin/release/bundle/macos/StemScribe.app"
echo "DMG 安装包路径: src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/"
