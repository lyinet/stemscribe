//! Streaming 4x oversampler: two cascaded 2x half-band FIR stages
//! (Kaiser-windowed sinc, >= 90 dB stopband). Exact latency reporting and
//! delay-compensated offline processing via `process_all`.

const STAGE_TAPS: usize = 127; // odd, half-band symmetric

fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0f64;
    let mut t = 1.0f64;
    let y = (x * x) / 4.0;
    for k in 1..40 {
        t *= y / (k as f64 * k as f64);
        sum += t;
        if t < 1e-12 * sum {
            break;
        }
    }
    sum
}

/// Half-band lowpass at quarter of the output rate, Kaiser window, beta 9.4
/// (~95 dB stopband), normalized to DC gain 2 for zero-stuffed 2x upsampling.
fn half_band_taps() -> Vec<f64> {
    let n = STAGE_TAPS;
    let d = (n - 1) / 2;
    let beta = 9.4f64;
    let denom = bessel_i0(beta);
    let mut h = vec![0.0f64; n];
    for j in 0..n {
        let m = j as f64 - d as f64;
        let sinc = if m.abs() < 1e-9 {
            0.5
        } else {
            (std::f64::consts::PI * m / 2.0).sin() / (std::f64::consts::PI * m)
        };
        let r = 2.0 * m / (n - 1) as f64;
        let w = bessel_i0(beta * (1.0 - r * r).max(0.0).sqrt()) / denom;
        h[j] = 2.0 * sinc * w;
    }
    // Normalize to exact DC gain 2.
    let sum: f64 = h.iter().sum();
    for v in &mut h {
        *v *= 2.0 / sum;
    }
    h
}

/// Causal 2x upsampler. Emits 2 outputs per input; group delay = (N-1)/2
/// input samples = N-1 output samples.
struct Up2 {
    h: Vec<f64>,
    // window of the last d+1 inputs (x[u], x[u-1], ..., x[u-d])
    win: std::collections::VecDeque<f64>,
    emitted_inputs: usize,
}

impl Up2 {
    fn new() -> Self {
        Self {
            h: half_band_taps(),
            win: std::collections::VecDeque::new(),
            emitted_inputs: 0,
        }
    }

    fn d(&self) -> usize {
        (self.h.len() - 1) / 2
    }

    /// Output latency in *output* samples: impulse at input 0 peaks at
    /// output index d = (N-1)/2.
    fn latency_out(&self) -> usize {
        self.d()
    }

    fn push(&mut self, x: f64) -> [f64; 2] {
        self.win.push_back(x);
        if self.win.len() > self.d() + 1 {
            self.win.pop_front();
        }
        let d = self.d();
        let mut even = 0.0f64;
        let mut odd = 0.0f64;
        // y[2u] = sum_k h[2k] x[u-k] ; y[2u+1] = sum_k h[2k+1] x[u-k]
        for (k, &xk) in self.win.iter().rev().enumerate() {
            let even_tap = 2 * k;
            even += self.h[even_tap] * xk;
            if 2 * k + 1 < self.h.len() {
                odd += self.h[2 * k + 1] * xk;
            }
        }
        let _ = d;
        self.emitted_inputs += 1;
        [even, odd]
    }
}

pub struct Oversampler {
    s1: Up2,
    s2: Up2,
}

impl Default for Oversampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Oversampler {
    pub fn new() -> Self {
        Self {
            s1: Up2::new(),
            s2: Up2::new(),
        }
    }

    /// Total latency in 4x-rate output samples.
    pub fn latency(&self) -> usize {
        self.s1.latency_out() * 2 + self.s2.latency_out()
    }

    /// Internal flush needs this many input pushes to cover the tail.
    fn flush_pushes(&self) -> usize {
        self.s1.d() + self.s2.d() + 2
    }

    /// Streaming: returns 4*input.len() output samples.
    pub fn process(&mut self, input: &[f64]) -> Vec<f64> {
        let mut out = Vec::with_capacity(input.len() * 4);
        for &x in input {
            let a = self.s1.push(x);
            let b0 = self.s2.push(a[0]);
            let b1 = self.s2.push(a[1]);
            out.extend_from_slice(&b0);
            out.extend_from_slice(&b1);
        }
        out
    }

    /// Flush the filter tail (call after the last `process` block).
    pub fn flush(&mut self) -> Vec<f64> {
        let mut out = Vec::with_capacity(self.latency());
        for _ in 0..self.flush_pushes() {
            let a = self.s1.push(0.0);
            let b0 = self.s2.push(a[0]);
            let b1 = self.s2.push(a[1]);
            out.extend_from_slice(&b0);
            out.extend_from_slice(&b1);
        }
        out
    }

