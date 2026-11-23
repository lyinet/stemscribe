//! Full-song audio quality diagnosis: loudness, spectral, stereo and
//! clipping stats, plus heuristic issue detection for AI-generated songs.

use super::loudness;
use super::spectrum::{self, BandLevel};
use crate::audio::decode_audio_file;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub id: String,
    pub severity: String, // "ok" | "warn" | "bad"
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarshPeak {
    pub hz: f32,
    pub excess_db: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QualityReport {
    pub sample_rate: u32,
    pub channels: usize,
    pub bit_depth: Option<u16>,
    pub duration_sec: f64,
    pub integrated_lufs: f64,
    pub lra_lu: f64,
    pub true_peak_dbtp: f64,
    pub sample_peak_dbfs: f64,
    pub cutoff_hz: Option<f32>,
    pub low_mid_excess_db: f32,
    pub low_mid_center_hz: f32,
    pub harsh_peaks: Vec<HarshPeak>,
    pub stereo_correlation: f32,
    pub side_mid_ratio_db: f32,
    pub low_band_correlation: f32,
    pub clipped_runs: usize,
    pub dc_offset: [f32; 2],
    pub ltas: Vec<BandLevel>,
    pub issues: Vec<Issue>,
}

/// Per-band residual (level minus fitted line, dB) for every 200-500 Hz
/// 1/6-octave band — used by the restore closed loop to cut each bump.
pub(crate) fn low_mid_residuals(ltas: &[BandLevel]) -> Vec<(f32, f32)> {
    let fit_band = |lo_f: f32, hi_f: f32| -> Vec<(f64, f64)> {
        ltas.iter()
            .filter(|b| b.hz >= lo_f && b.hz < hi_f)
            .map(|b| ((b.hz as f64).log2(), b.db as f64))
            .collect()
    };
    let mut pts = fit_band(100.0, 200.0);
    pts.extend(fit_band(500.0, 1000.0));
    let mut out = Vec::new();
    if pts.len() >= 2 {
        let np = pts.len() as f64;
        let sx: f64 = pts.iter().map(|p| p.0).sum();
        let sy: f64 = pts.iter().map(|p| p.1).sum();
        let sxx: f64 = pts.iter().map(|p| p.0 * p.0).sum();
        let sxy: f64 = pts.iter().map(|p| p.0 * p.1).sum();
        let denom = np * sxx - sx * sx;
        if denom.abs() > 1e-9 {
            let slope = (np * sxy - sx * sy) / denom;
            let intercept = (sy - slope * sx) / np;
            for b in ltas.iter().filter(|b| b.hz >= 200.0 && b.hz < 500.0) {
                out.push((b.hz, (b.db as f64 - (slope * (b.hz as f64).log2() + intercept)) as f32));
            }
        }
    }
    out
}

/// Low-mid excess + harsh-peak heuristics on a 1/6-octave LTAS, shared by
/// `analyze_quality` and the restore engine's closed-loop EQ stage.
/// Returns (low_mid_excess_db, low_mid_center_hz, harsh_peaks).
pub(crate) fn band_heuristics(ltas: &[BandLevel]) -> (f32, f32, Vec<HarshPeak>) {
    // Low-mid excess: straight line (dB vs log2 f) fitted on 100-200 & 500-1000
    // bands, excess = max over 200-500 bands of (level - line).
    let residuals = low_mid_residuals(ltas);
    let mut low_mid_excess_db = 0.0f32;
    let mut low_mid_center_hz = 0.0f32;
    for (hz, resid) in &residuals {
        if *resid > low_mid_excess_db {
            low_mid_excess_db = *resid;
            low_mid_center_hz = *hz;
        }
    }

    // Harsh peaks: 2-8 kHz LTAS minus its 1-octave moving average.
    let harsh_bands: Vec<BandLevel> = ltas
        .iter()
        .filter(|b| b.hz >= 2000.0 && b.hz < 8000.0)
        .cloned()
        .collect();
    let mut harsh_peaks: Vec<HarshPeak> = Vec::new();
    for (i, b) in harsh_bands.iter().enumerate() {
        // 1-octave moving average centred on the band (±3 sixth-octave steps,
        // clamped inside the 2-8k window).
        let lo_i = i.saturating_sub(3);
        let hi_i = (i + 3).min(harsh_bands.len() - 1);
        let avg = mean_db(harsh_bands[lo_i..=hi_i].iter().map(|bb| bb.db as f64)) as f32;
        let excess = b.db - avg;
        if excess >= 2.5 {
            harsh_peaks.push(HarshPeak {
                hz: b.hz,
                excess_db: excess,
            });
        }
    }
    harsh_peaks.sort_by(|a, b| b.excess_db.total_cmp(&a.excess_db));
    harsh_peaks.truncate(4);
    harsh_peaks.sort_by(|a, b| a.hz.total_cmp(&b.hz));
    (low_mid_excess_db, low_mid_center_hz, harsh_peaks)
}

fn issue(id: &str, severity: &str, title: impl Into<String>, detail: impl Into<String>) -> Issue {
    Issue {
        id: id.to_string(),
        severity: severity.to_string(),
        title: title.into(),
        detail: detail.into(),
    }
}

/// Container-declared bit depth (None for lossy codecs).
fn container_bit_depth(path: &str) -> Option<u16> {
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    let file = std::fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .ok()?;
    let track = probed
        .format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)?;
    track.codec_params.bits_per_sample.map(|b| b as u16)
}

