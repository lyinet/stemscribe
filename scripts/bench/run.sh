#!/usr/bin/env bash
# StemScribe 性能/质量回归基准。
#
# 本地运行：  npm run bench
# CI 运行：   由 .github/workflows/bench.yml 调用。
#
# 生成：
#   bench-results.json   全部指标与门禁结果
#   bench-summary.md     Markdown 表格（CI 下追加到 job summary）
# 退出码：   任一门禁失败时非零。
set -euo pipefail
cd "$(dirname "$0")/../.."

BASELINE="${BENCH_BASELINE:-scripts/bench/baseline.json}"

cargo build --release --manifest-path src-tauri/Cargo.toml --example bench

cargo run --release --manifest-path src-tauri/Cargo.toml --example bench -- \
  --dir target/bench \
  --json bench-results.json \
  --md bench-summary.md \
  ${BASELINE:+--baseline "$BASELINE"}

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat bench-summary.md >> "$GITHUB_STEP_SUMMARY"
fi
