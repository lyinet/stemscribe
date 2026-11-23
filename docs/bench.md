# 性能 & 质量回归基准（bench）

StemScribe 在 CI 上运行的回归基准：对修复引擎（`run_restore`）做端到端的性能与质量度量，任何指标超出门禁都会让 job 失败。目标是自动拦截"变慢 2x"或"听感变差"这类静默回归。

## 运行方式

- 本地：`npm run bench`（等价于 `bash scripts/bench/run.sh`）
- CI：`.github/workflows/bench.yml`，在 `pull_request` 与 `push` 到 `main` 时运行于 `macos-14`（Apple Silicon），release 构建，约 1 分钟内完成基准本身。

## 测试素材

不下载任何受版权保护的音频。`src-tauri/examples/bench.rs` 用固定种子的 xorshift64* RNG 确定性合成 3 段 90 秒、48 kHz 立体声"歌曲"：鼓（kick/snare/hat）、贝斯、和弦进行（Am–F–C–G，96 BPM）与共振峰合成人声。每段同时写成 4 条 stem WAV，走 stems 路径，因此不依赖 HTDemucs 模型。

每段注入一个已知缺陷：

| clip | 缺陷 |
|---|---|
| `a_resonance_quiet` | 人声 +6 dB @ 3.5 kHz 共振峰突起 + 整段 -20 LUFS |
| `b_dark_muddy` | 14 kHz 砖墙低通 + 300 Hz 低中频 +4 dB |
| `c_clipped_flat` | 硬削波 + 过压缩（LRA < 3） |

## 指标（每段）

墙面时间、峰值 RSS（`getrusage`）、修复前后 integrated LUFS / true peak / LRA、客观评分 S 及其分项、修复前后 issue 列表、2–8 kHz 响度归一化 presence 差。

结果写入 `bench-results.json`；Markdown 表格写入 `bench-summary.md`，CI 下追加到 `GITHUB_STEP_SUMMARY` 并作为 artifact 上传。

## 门禁（任一失败则 job 失败）

- 时间 > 已提交基线（`scripts/bench/baseline.json`）的 1.5x
- 输出 true peak > -0.9 dBTP
- 响度未达到目标（每段按缺陷类型判定：strict ±0.5 LU 或显著的响度恢复——引擎为保护动态会主动停在目标以下，见 `restore.rs` 的 GR backoff 注释）
- 注入的缺陷未被修复（每段的 defect check 列表）
- 修复引入了输入没有的新 warn/bad issue
- presence 损失 > 1 dB（输入在该频段被诊断出 harsh issue 时豁免）

## 更新基线

`baseline.json` 记录的是 macos-14 runner 上的墙面时间。有意改动引擎性能后，在 macOS（Apple Silicon）上重新记录：

```bash
cargo run --release --manifest-path src-tauri/Cargo.toml --example bench -- \
  --write-baseline scripts/bench/baseline.json
```

并把更新后的 `baseline.json` 随 PR 提交。不要在本机（如 Intel 或非 macOS）生成的数字上更新基线。

## 常用参数

```
bench --dir <输出目录> --json <results.json> --md <summary.md> \
      --baseline <baseline.json> --write-baseline <path> --clip <name>
```

`--clip` 只跑一段，便于调试。
