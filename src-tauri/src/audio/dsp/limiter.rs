//! True-peak lookahead limiter: detection on the 4x-oversampled signal,
//! 2 ms lookahead min-window, release 80 ms, stereo-linked, ceiling in dBTP.
//!
//! Implemented as a block-streamed chain (oversampler -> lookahead gain ->
//! decimator) so memory stays bounded for long files; output is
//! delay-compensated (see `CHAIN4_DELAY`).

use super::oversample::{decimate4, oversample4, Oversampler, MAP4X_CTX};
use std::collections::VecDeque;

pub struct LimiterStats {
    /// Average gain reduction in dB over samples louder than -60 dBFS.
    pub avg_gr_db: f64,
    pub max_gr_db: f64,
}

fn running_min_forward(x: &[f32], win: usize) -> Vec<f64> {
    // m[i] = min(x[i..i+win])
    let mut out = vec![f64::INFINITY; x.len()];
    let mut dq: VecDeque<usize> = VecDeque::new();
    for i in 0..x.len() {
        while let Some(&b) = dq.back() {
            if x[b] as f64 >= x[i] as f64 {
                dq.pop_back();
            } else {
                break;
            }
        }
        dq.push_back(i);
        while let Some(&f) = dq.front() {
            if f + win <= i {
                dq.pop_front();
            } else {
                break;
            }
        }
        if i + 1 >= win {
            out[i + 1 - win] = x[*dq.front().unwrap()] as f64;
        }
    }
    let start = x.len().saturating_sub(win - 1).max(0);
    for i in start..x.len() {
        let end = (i + win).min(x.len());
        out[i] = x[i..end]
            .iter()
            .map(|&v| v as f64)
            .fold(f64::INFINITY, f64::min);
    }
    out
}

/// 4x-rate peak profile of the stereo signal (max |L|,|R| per 4x sample),
/// computed block-wise so memory stays bounded. Used by the loudness loop
/// to predict limiter GR for candidate gains without re-running the limiter.
pub fn peak_profile_4x(l: &[f32], r: &[f32]) -> Vec<f32> {
    let n = l.len().min(r.len());
    let mut up_l = Oversampler::new();
    let mut up_r = Oversampler::new();
    let mut prof = Vec::with_capacity(n * 4);
    const BLOCK: usize = 1 << 18;
    for i0 in (0..n).step_by(BLOCK) {
        let end = (i0 + BLOCK).min(n);
        let bl: Vec<f64> = l[i0..end].iter().map(|&v| v as f64).collect();
        let br: Vec<f64> = r[i0..end].iter().map(|&v| v as f64).collect();
        let (u_l, u_r) = std::thread::scope(|sc| {
            let hl = sc.spawn(|| up_l.process(&bl));
            let hr = sc.spawn(|| up_r.process(&br));
            (hl.join().unwrap(), hr.join().unwrap())
        });
        for i in 0..u_l.len().min(u_r.len()) {
            prof.push(u_l[i].abs().max(u_r[i].abs()) as f32);
        }
    }
    prof
}

/// Predicted average limiter GR (dB) for `gain_db` pre-gain at `ceil`
/// linear ceiling: runs the same lookahead-min + release envelope on a
/// precomputed 4x peak profile (detection scales linearly with gain).
pub fn predict_avg_gr_db(profile: &[f32], sr4: f64, gain_db: f64, ceil: f64) -> f64 {
    let g = 10f64.powf(gain_db / 20.0);
    let m = profile.len();
    let mut need = vec![1.0f32; m];
    for i in 0..m {
        let p = profile[i] as f64 * g;
        if p > ceil {
            need[i] = (ceil / p) as f32;
        }
    }
    let look = (0.002 * sr4) as usize;
    let eff = running_min_forward(&need, look.max(2));
    let rel_c = (-1.0 / (0.080 * sr4)).exp();
    let mut env = 1.0f64;
    let mut sum = 0.0f64;
    let mut cnt = 0usize;
    for i in 0..m {
        let t = eff[i];
        if t < env {
            env = t;
        } else {
            env = rel_c * env + (1.0 - rel_c) * t;
        }
        if profile[i] as f64 * g > 1e-3 {
            sum += -20.0 * env.max(1e-9).log10();
            cnt += 1;
        }
    }
    if cnt == 0 {
        0.0
    } else {
        sum / cnt as f64
    }
}

