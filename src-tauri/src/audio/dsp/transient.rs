//! Transient shaper: fast vs slow envelope ratio as a dB gain.

struct Env {
    atk: f64,
    rel: f64,
    y: f64,
}

impl Env {
    fn new(sr: f64, attack_ms: f64, release_ms: f64) -> Self {
        Self {
            atk: (-1.0 / (attack_ms.max(0.01) * sr / 1000.0)).exp(),
            rel: (-1.0 / (release_ms.max(0.5) * sr / 1000.0)).exp(),
            y: 0.0,
        }
    }
    #[inline]
    fn tick(&mut self, x: f64) -> f64 {
        let c = if x > self.y { self.atk } else { self.rel };
        self.y = c * self.y + (1.0 - c) * x;
        self.y
    }
}

pub struct TransientShaper {
    fast: Env,
    slow: Env,
    amount: f64,
}

impl TransientShaper {
    /// amount in 0..~1.5; gain_db = clamp(amount * 20*log10(fast/slow), -3, +6).
    pub fn new(sr: f64, amount: f64) -> Self {
        Self {
            fast: Env::new(sr, 1.0, 20.0),
            slow: Env::new(sr, 20.0, 200.0),
            amount,
        }
    }

    /// Stereo-linked (detector = max |L|,|R|).
    pub fn process(&mut self, l: &[f32], r: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let n = l.len().min(r.len());
        let mut out_l = Vec::with_capacity(n);
        let mut out_r = Vec::with_capacity(n);
        for i in 0..n {
            let x = l[i].abs().max(r[i].abs()) as f64;
            let f = self.fast.tick(x);
            let s = self.slow.tick(x);
            let ratio = (f + 1e-9) / (s + 1e-9);
            let gain_db = (self.amount * 20.0 * ratio.log10()).clamp(-3.0, 6.0);
            let g = 10f64.powf(gain_db / 20.0);
            out_l.push((l[i] as f64 * g) as f32);
            out_r.push((r[i] as f64 * g) as f32);
        }
        (out_l, out_r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_gets_boosted() {
        let sr = 48000.0;
        let n = sr as usize;
        // quiet tone with a loud click at n/2
        let mut l: Vec<f32> = (0..n)
            .map(|i| (0.02 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / sr).sin()) as f32)
            .collect();
        l[n / 2] = 0.9;
        l[n / 2 + 1] = -0.9;
        l[n / 2 + 2] = 0.9;
        let r = l.clone();
        let mut t = TransientShaper::new(sr, 1.0);
        let (ol, _or) = t.process(&l, &r);
        // at the click the shaper should apply positive gain
        let g = (ol[n / 2] as f64 / l[n / 2] as f64).abs();
        assert!(g > 1.2, "click gain {g}");
    }
}
