//! Feed-forward compressor and dynamic EQ band (dB-domain gain computers,
//! f64 internals).

/// Peak-envelope detector with attack/release smoothing.
pub struct Env {
    atk: f64,
    rel: f64,
    y: f64,
}

impl Env {
    pub fn new(sr: f64, attack_ms: f64, release_ms: f64) -> Self {
        Self {
            atk: (-1.0 / (attack_ms.max(0.01) * sr / 1000.0)).exp(),
            rel: (-1.0 / (release_ms.max(1.0) * sr / 1000.0)).exp(),
            y: 0.0,
        }
    }
    #[inline]
    pub fn tick(&mut self, x: f64) -> f64 {
        let c = if x > self.y { self.atk } else { self.rel };
        self.y = c * self.y + (1.0 - c) * x;
        self.y
    }
}

fn db(x: f64) -> f64 {
    20.0 * x.max(1e-9).log10()
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CompStats {
    pub gr_avg_db: f64,
    pub gr_median_db: f64,
    pub gr_max_db: f64,
    /// RMS level (dBFS) over active frames (> -50 dBFS).
    pub active_rms_dbfs: f64,
}

pub struct Compressor {
    threshold_db: f64,
    /// When set, the per-sample threshold is `slow_env_db + offset` where
    /// `slow_env` is a trailing 3 s RMS envelope of the detector signal —
    /// the compressor then shapes micro-dynamics without flattening
    /// macro-dynamic sections.
    track_offset: Option<f64>,
    track_win: usize,
    ratio: f64,
    knee_db: f64,
    max_gr_db: f64,
    /// Peak-hold detector state (instant attack, release decay).
    det_env: f64,
    det_rel: f64,
}

impl Compressor {
    /// The returned `Env` is the GR attack/release ballistics state; pass an
    /// external detector via `process`'s `det` argument for sidechain use.
    pub fn new(
        sr: f64,
        threshold_db: f64,
        ratio: f64,
        knee_db: f64,
        attack_ms: f64,
        release_ms: f64,
        max_gr_db: f64,
    ) -> (Self, Env) {
        (
            Self {
                threshold_db,
                track_offset: None,
                track_win: 0,
                ratio,
                knee_db,
                max_gr_db,
                det_env: 0.0,
                det_rel: (-1.0 / (release_ms.max(1.0) * sr / 1000.0)).exp(),
            },
            Env::new(sr, attack_ms, release_ms),
        )
    }

    /// Level-relative variant: threshold(t) = slow 3 s RMS envelope of the
    /// detector + `offset_db`.
    pub fn new_tracking(
        sr: f64,
        offset_db: f64,
        ratio: f64,
        knee_db: f64,
        attack_ms: f64,
        release_ms: f64,
        max_gr_db: f64,
    ) -> (Self, Env) {
        let (mut c, e) = Self::new(sr, 0.0, ratio, knee_db, attack_ms, release_ms, max_gr_db);
        c.track_offset = Some(offset_db);
        c.track_win = (3.0 * sr) as usize;
        (c, e)
    }

    fn gain_computer(&self, level_db: f64, thr_db: f64) -> f64 {
        let over = level_db - thr_db;
        let knee = self.knee_db.max(0.0);
        let gr = if knee > 0.0 && over.abs() <= knee / 2.0 {
            let t = over + knee / 2.0;
            (1.0 - 1.0 / self.ratio) * t * t / (2.0 * knee)
        } else if over > 0.0 {
            over * (1.0 - 1.0 / self.ratio)
        } else {
            0.0
        };
        gr.min(self.max_gr_db).max(0.0)
    }

    /// Stereo-linked compress. `det` = external detector signal (or None ->
    /// use the signal itself). Returns (out_l, out_r, stats).
    pub fn process(
        &mut self,
        env: &mut Env,
        l: &[f32],
        r: &[f32],
        det: Option<(&[f32], &[f32])>,
    ) -> (Vec<f32>, Vec<f32>, CompStats) {
        let n = l.len().min(r.len());
        let (dl, dr) = det.unwrap_or((l, r));
        let mut out_l = Vec::with_capacity(n);
        let mut out_r = Vec::with_capacity(n);
        let mut grs = Vec::with_capacity(n / 16);
        let mut active_e = 0.0f64;
        let mut active_n = 0usize;
        let mut gr_sum = 0.0f64;
        let mut gr_max = 0.0f64;
        let mut gr_cnt = 0usize;
        // Trailing 3 s RMS envelope of the detector (per-sample dB level),
        // used as the level-relative threshold base when tracking is on.
        // The window is causal (trailing), so the threshold is evaluated
        // inline in the main loop — every 32nd sample, held in between
        // (error << 0.01 dB over 32 samples).
        let track_w = self.track_win.max(1);
        let mut track_acc = 0.0f64;
        let mut track_cnt = 0usize;
        let mut track_thr = 0.0f64;
        // -50 dBFS activity gate in the power domain — no log per sample.
        let active_gate = 10f64.powf(-50.0 / 10.0);
        // Detector level in dB tracked incrementally: between attacks the
        // envelope decays by a constant ratio, so its dB level moves by a
        // constant per sample. A log10 is only needed on attack resets.
        let det_rel_db = db(self.det_rel);
        let mut det_db = db(self.det_env);
        for i in 0..n {
            let x = dl[i].abs().max(dr[i].abs()) as f64;
            // Peak-hold detector (instant attack, release decay) reads the
            // signal's peak amplitude; GR then gets attack/release ballistics.
            self.det_env = self.det_env * self.det_rel;
            det_db += det_rel_db;
            if x > self.det_env {
                self.det_env = x;
                det_db = db(x);
            }
            let thr = if let Some(off) = self.track_offset {
                let s = (dl[i] as f64 * dl[i] as f64 + dr[i] as f64 * dr[i] as f64) * 0.5;
                track_acc += s;
                track_cnt += 1;
                if track_cnt > track_w {
                    let s0 = (dl[i - track_w] as f64 * dl[i - track_w] as f64
                        + dr[i - track_w] as f64 * dr[i - track_w] as f64)
                        * 0.5;
                    track_acc -= s0;
                    track_cnt -= 1;
                }
                if i % 32 == 0 {
                    let mean = (track_acc / track_cnt as f64).max(1e-20);
                    track_thr = 10.0 * mean.log10() + off;
                }
                track_thr
            } else {
                self.threshold_db
            };
            let gr_inst = self.gain_computer(det_db, thr);
            let gr_db = env.tick(gr_inst);
            let g = (-gr_db * 0.11512925464970229).exp(); // 10^(-gr/20)
            out_l.push((l[i] as f64 * g) as f32);
            out_r.push((r[i] as f64 * g) as f32);
            if (l[i] as f64) * (l[i] as f64) > active_gate {
                active_e += (l[i] as f64) * (l[i] as f64) + (r[i] as f64) * (r[i] as f64);
                active_n += 2;
            }
            if x > 1e-3 {
                gr_sum += gr_db;
                gr_max = gr_max.max(gr_db);
                gr_cnt += 1;
                if i % 16 == 0 {
                    grs.push(gr_db);
                }
            }
        }
        grs.sort_by(|a, b| a.total_cmp(b));
        let active_rms = if active_n > 0 {
            10.0 * (active_e / active_n as f64).log10()
        } else {
            f64::NEG_INFINITY
        };
        (
            out_l,
            out_r,
            CompStats {
                gr_avg_db: if gr_cnt > 0 { gr_sum / gr_cnt as f64 } else { 0.0 },
                gr_median_db: if grs.is_empty() { 0.0 } else { grs[grs.len() / 2] },
                gr_max_db: gr_max,
                active_rms_dbfs: active_rms,
            },
        )
    }
}

/// Peaking band whose cut depth follows a detector envelope (de-esser /
/// dynamic-EQ slot).
pub struct DynamicEqBand {
    band: super::biquad::Biquad,
    det_bp: Vec<super::biquad::Biquad>,
    env: Env,
    sr: f64,
    freq: f64,
    q: f64,
    threshold_db: f64,
    ratio: f64,
    max_cut_db: f64,
    cut_smoothed: f64,
    cut_smooth_coef: f64,
    block: usize,
    counter: usize,
    pending_gain: f64,
}

impl DynamicEqBand {
    /// `det_band` = (low_hz, high_hz) detector band-pass edges.
    pub fn new(
        sr: f64,
        freq: f64,
        q: f64,
        det_band: (f64, f64),
        threshold_db: f64,
        ratio: f64,
        max_cut_db: f64,
        attack_ms: f64,
        release_ms: f64,
    ) -> Self {
        Self {
            band: super::biquad::Biquad::peaking(sr, freq, q, 0.0),
            det_bp: vec![
                super::biquad::Biquad::high_pass(sr, det_band.0, std::f64::consts::FRAC_1_SQRT_2),
                super::biquad::Biquad::low_pass(sr, det_band.1, std::f64::consts::FRAC_1_SQRT_2),
            ],
            env: Env::new(sr, attack_ms, release_ms),
            sr,
            freq,
            q,
            threshold_db,
            ratio,
            max_cut_db,
            cut_smoothed: 0.0,
            cut_smooth_coef: (-1.0 / (5.0 * sr / 1000.0)).exp(),
            block: 32,
            counter: 0,
            pending_gain: 0.0,
        }
    }

    /// `sc` = optional external sidechain (already mono-summed input works for
    /// stereo-linked processing).
    pub fn process(&mut self, l: &[f32], r: &[f32], sc: Option<&[f32]>) -> (Vec<f32>, Vec<f32>) {
        let n = l.len().min(r.len());
        let mut band_l = self.band;
        // Detector source: external sidechain or mid of the signal.
        let mut out_l = Vec::with_capacity(n);
        let mut out_r = Vec::with_capacity(n);
        let mut band_r = self.band;
        for i in 0..n {
            let det_src = match sc {
                Some(s) => s.get(i).copied().unwrap_or(0.0) as f64,
                None => (l[i] as f64 + r[i] as f64) * 0.5,
            };
            let mut d = det_src;
            for b in &mut self.det_bp {
                d = b.tick(d);
            }
            let e = self.env.tick(d.abs());
            let det_db = db(e);
            let over = det_db - self.threshold_db;
            let cut = if over > 0.0 {
                (over * (1.0 - 1.0 / self.ratio)).min(self.max_cut_db)
            } else {
                0.0
            };
            self.cut_smoothed =
                self.cut_smooth_coef * self.cut_smoothed + (1.0 - self.cut_smooth_coef) * cut;
            if self.counter == 0 {
                let g = -self.cut_smoothed;
                if (g - self.pending_gain).abs() > 1e-4 {
                    band_l.set_peaking(self.sr, self.freq, self.q, g);
                    band_r.set_peaking(self.sr, self.freq, self.q, g);
                    self.pending_gain = g;
                }
            }
            self.counter = (self.counter + 1) % self.block;
            out_l.push(band_l.tick(l[i] as f64) as f32);
            out_r.push(band_r.tick(r[i] as f64) as f32);
        }
        self.band = band_l;
        (out_l, out_r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, sr: u32, n: usize, amp_dbfs: f64) -> Vec<f32> {
        let a = 10f64.powf(amp_dbfs / 20.0);
        (0..n)
            .map(|i| (a * (2.0 * std::f64::consts::PI * freq * i as f64 / sr as f64).sin()) as f32)
            .collect()
    }

    #[test]
    fn compressor_static_minus17_5() {
        let sr = 48000;
        let x = sine(1000.0, sr, sr as usize, -10.0);
        let (mut comp, mut env) = Compressor::new(sr as f64, -20.0, 4.0, 0.0, 5.0, 100.0, 40.0);
        let (l, _, _) = comp.process(&mut env, &x, &x, None);
        let tail = &l[l.len() * 3 / 4..];
        let rms = (tail.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / tail.len() as f64)
            .sqrt();
        let out_db = 20.0 * (rms * 2f64.sqrt()).log10(); // RMS -> peak dB
        assert!((out_db - -17.5).abs() <= 0.3, "got {out_db:.2} dB");
    }
}
