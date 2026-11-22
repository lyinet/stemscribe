#!/usr/bin/env bash
set -euo pipefail

echo "=== StemScribe macOS 开发环境检查 ==="

for cmd in cargo rustc node npm xcode-select; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[缺失] 未检测到 $cmd，请先安装对应工具链。"
    exit 1
  fi
done

echo "[OK] Rust: $(rustc --version)"
echo "[OK] Node: $(node --version)"

echo ">>> 安装前端依赖..."
npm install

echo ">>> 检查完成！接下来你可以："
echo "  1. 运行模型导出脚本: python3 scripts/export_models_onnx.py"
echo "  2. 启动 macOS 开发模式: npm run tauri dev"
echo "  3. 仅预览前端交互界面: npm run dev"