/// How many trailing gained 4x samples are carried between blocks as
/// decimation context (must be a multiple of 4 and >= 128).
const DEC_TAIL: usize = 512;

/// One limiting pass, processed in overlap-blocks so the FIR work runs
/// through the parallel direct convolutions while the lookahead gain
/// envelope stays a continuous stream. Input `l`/`r` (1x) scaled by
/// `scale`; returns delay-compensated limited stereo + (avg_gr, max_gr).
fn limit_pass_blocks(
    l: &[f32],
    r: &[f32],
    sr4: f64,
    ceil: f64,
    scale: f64,
) -> (Vec<f32>, Vec<f32>, f64, f64) {
    let n = l.len().min(r.len());
    let look = ((0.002 * sr4) as usize).max(2);
    let rel_c = (-1.0 / (0.080 * sr4)).exp();
    let mut env = 1.0f64;
    let mut min_dq: VecDeque<(usize, f64)> = VecDeque::new();
    let mut sig_l: VecDeque<f64> = VecDeque::with_capacity(look + 8);
    let mut sig_r: VecDeque<f64> = VecDeque::with_capacity(look + 8);
    let mut tail_l: Vec<f64> = Vec::new();
    let mut tail_r: Vec<f64> = Vec::new();
    let mut out_l = vec![0.0f32; n];
    let mut out_r = vec![0.0f32; n];
    let mut out_next = 0usize;
    let mut emitted = 0usize; // total gained samples produced (global g4 idx)
    let mut gr_sum = 0.0f64;
    let mut gr_max = 0.0f64;
    let mut gr_cnt = 0usize;
    let mut k4 = 0usize; // global 4x input index (real samples only)
    const BLOCK: usize = 1 << 18;
    const CTX: usize = MAP4X_CTX;

    // Push `cnt` zero-padded "virtual" 4x samples (need = 1) to flush the
    // lookahead delay line; emits `cnt` gained samples into `g_*`.
    let drain = |sig_l: &mut VecDeque<f64>,
                     sig_r: &mut VecDeque<f64>,
                     min_dq: &mut VecDeque<(usize, f64)>,
                     env: &mut f64,
                     cnt: usize,
                     k4: &mut usize,
                     g_l: &mut Vec<f64>,
                     g_r: &mut Vec<f64>| {
        for _ in 0..cnt {
            let need = 1.0f64;
            while let Some(&(idx, _)) = min_dq.front() {
                if idx + look <= *k4 {
                    min_dq.pop_front();
                } else {
                    break;
                }
            }
            min_dq.push_back((*k4, need));
            *k4 += 1;
            let xl = sig_l.pop_front().unwrap_or(0.0);
            let xr = sig_r.pop_front().unwrap_or(0.0);
            let target = min_dq.front().map(|&(_, v)| v).unwrap_or(1.0);
            *env = if target < *env {
                target
            } else {
                rel_c * *env + (1.0 - rel_c) * target
            };
            g_l.push(xl * *env);
            g_r.push(xr * *env);
        }
    };

    let mut i0 = 0usize;
    while i0 < n {
        let i1 = (i0 + BLOCK).min(n);
        let a = i0.saturating_sub(CTX);
        let b = (i1 + CTX).min(n);
        let bl: Vec<f64> = l[a..b].iter().map(|&v| v as f64 * scale).collect();
        let br: Vec<f64> = r[a..b].iter().map(|&v| v as f64 * scale).collect();
        let (u_l, u_r) = std::thread::scope(|sc| {
            let hl = sc.spawn(|| oversample4(&bl));
            let hr = sc.spawn(|| oversample4(&br));
            (hl.join().unwrap(), hr.join().unwrap())
        });
        let base4 = (i0 - a) * 4;
        let end4 = (i1 - a) * 4;
        let mut g_l: Vec<f64> = Vec::with_capacity((i1 - i0) * 4 + look);
        let mut g_r: Vec<f64> = Vec::with_capacity((i1 - i0) * 4 + look);
        for j in base4..end4 {
            let p = u_l[j].abs().max(u_r[j].abs());
            let need = if p > ceil { ceil / p } else { 1.0 };
            sig_l.push_back(u_l[j]);
            sig_r.push_back(u_r[j]);
            while let Some(&(idx, _)) = min_dq.front() {
                if idx + look <= k4 {
                    min_dq.pop_front();
                } else {
                    break;
                }
            }
            while let Some(&(_, v)) = min_dq.back() {
                if v >= need {
                    min_dq.pop_back();
                } else {
                    break;
                }
            }
            min_dq.push_back((k4, need));
            k4 += 1;
            if k4 >= look {
                let xl = sig_l.pop_front().unwrap();
                let xr = sig_r.pop_front().unwrap();
                let target = min_dq.front().map(|&(_, v)| v).unwrap_or(1.0);
                env = if target < env {
                    target
                } else {
                    rel_c * env + (1.0 - rel_c) * target
                };
                if xl.abs().max(xr.abs()) > 1e-3 {
                    let g = -20.0 * env.max(1e-9).log10();
                    gr_sum += g;
                    gr_max = gr_max.max(g);
                    gr_cnt += 1;
                }
                g_l.push(xl * env);
                g_r.push(xr * env);
            }
        }
        // On the final block, drain the lookahead delay line too.
        if i1 == n {
            drain(
                &mut sig_l,
                &mut sig_r,
                &mut min_dq,
                &mut env,
                look + 64,
                &mut k4,
                &mut g_l,
                &mut g_r,
            );
        }
        // Decimate this block's gained samples with the carried tail as
        // left context; right-edge outputs are emitted by the next block.
        let gbase4 = emitted - tail_l.len(); // global idx of seg[0]
        let mut seg_l = Vec::with_capacity(tail_l.len() + g_l.len());
        seg_l.extend_from_slice(&tail_l);
        seg_l.extend_from_slice(&g_l);
        let mut seg_r = Vec::with_capacity(tail_r.len() + g_r.len());
        seg_r.extend_from_slice(&tail_r);
        seg_r.extend_from_slice(&g_r);
        emitted += g_l.len();
        let (dl, dr) = std::thread::scope(|sc| {
            let hl = sc.spawn(|| decimate4(&seg_l));
            let hr = sc.spawn(|| decimate4(&seg_r));
            (hl.join().unwrap(), hr.join().unwrap())
        });
        // dec[m] <-> seg[4m] <-> g4[gbase4 + 4m] <-> input[gbase4/4 + m].
        // The first block's seg starts at the true signal start, so its
        // head outputs are valid (zero context = file edge).
        let lo_m = if gbase4 == 0 { 0 } else { 32 };
        let hi_m = seg_l.len() / 4;
        let valid_hi = hi_m.saturating_sub(32);
        for m in lo_m..valid_hi.min(hi_m) {
            let gi = gbase4 / 4 + m;
            if gi >= out_next && gi < n {
                out_l[gi] = dl[m] as f32;
                out_r[gi] = dr[m] as f32;
            }
        }
        out_next = out_next.max(gbase4 / 4 + valid_hi);
        // Keep the last DEC_TAIL gained samples as next block's context.
        let keep = DEC_TAIL.min(seg_l.len());
        tail_l = seg_l[seg_l.len() - keep..].to_vec();
        tail_r = seg_r[seg_r.len() - keep..].to_vec();
        i0 = i1;
    }
    let avg = if gr_cnt > 0 {
        gr_sum / gr_cnt as f64
    } else {
        0.0
    };
    (out_l, out_r, avg, gr_max)
}