    /// Offline: full 4x output, delay-compensated (output[i] corresponds to
    /// input[i/4]), exactly 4*input.len() samples, tail flushed.
    /// Uses a direct-convolution path parallelized over output chunks.
    pub fn process_all(&mut self, input: &[f64]) -> Vec<f64> {
        process_all_direct(input)
    }
}

/// Convenience: one-shot 4x oversample of a whole buffer, delay-compensated.
const PAR_THREADS: usize = 4;

/// Convolution of a zero-stuffed 2x signal `x` with half-band `h`,
/// emitting `2*x.len()` outputs (same indexing as `Up2::push` streams).
fn up2_direct(x: &[f64], h: &[f64]) -> Vec<f64> {
    let m = x.len();
    let out_len = 2 * m;
    let taps = h.len();
    let mut out = vec![0.0f64; out_len];
    let chunk = out_len.div_ceil(PAR_THREADS).max(1);
    std::thread::scope(|sc| {
        for (ci, seg) in out.chunks_mut(chunk).enumerate() {
            let h = h;
            let x = x;
            sc.spawn(move || {
                let base = ci * chunk;
                for (off, o) in seg.iter_mut().enumerate() {
                    let k = base + off;
                    // out[k] = sum_j h[j] * x_up[k-j], x_up[p] = x[p/2] if p even
                    let mut acc = 0.0f64;
                    let j_lo = if k + 1 >= 2 * m { k + 1 - 2 * m } else { 0 };
                    let j_hi = k.min(taps - 1);
                    // k - j must be even -> j has the same parity as k
                    let mut j = if (k + j_lo) % 2 == 0 { j_lo } else { j_lo + 1 };
                    while j <= j_hi {
                        let ii = (k - j) / 2;
                        if ii < m {
                            acc += h[j] * x[ii];
                        }
                        j += 2;
                    }
                    *o = acc;
                }
            });
        }
    });
    out
}

/// Direct-convolution equivalent of `Oversampler::process_all`.
fn process_all_direct(input: &[f64]) -> Vec<f64> {
    let h = half_band_taps();
    let d = (h.len() - 1) / 2;
    let lat = d * 2 + d; // s1 latency (in s1-out samples) x2 + s2 latency
    let flush_pushes = d + d + 2;
    let n = input.len();
    let mut xe = vec![0.0f64; n + flush_pushes];
    xe[..n].copy_from_slice(input);
    let a = up2_direct(&xe, &h); // 2 * (n + flush) samples
    let b = up2_direct(&a, &h); // 4 * (n + flush) samples
    let target = n * 4;
    let mut out = Vec::with_capacity(target);
    for i in 0..target {
        out.push(b.get(lat + i).copied().unwrap_or(0.0));
    }
    out
}