/// Mean power level (dB) of 500-Hz bins from `from_hz` to Nyquist, per bin.
fn bins_500hz(psd: &[f64], rate: u32, from_hz: f64) -> Vec<(f64, f64)> {
    let n = psd.len().saturating_sub(1).max(1) * 2;
    let bin_hz = rate as f64 / n as f64;
    let nyquist = rate as f64 / 2.0;
    let mut out = Vec::new();
    let mut lo = from_hz;
    while lo < nyquist {
        let hi = (lo + 500.0).min(nyquist);
        let mut sum = 0.0f64;
        let mut cnt = 0usize;
        let mut b = (lo / bin_hz).ceil() as usize;
        if b == 0 {
            b = 1;
        }
        while b < psd.len() && (b as f64) * bin_hz < hi {
            sum += psd[b];
            cnt += 1;
            b += 1;
        }
        let db = if cnt > 0 && sum > 0.0 {
            10.0 * (sum / cnt as f64).log10()
        } else {
            -160.0
        };
        out.push((lo, db));
        lo += 500.0;
    }
    out
}

fn mean_db(vals: impl Iterator<Item = f64>) -> f64 {
    let (s, n) = vals.fold((0.0, 0usize), |(s, n), v| (s + v, n + 1));
    if n == 0 {
        -160.0
    } else {
        s / n as f64
    }
}

/// 4th-order Butterworth low-pass via two cascaded biquads.
fn butter_lowpass(x: &[f32], rate: u32, cutoff: f64) -> Vec<f32> {
    let qs = [0.541196100146197f64, 1.306562964876377f64];
    let mut cur: Vec<f64> = x.iter().map(|&v| v as f64).collect();
    for &q in &qs {
        let w = 2.0 * std::f64::consts::PI * cutoff / rate as f64;
        let cw = w.cos();
        let sw = w.sin();
        let alpha = sw / (2.0 * q);
        let a0 = 1.0 + alpha;
        let b0 = (1.0 - cw) / 2.0 / a0;
        let b1 = (1.0 - cw) / a0;
        let b2 = b0;
        let a1 = -2.0 * cw / a0;
        let a2 = (1.0 - alpha) / a0;
        let mut y = Vec::with_capacity(cur.len());
        let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
        for &x0 in &cur {
            let y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            y.push(y0);
            x2 = x1;
            x1 = x0;
            y2 = y1;
            y1 = y0;
        }
        cur = y;
    }
    cur.into_iter().map(|v| v as f32).collect()
}