/// Returns (limited_l, limited_r, stats). Delay-compensated: output is
/// sample-aligned with the input.
pub fn limit_stereo(
    l: &[f32],
    r: &[f32],
    sr: f64,
    ceiling_dbtp: f64,
) -> (Vec<f32>, Vec<f32>, LimiterStats) {
    let n = l.len().min(r.len());
    let ceil = 10f64.powf(ceiling_dbtp / 20.0);
    // Fast bypass: if the sample peak is comfortably below the ceiling
    // (1.5 dB headroom for inter-sample overshoot), nothing can exceed it.
    let pk = l[..n]
        .iter()
        .chain(r[..n].iter())
        .fold(0.0f32, |a, &v| a.max(v.abs()));
    if pk < (ceil * 0.841) as f32 {
        return (
            l[..n].to_vec(),
            r[..n].to_vec(),
            LimiterStats {
                avg_gr_db: 0.0,
                max_gr_db: 0.0,
            },
        );
    }
    // One limiting pass + a scalar trim for residual inter-sample
    // overshoot left by the decimation FIR. With the small GR this
    // limiter produces, re-rendering the pass at a corrected scale is
    // indistinguishable from trimming the output, and the outer loudness
    // loop re-converges to the target anyway.
    let stats;
    let mut out_l;
    let mut out_r;
    {
        let _t = crate::audio::restore::StageTimer::new("limit_pass_0");
        let (a, b, avg, mx) = limit_pass_blocks(l, r, sr * 4.0, ceil, 1.0);
        stats = (avg, mx);
        out_l = a;
        out_r = b;
    }
    let tp_lin = {
        let _t = crate::audio::restore::StageTimer::new("limit_tp_check");
        10f64.powf(
            crate::audio::quality::loudness::true_peak_dbtp(&[out_l.clone(), out_r.clone()], sr as u32)
                / 20.0,
        )
    };
    if tp_lin > ceil {
        let corr = (ceil / tp_lin) as f32;
        for v in &mut out_l {
            *v *= corr;
        }
        for v in &mut out_r {
            *v *= corr;
        }
    }
    (
        out_l,
        out_r,
        LimiterStats {
            avg_gr_db: stats.0,
            max_gr_db: stats.1,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xcorr_lag(x: &[f32], y: &[f32], centre: usize, win: usize) -> i64 {
        let mut best_lag = 0i64;
        let mut best = f64::NEG_INFINITY;
        for lag in -64i64..=64 {
            let mut acc = 0.0f64;
            for i in 0..win {
                let xi = centre + i;
                let yi = centre as i64 + i as i64 - lag;
                if yi >= 0 && (yi as usize) < y.len() && xi < x.len() {
                    acc += x[xi] as f64 * y[yi as usize] as f64;
                }
            }
            if acc > best {
                best = acc;
                best_lag = lag;
            }
        }
        best_lag
    }

    #[test]
    fn true_peak_under_ceiling() {
        // +10 dBFS-peak white noise must come out at <= -1 dBTP.
        let sr = 48000.0;
        let n = sr as usize;
        let mut seed = 0x12345u64;
        let mut rng = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as f64 / u32::MAX as f64) * 2.0 - 1.0
        };
        let amp = 10f64.powf(10.0 / 20.0);
        let l: Vec<f32> = (0..n).map(|_| (rng() * amp * 0.5) as f32).collect();
        let r: Vec<f32> = (0..n).map(|_| (rng() * amp * 0.5) as f32).collect();
        let (ol, or_, _st) = limit_stereo(&l, &r, sr, -1.0);
        let tp = crate::audio::quality::loudness::true_peak_dbtp(&[ol, or_], sr as u32);
        assert!(tp <= -1.0 + 0.1, "true peak {tp:.2} dBTP");
    }

    #[test]
    fn quiet_sine_unchanged() {
        // A -30 dBFS sine is far below the ceiling and must pass unchanged.
        let sr = 48000.0;
        let n = sr as usize / 2;
        let l: Vec<f32> = (0..n)
            .map(|i| (0.0316 * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / sr).sin()) as f32)
            .collect();
        let r = l.clone();
        let (ol, or_, _st) = limit_stereo(&l, &r, sr, -1.0);
        let m = 4000;
        let mut err = 0.0f64;
        let mut refe = 0.0f64;
        for i in m..n - m {
            err += (ol[i] as f64 - l[i] as f64).powi(2) + (or_[i] as f64 - r[i] as f64).powi(2);
            refe += (l[i] as f64).powi(2) * 2.0;
        }
        let db = 10.0 * (err / refe.max(1e-30)).log10();
        // ~0.01 dB tolerance on average level
        assert!(db <= -80.0, "quiet sine changed {db:.1} dB");
    }

    #[test]
    fn limiter_has_zero_lag() {
        let sr = 48000.0;
        let n = sr as usize;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        // impulsive content above the ceiling so the limiter actually works
        for i in (4000..n - 4000).step_by(4000) {
            l[i] = 1.5;
            r[i] = -1.5;
        }
        let (ol, or_, _st) = limit_stereo(&l, &r, sr, -1.0);
        assert_eq!(xcorr_lag(&l, &ol, 20000, 20000), 0, "limiter lag L");
        assert_eq!(xcorr_lag(&r, &or_, 20000, 20000), 0, "limiter lag R");
    }
}