pub fn oversample4(input: &[f64]) -> Vec<f64> {
    Oversampler::new().process_all(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, sr: f64, n: usize, amp: f64) -> Vec<f64> {
        (0..n)
            .map(|i| amp * (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin())
            .collect()
    }

    #[test]
    fn roundtrip_1k_below_minus80db() {
        let sr = 48000.0;
        let n = 48000;
        let x = sine(1000.0, sr, n, 0.5);
        let up = oversample4(&x);
        // Decimate by 4 (delay-compensated) and compare.
        let down: Vec<f64> = (0..n).map(|i| up[i * 4]).collect();
        let margin = 4000;
        let mut err_e = 0.0f64;
        let mut ref_e = 0.0f64;
        for i in margin..n - margin {
            err_e += (down[i] - x[i]).powi(2);
            ref_e += x[i].powi(2);
        }
        let db = 10.0 * (err_e / ref_e).log10();
        assert!(db <= -80.0, "roundtrip error {db:.1} dB");
    }

    #[test]
    fn exact_output_len() {
        let x = vec![0.0f64; 1000];
        let up = oversample4(&x);
        assert_eq!(up.len(), 4000);
    }

    /// Peak lag between input and output over [-64, 64] samples.
    fn xcorr_lag(x: &[f64], y: &[f64], centre: usize, win: usize) -> i64 {
        let mut best_lag = 0i64;
        let mut best = f64::NEG_INFINITY;
        for lag in -64i64..=64 {
            let mut acc = 0.0f64;
            for i in 0..win {
                let xi = centre + i;
                let yi = centre as i64 + i as i64 - lag;
                if yi >= 0 && (yi as usize) < y.len() && xi < x.len() {
                    acc += x[xi] * y[yi as usize];
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
    fn decimate4_has_zero_lag() {
        let mut x = vec![0.0f64; 48000];
        for i in (4000..x.len() - 4000).step_by(4000) {
            x[i] = 1.0;
        }
        let up = oversample4(&x);
        let down = decimate4(&up);
        assert_eq!(down.len(), x.len());
        assert_eq!(xcorr_lag(&x, &down, 20000, 20000), 0, "decimate4 lag");
    }

    #[test]
    fn map4x_has_zero_lag() {
        let mut x = vec![0.0f64; 48000];
        for i in (4000..x.len() - 4000).step_by(4000) {
            x[i] = 0.8;
        }
        // identity mapping at 4x: output must equal input, lag 0
        let y = map4x(&x, |v| v);
        assert_eq!(y.len(), x.len());
        assert_eq!(xcorr_lag(&x, &y, 20000, 20000), 0, "map4x lag");
        // and a nonlinear map stays aligned too
        let z = map4x(&x, |v| v.tanh());
        assert_eq!(xcorr_lag(&x, &z, 20000, 20000), 0, "map4x nonlinear lag");
    }
}

/// 4x decimation taps: windowed-sinc lowpass at 1/8 of the 4x rate, unity DC.
fn decimate4_taps() -> Vec<f64> {
    let n = 255usize;
    let d = (n - 1) / 2;
    let beta = 9.4f64;
    let denom = bessel_i0(beta);
    let mut h = vec![0.0f64; n];
    for j in 0..n {
        let m = j as f64 - d as f64;
        // cutoff = 1/8 of fs4 -> argument m/4 in sinc units of pi
        let sinc = if m.abs() < 1e-9 {
            0.25
        } else {
            (std::f64::consts::PI * m / 4.0).sin() / (std::f64::consts::PI * m)
        };
        let r = 2.0 * m / (n - 1) as f64;
        let w = bessel_i0(beta * (1.0 - r * r).max(0.0).sqrt()) / denom;
        h[j] = sinc * w;
    }
    let sum: f64 = h.iter().sum();
    for v in &mut h {
        *v /= sum;
    }
    h
}

/// Anti-aliased 4x decimation, delay-compensated so `out[i]` corresponds to
/// `up[4i]` of a delay-compensated `oversample4` output. The convolution
/// window is centred on `up[4i]` (taps are symmetric), so the FIR group
/// delay is removed.
pub fn decimate4(up: &[f64]) -> Vec<f64> {
    let h = decimate4_taps();
    let d = (h.len() - 1) / 2;
    let n = up.len() / 4;
    let mut out = vec![0.0f64; n];
    let chunk = n.div_ceil(PAR_THREADS).max(1);
    std::thread::scope(|sc| {
        for (ci, seg) in out.chunks_mut(chunk).enumerate() {
            let up = up;
            let h = &h;
            sc.spawn(move || {
                let base = ci * chunk;
                for (off, o) in seg.iter_mut().enumerate() {
                    let i = base + off;
                    let c = 4 * i;
                    let mut acc = 0.0f64;
                    for (j, &hj) in h.iter().enumerate() {
                        let idx = c + j;
                        acc += hj * if idx >= d && idx - d < up.len() { up[idx - d] } else { 0.0 };
                    }
                    *o = acc;
                }
            });
        }
    });
    out
}

/// Overlap-block context (1x samples) needed around each block so both the
/// oversampler (189 4x-sample latency ~ 48 input samples) and the decimator
/// (127 4x-sample window ~ 32 input samples) produce exact interior output.
pub const MAP4X_CTX: usize = 128;

/// Stream `input` (1x rate) through 4x oversampling, apply `f` per 4x
/// sample, then anti-alias decimate. Delay-compensated so `out[i]`
/// corresponds to `input[i]`. Processes overlap-blocks through the parallel
/// direct convolutions — fast and bounded memory.
pub fn map4x(input: &[f64], mut f: impl FnMut(f64) -> f64) -> Vec<f64> {
    const BLOCK: usize = 1 << 18;
    let n = input.len();
    let mut out = vec![0.0f64; n];
    let mut i0 = 0usize;
    while i0 < n {
        let i1 = (i0 + BLOCK).min(n);
        let a = i0.saturating_sub(MAP4X_CTX);
        let b = (i1 + MAP4X_CTX).min(n);
        let up = oversample4(&input[a..b]);
        let mut g4 = vec![0.0f64; up.len()];
        for (j, &v) in up.iter().enumerate() {
            g4[j] = f(v);
        }
        let dec = decimate4(&g4);
        // dec[k] corresponds to ext_in[k] = input[a + k]; take the interior.
        for k in 0..(i1 - i0) {
            let src = k + (i0 - a);
            out[i0 + k] = dec.get(src).copied().unwrap_or(0.0);
        }
        i0 = i1;
    }
    out
}