fn correlation(a: &[f32], b: &[f32]) -> f64 {
    let n = a.len().min(b.len());
    if n == 0 {
        return 0.0;
    }
    let (mut sa, mut sb, mut sab, mut sa2, mut sb2) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for i in 0..n {
        let x = a[i] as f64;
        let y = b[i] as f64;
        sa += x;
        sb += y;
        sab += x * y;
        sa2 += x * x;
        sb2 += y * y;
    }
    let nf = n as f64;
    let num = sab - sa * sb / nf;
    let den = ((sa2 - sa * sa / nf) * (sb2 - sb * sb / nf)).sqrt();
    if den <= 1e-12 {
        1.0
    } else {
        (num / den).clamp(-1.0, 1.0)
    }
}

pub fn analyze_quality(path: &str) -> Result<QualityReport> {
    let decoded = decode_audio_file(path)?;
    let rate = decoded.sample_rate;
    let nch = decoded.channels.max(1);
    let is_mono = nch == 1;
    let (left, right) = decoded.to_stereo_planar();
    let frames = left.len().min(right.len());
    let duration_sec = frames as f64 / rate as f64;
    let channels: Vec<Vec<f32>> = if is_mono {
        vec![left.clone()]
    } else {
        vec![left.clone(), right.clone()]
    };

    // --- Loudness / LRA / peaks ---
    let integrated_lufs = loudness::integrated_lufs(&channels, rate);
    let lra_lu = loudness::loudness_range_lu(&channels, rate);
    let true_peak_dbtp = loudness::true_peak_dbtp(&channels, rate);
    let sample_peak_dbfs = loudness::sample_peak_dbfs(&channels);

    // --- Spectrum ---
    let mid: Vec<f32> = (0..frames)
        .map(|i| 0.5 * (left[i] + right[i]))
        .collect();
    let psd = spectrum::welch_psd(&mid, rate);
    let ltas = spectrum::sixth_octave_bands(&psd, rate);

    // Cutoff: 500-Hz bins 4 kHz..Nyquist; ref = mean level of 4-8 kHz bins.
    let bins = bins_500hz(&psd, rate, 4000.0);
    let ref_db = mean_db(
        bins.iter()
            .filter(|(lo, _)| *lo >= 4000.0 && *lo < 8000.0)
            .map(|(_, db)| *db),
    );
    let hi_bins: Vec<(f64, f64)> = bins.iter().copied().filter(|(lo, _)| *lo >= 8000.0).collect();
    let mut cutoff_hz: Option<f32> = None;
    for (idx, (lo, db)) in hi_bins.iter().enumerate() {
        if *db < ref_db - 40.0 && hi_bins[idx..].iter().all(|(_, d)| *d < ref_db - 40.0) {
            cutoff_hz = Some(*lo as f32);
            break;
        }
    }

    let (low_mid_excess_db, low_mid_center_hz, harsh_peaks) = band_heuristics(&ltas);

    // --- Stereo stats ---
    let stereo_correlation = if is_mono {
        1.0f32
    } else {
        correlation(&left[..frames], &right[..frames]) as f32
    };
    let side_mid_ratio_db = if is_mono {
        -60.0f32
    } else {
        let mut mid_e = 0.0f64;
        let mut side_e = 0.0f64;
        for i in 0..frames {
            let m = (left[i] as f64 + right[i] as f64) * 0.5;
            let s = (left[i] as f64 - right[i] as f64) * 0.5;
            mid_e += m * m;
            side_e += s * s;
        }
        (10.0 * (side_e / mid_e.max(1e-12)).log10()).clamp(-60.0, 60.0) as f32
    };
    let low_band_correlation = if is_mono {
        1.0f32
    } else {
        let ll = butter_lowpass(&left[..frames], rate, 120.0);
        let lr = butter_lowpass(&right[..frames], rate, 120.0);
        correlation(&ll, &lr) as f32
    };

    // --- Clipping / DC ---
    let mut clipped_runs = 0usize;
    for ch in [&left[..frames], &right[..frames]] {
        let mut run = 0usize;
        for &s in ch.iter() {
            if s.abs() >= 0.999 {
                run += 1;
            } else {
                if run >= 3 {
                    clipped_runs += 1;
                }
                run = 0;
            }
        }
        if run >= 3 {
            clipped_runs += 1;
        }
    }
    let dc_l = left[..frames].iter().map(|&v| v as f64).sum::<f64>() / frames.max(1) as f64;
    let dc_r = right[..frames].iter().map(|&v| v as f64).sum::<f64>() / frames.max(1) as f64;
    let dc_offset = [dc_l as f32, dc_r as f32];

    // --- Issues ---
    let mut issues = Vec::new();
    if let Some(cut) = cutoff_hz {
        if cut < 18_000.0 {
            let sev = if cut < 14_000.0 { "bad" } else { "warn" };
            issues.push(issue(
                "hf_cutoff",
                sev,
                format!("高频在 {:.1} kHz 以上缺失", cut / 1000.0),
                format!("4–8 kHz 参考电平 {:+.0} dB，{:.1} kHz 以上跌落超 40 dB，疑似低码率/窄带重采样", ref_db, cut / 1000.0),
            ));
        }
    }
    if low_mid_excess_db >= 2.0 {
        let sev = if low_mid_excess_db >= 4.0 { "bad" } else { "warn" };
        issues.push(issue(
            "low_mid_excess",
            sev,
            format!("低中频偏多约 +{:.0} dB（约 {:.0} Hz）", low_mid_excess_db, low_mid_center_hz),
            "200–500 Hz 相对整体频谱斜率隆起，声音容易发闷、发浑".to_string(),
        ));
    }
    if !harsh_peaks.is_empty() {
        let worst = harsh_peaks
            .iter()
            .map(|p| p.excess_db)
            .fold(0.0f32, f32::max);
        let sev = if worst >= 4.0 { "bad" } else { "warn" };
        issues.push(issue(
            "harsh_peaks",
            sev,
            format!(
                "2–8 kHz 存在刺耳峰（最强 {:.1} kHz +{:.1} dB）",
                harsh_peaks[0].hz / 1000.0,
                worst
            ),
            harsh_peaks
                .iter()
                .map(|p| format!("{:.1} kHz +{:.1} dB", p.hz / 1000.0, p.excess_db))
                .collect::<Vec<_>>()
                .join("，"),
        ));
    }
    if is_mono {
        issues.push(issue(
            "mono",
            "ok",
            "单声道",
            "文件只有一条声道，立体声/低频相关性指标不适用".to_string(),
        ));
    } else if low_band_correlation < 0.7 {
        issues.push(issue(
            "low_band_corr",
            "warn",
            "低频立体声相关性偏低",
            format!("120 Hz 以下 L/R 相关性 {:.2}，低频可能发散、在单声道回放中抵消", low_band_correlation),
        ));
    }
    if clipped_runs > 0 {
        issues.push(issue(
            "clipping",
            "warn",
            format!("检测到 {} 段削波", clipped_runs),
            "存在连续 3 个及以上样本达到满幅，可能已有不可恢复的失真".to_string(),
        ));
    }
    if dc_offset.iter().any(|v| v.abs() > 0.001) {
        issues.push(issue(
            "dc_offset",
            "warn",
            "存在直流偏移",
            format!("L {:+.4} / R {:+.4}，会损失动态余量", dc_offset[0], dc_offset[1]),
        ));
    }
    if true_peak_dbtp > -1.0 {
        issues.push(issue(
            "true_peak",
            "warn",
            format!("真峰值过高（{:.1} dBTP）", true_peak_dbtp),
            "编码为有损格式时可能产生过载失真，建议留 ≥1 dB 余量".to_string(),
        ));
    }
    if lra_lu > 0.0 && lra_lu < 5.0 {
        issues.push(issue(
            "lra_flat",
            "warn",
            format!("动态偏平（LRA {:.1} LU）", lra_lu),
            "响度起伏小，音乐听起来容易僵硬、缺乏呼吸感".to_string(),
        ));
    }

    Ok(QualityReport {
        sample_rate: rate,
        channels: nch,
        bit_depth: container_bit_depth(path),
        duration_sec,
        integrated_lufs,
        lra_lu,
        true_peak_dbtp,
        sample_peak_dbfs,
        cutoff_hz,
        low_mid_excess_db,
        low_mid_center_hz,
        harsh_peaks,
        stereo_correlation,
        side_mid_ratio_db,
        low_band_correlation,
        clipped_runs,
        dc_offset,
        ltas,
        issues,
    })
}
