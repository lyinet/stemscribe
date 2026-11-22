#!/usr/bin/env bash
set -euo pipefail

# 用法 1（已安装并登录 GitHub CLI `gh`）：
#   ./scripts/push_to_github.sh stemscribe
# 用法 2（手动指定已在 GitHub 建好的公开仓库地址）：
#   ./scripts/push_to_github.sh https://github.com/<你的用户名>/<仓库名>.git

TARGET="${1:-stemscribe}"

echo "=== StemScribe 一键推送至 GitHub 公开仓库并触发 macOS 云端编译 ==="

if [[ ! -d ".git" ]]; then
  git init
fi

git branch -M main
git add .

if ! git diff --cached --quiet; then
  git commit -m "chore: publish StemScribe pre-release with GitHub Actions macOS CI"
else
  echo "[提示] 工作区没有新的待提交改动。"
fi

if [[ "$TARGET" == http* || "$TARGET" == git@* ]]; then
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$TARGET"
  else
    git remote add origin "$TARGET"
  fi
  git push -u origin main
  echo ""
  echo "=== 推送成功！请打开仓库页面的 Actions 标签页查看 Apple Silicon 云端编译进度与 .dmg 下载 ==="
  exit 0
fi

if command -v gh >/dev/null 2>&1; then
  echo "[信息] 检测到 GitHub CLI (gh)，正在创建公开仓库：$TARGET ..."
  gh repo create "$TARGET" --public --source=. --remote=origin --push
  echo ""
  echo "=== 已创建公开仓库并推送完成！请打开仓库 Actions 标签页查看自动编译进度 ==="
else
  echo "[提示] 未检测到 gh CLI。请先在 https://github.com/new 创建一个公开仓库，然后运行："
  echo "  ./scripts/push_to_github.sh https://github.com/<你的用户名>/${TARGET}.git"
  exit 1
fi
