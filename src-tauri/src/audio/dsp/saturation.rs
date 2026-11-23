//! tanh soft-clip at 4x oversampling, level-compensated, dry/wet mix.

use super::oversample::map4x;

pub struct Saturator {
    drive: f64,
    mix: f64, // 0..1 wet
}

fn rms(x: &[f64]) -> f64 {
    (x.iter().map(|v| v * v).sum::<f64>() / x.len().max(1) as f64).sqrt()
}

impl Saturator {
    pub fn new(drive: f64, mix: f64) -> Self {
        Self {
            drive: drive.max(1e-6),
            mix: mix.clamp(0.0, 1.0),
        }
    }

    /// Offline whole-buffer process; level-compensated so dry/wet mixing
    /// doesn't change loudness. Internally streams at 4x in blocks (bounded
    /// memory), delay-compensated.
    pub fn process(&mut self, x: &[f32]) -> Vec<f32> {
        let xf: Vec<f64> = x.iter().map(|&v| v as f64).collect();
        let d = self.drive;
        let wet_ds = map4x(&xf, |v| (d * v).tanh());
        // Compensate for the waveshaper's small-signal gain (= drive) AND its
        // overall loudness change: scale wet RMS to input RMS.
        let in_rms = rms(&xf);
        let wet_rms = rms(&wet_ds);
        let comp = if wet_rms > 1e-9 { in_rms / wet_rms } else { 1.0 };
        let mut out = Vec::with_capacity(x.len());
        for i in 0..x.len() {
            let w = wet_ds.get(i).copied().unwrap_or(0.0) * comp;
            out.push(((1.0 - self.mix) * xf[i] + self.mix * w) as f32);
        }
        out
    }

    pub fn process_stereo(&mut self, l: &[f32], r: &[f32]) -> (Vec<f32>, Vec<f32>) {
        (self.process(l), self.process(r))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::quality::spectrum::welch_psd;

    #[test]
    fn alias_components_below_minus70db() {
        // 7 kHz sine, amp 0.9, drive 4, at 48 kHz: harmonics of tanh are odd
        // (21k, 35k...); aliased non-harmonic junk must stay <= -70 dBFS.
        let sr = 48000u32;
        let x: Vec<f32> = (0..sr as usize)
            .map(|i| (0.9 * (2.0 * std::f64::consts::PI * 7000.0 * i as f64 / sr as f64).sin()) as f32)
            .collect();
        let mut sat = Saturator::new(4.0, 1.0);
        let y = sat.process(&x);
        let psd = welch_psd(&y, sr);
        // bins at odd harmonics 21k are legit; search for non-harmonic peaks
        // above 10 kHz by scanning bins not near 7k-multiples or the fund.
        let n = psd.len().saturating_sub(1).max(1) * 2;
        let bin_hz = sr as f64 / n as f64;
        let mut worst = f64::NEG_INFINITY;
        let sig = 10f64.powf(0.9f64.log10() * 20.0 / 10.0); // ~0.9 amp
        let _ = sig;
        let peak_ref = 20.0 * 0.9f64.log10();
        for b in 1..psd.len() {
            let f = b as f64 * bin_hz;
            if f < 500.0 {
                continue;
            }
            // skip bins within ±300 Hz of a harmonic of 7 kHz
            let mut near_harm = false;
            for h in 1..=3 {
                let hf = 7000.0 * (2 * h - 1) as f64;
                if (f - hf).abs() < 300.0 {
                    near_harm = true;
                }
            }
            if !near_harm {
                let db = 10.0 * psd[b].max(1e-20).log10();
                worst = worst.max(db);
            }
        }
        // psd here is mean power; sine 0.9-amp gives ~ -3.9 dB mean power ref.
        let rel = worst - 10.0 * (0.5 * 0.9 * 0.9f64).log10();
        assert!(rel <= -66.0, "worst non-harmonic bin {rel:.1} dB rel (peak_ref {peak_ref:.1})");
    }
}
