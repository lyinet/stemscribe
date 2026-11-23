//! RBJ audio-eq-cookbook biquads (f64 state, f32 I/O).

#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

fn norm(b: [f64; 3], a: [f64; 3]) -> Biquad {
    Biquad {
        b0: b[0] / a[0],
        b1: b[1] / a[0],
        b2: b[2] / a[0],
        a1: a[1] / a[0],
        a2: a[2] / a[0],
        x1: 0.0,
        x2: 0.0,
        y1: 0.0,
        y2: 0.0,
    }
}

fn alpha(w: f64, q: f64) -> f64 {
    w.sin() / (2.0 * q)
}

impl Biquad {
    pub fn peaking(sr: f64, freq: f64, q: f64, gain_db: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let w = 2.0 * std::f64::consts::PI * freq / sr;
        let al = alpha(w, q);
        norm(
            [
                1.0 + al * a,
                -2.0 * w.cos(),
                1.0 - al * a,
            ],
            [
                1.0 + al / a,
                -2.0 * w.cos(),
                1.0 - al / a,
            ],
        )
    }

    pub fn low_shelf(sr: f64, freq: f64, q: f64, gain_db: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let w = 2.0 * std::f64::consts::PI * freq / sr;
        let al = alpha(w, q);
        let sq = 2.0 * a.sqrt() * al;
        let cw = w.cos();
        norm(
            [
                a * ((a + 1.0) - (a - 1.0) * cw + sq),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cw),
                a * ((a + 1.0) - (a - 1.0) * cw - sq),
            ],
            [
                (a + 1.0) + (a - 1.0) * cw + sq,
                -2.0 * ((a - 1.0) + (a + 1.0) * cw),
                (a + 1.0) + (a - 1.0) * cw - sq,
            ],
        )
    }

    pub fn high_shelf(sr: f64, freq: f64, q: f64, gain_db: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let w = 2.0 * std::f64::consts::PI * freq / sr;
        let al = alpha(w, q);
        let sq = 2.0 * a.sqrt() * al;
        let cw = w.cos();
        norm(
            [
                a * ((a + 1.0) + (a - 1.0) * cw + sq),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cw),
                a * ((a + 1.0) + (a - 1.0) * cw - sq),
            ],
            [
                (a + 1.0) - (a - 1.0) * cw + sq,
                2.0 * ((a - 1.0) - (a + 1.0) * cw),
                (a + 1.0) - (a - 1.0) * cw - sq,
            ],
        )
    }

    pub fn high_pass(sr: f64, freq: f64, q: f64) -> Self {
        let w = 2.0 * std::f64::consts::PI * freq / sr;
        let al = alpha(w, q);
        let cw = w.cos();
        norm(
            [(1.0 + cw) / 2.0, -(1.0 + cw), (1.0 + cw) / 2.0],
            [1.0 + al, -2.0 * cw, 1.0 - al],
        )
    }

    pub fn low_pass(sr: f64, freq: f64, q: f64) -> Self {
        let w = 2.0 * std::f64::consts::PI * freq / sr;
        let al = alpha(w, q);
        let cw = w.cos();
        norm(
            [(1.0 - cw) / 2.0, 1.0 - cw, (1.0 - cw) / 2.0],
            [1.0 + al, -2.0 * cw, 1.0 - al],
        )
    }

    /// Constant 0 dB peak-gain band-pass.
    pub fn band_pass(sr: f64, freq: f64, q: f64) -> Self {
        let w = 2.0 * std::f64::consts::PI * freq / sr;
        let al = alpha(w, q);
        let cw = w.cos();
        norm([al, 0.0, -al], [1.0 + al, -2.0 * cw, 1.0 - al])
    }

    #[inline]
    pub fn tick(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }

    pub fn process(&mut self, x: &[f32]) -> Vec<f32> {
        x.iter().map(|&s| self.tick(s as f64) as f32).collect()
    }

    /// Replace coefficients while keeping the delay state (smooth switching
    /// is the caller's responsibility).
    pub fn set_peaking(&mut self, sr: f64, freq: f64, q: f64, gain_db: f64) {
        *self = Self {
            x1: self.x1,
            x2: self.x2,
            y1: self.y1,
            y2: self.y2,
            ..Self::peaking(sr, freq, q, gain_db)
        };
    }
}

/// 4th-order Butterworth cascade (Q 0.5412 + 1.3066).
pub fn butter4<F>(sr: f64, freq: f64, f: F) -> [Biquad; 2]
where
    F: Fn(f64, f64, f64) -> Biquad,
{
    [f(sr, freq, 0.541196100146197), f(sr, freq, 1.306562964876377)]
}

pub fn butter4_lowpass(sr: f64, freq: f64) -> [Biquad; 2] {
    butter4(sr, freq, Biquad::low_pass)
}

pub fn butter4_highpass(sr: f64, freq: f64) -> [Biquad; 2] {
    butter4(sr, freq, Biquad::high_pass)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, sr: u32, n: usize, amp: f64) -> Vec<f32> {
        (0..n)
            .map(|i| (amp * (2.0 * std::f64::consts::PI * freq * i as f64 / sr as f64).sin()) as f32)
            .collect()
    }

    fn out_level(filter: &mut Biquad, freq: f64, sr: u32) -> f64 {
        let x = sine(freq, sr, sr as usize, 0.5);
        let y = filter.process(&x);
        let tail = &y[y.len() / 2..];
        let peak = tail.iter().fold(0.0f32, |a, &v| a.max(v.abs())) as f64;
        20.0 * (peak / 0.5).log10()
    }

    #[test]
    fn peaking_plus6_at_1k() {
        let mut f = Biquad::peaking(48000.0, 1000.0, 1.0, 6.0);
        let g = out_level(&mut f, 1000.0, 48000);
        assert!((g - 6.0).abs() <= 0.1, "got {g:.3} dB");
    }

    #[test]
    fn hpf_minus3_at_fc() {
        let mut f = Biquad::high_pass(48000.0, 1000.0, std::f64::consts::FRAC_1_SQRT_2);
        let g = out_level(&mut f, 1000.0, 48000);
        assert!((g - -3.01).abs() <= 0.1, "got {g:.3} dB");
    }

    #[test]
    fn lr4_sum_flat() {
        for freq in [200.0, 1000.0, 5000.0, 15000.0] {
            // LR4 = two identical cascaded 2nd-order Butterworth sections
            // (Q = 1/sqrt(2)), -6 dB at fc, in-phase -> flat sum.
            let q = std::f64::consts::FRAC_1_SQRT_2;
            let mut lo = [Biquad::low_pass(48000.0, 2000.0, q), Biquad::low_pass(48000.0, 2000.0, q)];
            let mut hi = [Biquad::high_pass(48000.0, 2000.0, q), Biquad::high_pass(48000.0, 2000.0, q)];
            let x = sine(freq, 48000, 48000, 0.5);
            let mut acc = vec![0.0f32; x.len()];
            let l = lo.iter_mut().fold(x.clone(), |s, b| b.process(&s));
            let h = hi.iter_mut().fold(x.clone(), |s, b| b.process(&s));
            for i in 0..x.len() {
                acc[i] = l[i] + h[i];
            }
            let tail = &acc[acc.len() / 2..];
            let peak = tail.iter().fold(0.0f32, |a, &v| a.max(v.abs())) as f64;
            let db = 20.0 * (peak / 0.5).log10();
            assert!(db.abs() <= 0.1, "freq {freq}: sum {db:.3} dB");
        }
    }
}
