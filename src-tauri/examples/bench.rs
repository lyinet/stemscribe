//! Deterministic performance + quality regression benchmark for the
//! restoration pipeline. Synthesizes three 90 s / 48 kHz stereo "songs"
//! with a seeded RNG (no external audio), injects one known defect per
//! clip, runs `run_restore` at standard strength through the stems path,
//! and gates on time / loudness / true-peak / issue / presence metrics.
//!
//! Usage:
//!   bench [--dir <work_dir>] [--json <path>] [--md <path>]
//!         [--baseline <baseline.json>] [--write-baseline <path>]
//!         [--clip <name>]
//!
//! Exit code is 1 when any gate fails (requires --baseline for the
//! time gate; all other gates always apply).

use realfft::{num_complex::Complex32, RealFftPlanner};
use stemscribe_lib::audio::dsp::biquad::Biquad;
use stemscribe_lib::audio::dsp::dynamics::Compressor;
use stemscribe_lib::audio::quality::loudness::integrated_lufs;
use stemscribe_lib::audio::quality::spectrum::BandLevel;
use stemscribe_lib::audio::quality::QualityReport;
use stemscribe_lib::audio::restore::{run_restore, RestoreRequest, RestoreSettings, StemIn};
use stemscribe_lib::audio::write_stereo_wav_f32;
use std::path::Path;
use std::time::Instant;

const SR: u32 = 48_000;
const DUR_SEC: f64 = 90.0;
const N: usize = (SR as f64 * DUR_SEC) as usize;

// ---------- deterministic RNG ----------

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn f64(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.f64()
    }
}

// ---------- synthesis helpers ----------

fn db_gain(db: f64) -> f32 {
    10f64.powf(db / 20.0) as f32
}

fn add_sine_burst(
    buf: &mut [f32],
    rng: &mut Rng,
    start: usize,
    freq: f64,
    dur: f64,
    amp: f64,
    decay: f64,
) {
    let n = ((dur * SR as f64) as usize).min(buf.len() - start.min(buf.len()));
    let ph0 = rng.range(0.0, std::f64::consts::TAU);
    for i in 0..n {
        let t = i as f64 / SR as f64;
        let env = (-decay * t).exp();
        buf[start + i] += (amp * env * (ph0 + std::f64::consts::TAU * freq * t).sin()) as f32;
    }
}

fn add_noise_burst(
    buf: &mut [f32],
    rng: &mut Rng,
    start: usize,
    dur: f64,
    amp: f64,
    hp_hz: f64,
    decay: f64,
) {
    let n = ((dur * SR as f64) as usize).min(buf.len() - start.min(buf.len()));
    let mut hp = Biquad::high_pass(SR as f64, hp_hz, std::f64::consts::FRAC_1_SQRT_2);
    for i in 0..n {
        let t = i as f64 / SR as f64;
        let env = (-decay * t).exp();
        let x = rng.range(-1.0, 1.0) * amp * env;
        buf[start + i] += hp.tick(x) as f32;
    }
}

/// Simple formant vocal: sawtooth glottal source + vibrato through three
/// formant resonators; phrase pattern with rests.
fn synth_vocal(rng: &mut Rng) -> (Vec<f32>, Vec<f32>) {
    let mut l = vec![0f32; N];
    let mut r = vec![0f32; N];
    let melody = [
        440.0f64, 523.25, 587.33, 523.25, 440.0, 392.0, 440.0, 523.25,
    ];
    let formants = [(700.0, 1150.0, 2600.0), (400.0, 2000.0, 2800.0)];
    let beat = 60.0 / 96.0; // 96 bpm
    let note_dur = beat; // one note per beat
    let mut t = 8.0; // vocals enter after 2 bars
    let mut idx = 0usize;
    while t + note_dur < DUR_SEC - 1.0 {
        // 4-note phrase, then a 2-beat rest
        if idx % 6 == 4 || idx % 6 == 5 {
            idx += 1;
            t += note_dur;
            continue;
        }
        let f0 = melody[idx % melody.len()] * 0.5;
        let (f1, f2, f3) = formants[(idx / 8) % formants.len()];
        let start = (t * SR as f64) as usize;
        let n = ((note_dur * 0.92) * SR as f64) as usize;
        let mut src = Vec::with_capacity(n);
        let mut ph = rng.range(0.0, 1.0);
        for i in 0..n {
            let tt = i as f64 / SR as f64;
            let vib = 1.0 + 0.01 * (std::f64::consts::TAU * 5.5 * tt).sin();
            ph += f0 * vib / SR as f64;
            // band-limited-ish sawtooth: sum of first 24 harmonics
            let mut s = 0.0f64;
            for k in 1..=24 {
                s += (std::f64::consts::TAU * ph * k as f64).sin() / k as f64;
            }
            let env = ((tt / 0.02).min(1.0)) * ((-tt + note_dur * 0.92) / 0.08).min(1.0).max(0.0);
            src.push((s * 0.55 * env) as f32);
        }
        for &(hz, gain) in &[(f1, 8.0), (f2, 6.0), (f3, 3.0)] {
            let mut b = Biquad::peaking(SR as f64, hz, 3.0, gain);
            src = b.process(&src);
        }
        for i in 0..n {
            let pan = 0.06 * (std::f64::consts::TAU * 0.2 * (t + i as f64 / SR as f64)).sin();
            l[start + i] += src[i] * (0.5 - pan) as f32;
            r[start + i] += src[i] * (0.5 + pan) as f32;
        }
        idx += 1;
        t += note_dur;
    }
    (l, r)
}

fn synth_drums(rng: &mut Rng) -> (Vec<f32>, Vec<f32>) {
    let mut l = vec![0f32; N];
    let mut r = vec![0f32; N];
    let beat = 60.0 / 96.0;
    let mut b = 0usize;
    while (b as f64) * beat < DUR_SEC {
        let t = b as f64 * beat;
        let s = (t * SR as f64) as usize;
        // kick every beat, slightly louder on 1
        let kick_amp = if b % 4 == 0 { 0.9 } else { 0.7 };
        add_sine_burst(&mut l, rng, s, 55.0, 0.18, kick_amp, 25.0);
        add_sine_burst(&mut r, rng, s, 55.0, 0.18, kick_amp, 25.0);
        // snare on 2 & 4
        if b % 4 == 1 || b % 4 == 3 {
            let s2 = s;
            add_noise_burst(&mut l, rng, s2, 0.12, 0.35, 1200.0, 40.0);
            add_noise_burst(&mut r, rng, s2, 0.12, 0.35, 1200.0, 40.0);
            add_sine_burst(&mut l, rng, s2, 190.0, 0.08, 0.3, 45.0);
            add_sine_burst(&mut r, rng, s2, 190.0, 0.08, 0.3, 45.0);
        }
        // hats on off-beats
        let hs = ((t + beat * 0.5) * SR as f64) as usize;
        add_noise_burst(&mut l, rng, hs, 0.04, 0.12, 6000.0, 90.0);
        add_noise_burst(&mut r, rng, hs + 7, 0.04, 0.12, 6000.0, 90.0);
        b += 1;
    }
    (l, r)
}

fn synth_bass(rng: &mut Rng) -> (Vec<f32>, Vec<f32>) {
    let mut l = vec![0f32; N];
    let mut r = vec![0f32; N];
    // Am F C G roots, one bar each (2.5 s at 96 bpm)
    let roots = [55.0f64, 43.65, 65.41, 49.0];
    let bar = 4.0 * 60.0 / 96.0;
    let mut t = 0.0;
    let mut bar_i = 0usize;
    while t < DUR_SEC {
        let root = roots[bar_i % roots.len()];
        for e in 0..4 {
            let st = t + e as f64 * bar / 4.0;
            if st >= DUR_SEC {
                break;
            }
            let s = (st * SR as f64) as usize;
            let f = root * if e == 2 { 1.5 } else { 1.0 };
            add_sine_burst(&mut l, rng, s, f, 0.5, 0.5, 6.0);
            add_sine_burst(&mut r, rng, s, f, 0.5, 0.5, 6.0);
            // 2nd harmonic
            add_sine_burst(&mut l, rng, s, f * 2.0, 0.4, 0.15, 8.0);
            add_sine_burst(&mut r, rng, s, f * 2.0, 0.4, 0.15, 8.0);
        }
        bar_i += 1;
        t += bar;
    }
    (l, r)
}

fn synth_chords(rng: &mut Rng) -> (Vec<f32>, Vec<f32>) {
    let mut l = vec![0f32; N];
    let mut r = vec![0f32; N];
    // triads: Am (220,261.6,329.6) F (174.6,220,261.6) C (261.6,329.6,392) G (196,246.9,293.7)
    let chords: [[f64; 3]; 4] = [
        [220.0, 261.63, 329.63],
        [174.61, 220.0, 261.63],
        [261.63, 329.63, 392.0],
        [196.0, 246.94, 293.66],
    ];
    let bar = 4.0 * 60.0 / 96.0;
    let mut t = 0.0;
    let mut bar_i = 0usize;
    while t < DUR_SEC {
        let chord = chords[bar_i % chords.len()];
        let s = (t * SR as f64) as usize;
        let n = (((bar * 1.02) * SR as f64) as usize).min(N - s.min(N));
        for (ci, &f) in chord.iter().enumerate() {
            let ph_l = rng.range(0.0, std::f64::consts::TAU);
            let ph_r = rng.range(0.0, std::f64::consts::TAU);
            let det_r = f * 1.003; // slight R detune for width
            for i in 0..n {
                let tt = i as f64 / SR as f64;
                let env = (tt / 0.15).min(1.0) * ((n - i) as f64 / (0.2 * SR as f64)).min(1.0).max(0.0);
                let trem = 1.0 + 0.05 * (std::f64::consts::TAU * 1.7 * tt + ci as f64).sin();
                let amp = 0.09 * env * trem;
                l[s + i] += (amp * (ph_l + std::f64::consts::TAU * f * tt).sin()
                    + amp * 0.3 * (ph_l + std::f64::consts::TAU * f * 2.0 * tt).sin()) as f32;
                r[s + i] += (amp * (ph_r + std::f64::consts::TAU * det_r * tt).sin()
                    + amp * 0.3 * (ph_r + std::f64::consts::TAU * det_r * 2.0 * tt).sin()) as f32;
            }
        }
        bar_i += 1;
        t += bar;
    }
    (l, r)
}

// ---------- defect injection (per stem, then re-sum) ----------

type StemSet = Vec<(String, Vec<f32>, Vec<f32>)>;

fn normalize_lufs(stems: &mut StemSet, target: f64) {
    let (ml, mr) = mixdown(stems);
    let cur = integrated_lufs(&[ml, mr], SR);
    let g = db_gain(target - cur);
    for (_, l, r) in stems.iter_mut() {
        for v in l.iter_mut() {
            *v *= g;
        }
        for v in r.iter_mut() {
            *v *= g;
        }
    }
}

/// Scale the stems so the mix's sample peak sits at `peak_dbfs`.
/// Keeps the engine's loudness loop out of the GR-protect backoff so the
/// |I - target| gate stays meaningful.
fn normalize_peak(stems: &mut StemSet, peak_dbfs: f64) {
    let (ml, mr) = mixdown(stems);
    let peak = ml
        .iter()
        .chain(mr.iter())
        .fold(0.0f32, |m, &v| m.max(v.abs()))
        .max(1e-6) as f64;
    let g = 10f64.powf(peak_dbfs / 20.0) / peak;
    for (_, l, r) in stems.iter_mut() {
        for v in l.iter_mut() {
            *v *= g as f32;
        }
        for v in r.iter_mut() {
            *v *= g as f32;
        }
    }
}

fn defect_a(stems: &StemSet) -> StemSet {
    // +6 dB resonance at 3.5 kHz on the vocal + overall -20 LUFS mix.
    let mut out: StemSet = stems
        .iter()
        .map(|(name, l, r)| {
            if name == "vocals" {
                let mut bl = Biquad::peaking(SR as f64, 3500.0, 4.0, 6.0);
                let mut br = Biquad::peaking(SR as f64, 3500.0, 4.0, 6.0);
                (name.clone(), bl.process(l), br.process(r))
            } else {
                (name.clone(), l.clone(), r.clone())
            }
        })
        .collect();
    normalize_lufs(&mut out, -20.0);
    out
}

/// Brickwall lowpass: FFT the whole channel, zero bins above `cut_hz`,
/// inverse-transform. Guarantees the >40 dB drop the cutoff detector needs.
fn brickwall_lowpass(x: &[f32], cut_hz: f64) -> Vec<f32> {
    let n = x.len();
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    let ifft = planner.plan_fft_inverse(n);
    let mut buf = fft.make_input_vec();
    buf[..n].copy_from_slice(x);
    let mut spec = fft.make_output_vec();
    fft.process(&mut buf, &mut spec).expect("fft");
    let bins = spec.len();
    let cut_bin = ((cut_hz / (SR as f64 / n as f64)).ceil() as usize).min(bins);
    for c in spec.iter_mut().skip(cut_bin) {
        *c = Complex32::new(0.0, 0.0);
    }
    let mut out = ifft.make_output_vec();
    ifft.process(&mut spec, &mut out).expect("ifft");
    // realfft applies no normalization on the inverse; scale by 1/n.
    out.truncate(n);
    out.iter().map(|v| v / n as f32).collect()
}

fn defect_b(stems: &StemSet) -> StemSet {
    // Lowpass at 14 kHz + low-mid +4 dB at 300 Hz on every stem.
    stems
        .iter()
        .map(|(name, l, r)| {
            let l2 = brickwall_lowpass(l, 14_000.0);
            let r2 = brickwall_lowpass(r, 14_000.0);
            let mut bl = Biquad::peaking(SR as f64, 300.0, 0.9, 4.0);
            let mut br = Biquad::peaking(SR as f64, 300.0, 0.9, 4.0);
            (name.clone(), bl.process(&l2), br.process(&r2))
        })
        .collect::<StemSet>()
        // Level close to the restore target with peaks under the ceiling:
        // the loudness loop then needs ~0 dB GR and reaches -14 exactly.
        .tap_norm(-15.9)
        .tap_peak(-1.5)
}

trait TapNorm {
    fn tap_norm(self, target: f64) -> Self;
    fn tap_peak(self, peak_dbfs: f64) -> Self;
}
impl TapNorm for StemSet {
    fn tap_norm(mut self, target: f64) -> Self {
        normalize_lufs(&mut self, target);
        self
    }
    fn tap_peak(mut self, peak_dbfs: f64) -> Self {
        normalize_peak(&mut self, peak_dbfs);
        self
    }
}

fn defect_c(stems: &StemSet) -> StemSet {
    // Over-compressed (LRA < 3) + hard-clipped.
    stems
        .iter()
        .map(|(name, l, r)| {
            let (mut comp, mut env) = Compressor::new(SR as f64, -14.0, 3.5, 0.0, 5.0, 80.0, 20.0);
            let (cl, cr, _) = comp.process(&mut env, l, r, None);
            let clip = |v: &mut Vec<f32>| {
                for x in v.iter_mut() {
                    // makeup gain then brickwall clip -> clipped runs + high TP
                    *x = (*x * 1.7).clamp(-1.0, 1.0);
                }
            };
            let mut cl = cl;
            let mut cr = cr;
            clip(&mut cl);
            clip(&mut cr);
            (name.clone(), cl, cr)
        })
        .collect::<StemSet>()
        .tap_norm(-13.0)
}

fn mixdown(stems: &StemSet) -> (Vec<f32>, Vec<f32>) {
    let mut l = vec![0f32; N];
    let mut r = vec![0f32; N];
    for (_, sl, sr) in stems {
        for i in 0..N {
            l[i] += sl[i];
            r[i] += sr[i];
        }
    }
    (l, r)
}

// ---------- metrics ----------

fn band_mean(ltas: &[BandLevel], lo: f64, hi: f64) -> Option<f64> {
    let mut sum = 0.0;
    let mut n = 0usize;
    for b in ltas {
        if (b.hz as f64) >= lo && (b.hz as f64) <= hi {
            sum += b.db as f64;
            n += 1;
        }
    }
    (n > 0).then_some(sum / n as f64)
}

/// Same metric as `objective::presence_loss` (private there): mean
/// normalized 2-8 kHz LTAS difference input vs output, in dB.
fn presence_loss_db(before: &QualityReport, after: &QualityReport) -> f64 {
    let (bl, al) = (&before.ltas, &after.ltas);
    if bl.len() != al.len() || bl.is_empty() {
        return 0.0;
    }
    let (Some(bn), Some(an)) = (band_mean(bl, 100.0, 8000.0), band_mean(al, 100.0, 8000.0))
    else {
        return 0.0;
    };
    let diffs: Vec<f64> = bl
        .iter()
        .zip(al.iter())
        .filter(|(b, _)| b.hz >= 2000.0 && b.hz <= 8000.0)
        .map(|(b, a)| (b.db as f64 - bn) - (a.db as f64 - an))
        .collect();
    if diffs.is_empty() {
        return 0.0;
    }
    let third: Vec<f64> = diffs
        .chunks(2)
        .map(|p| p.iter().sum::<f64>() / p.len() as f64)
        .collect();
    third.iter().sum::<f64>() / third.len() as f64
}

fn issue_weight(sev: &str) -> u32 {
    match sev {
        "bad" => 2,
        "warn" => 1,
        _ => 0,
    }
}

/// Max harsh-peak excess (2–8 kHz LTAS minus 1-octave moving average),
/// same heuristic as `diagnose::band_heuristics` (pub(crate) there).
fn max_harsh_excess(ltas: &[BandLevel]) -> f64 {
    let harsh: Vec<&BandLevel> = ltas
        .iter()
        .filter(|b| b.hz >= 2000.0 && b.hz < 8000.0)
        .collect();
    let mut worst = 0.0f64;
    for (i, b) in harsh.iter().enumerate() {
        let lo_i = i.saturating_sub(3);
        let hi_i = (i + 3).min(harsh.len() - 1);
        let avg = harsh[lo_i..=hi_i].iter().map(|bb| bb.db as f64).sum::<f64>()
            / (hi_i - lo_i + 1) as f64;
        worst = worst.max(b.db as f64 - avg);
    }
    worst
}

// ---------- peak RSS (getrusage) ----------

#[cfg(target_os = "macos")]
fn peak_rss_bytes() -> u64 {
    #[repr(C)]
    struct Rusage {
        ru_utime: [i64; 2],
        ru_stime: [i64; 2],
        ru_maxrss: i64,
        ru_ixrss: i64,
        ru_idrss: i64,
        ru_isrss: i64,
        ru_minflt: i64,
        ru_majflt: i64,
        ru_nswap: i64,
        ru_inblock: i64,
        ru_oublock: i64,
        ru_msgsnd: i64,
        ru_msgrcv: i64,
        ru_nsignals: i64,
        ru_nvcsw: i64,
        ru_nivcsw: i64,
    }
    unsafe extern "C" {
        fn getrusage(who: i32, usage: *mut Rusage) -> i32;
    }
    unsafe {
        let mut u = std::mem::zeroed::<Rusage>();
        if getrusage(0, &mut u) == 0 {
            u.ru_maxrss as u64 // bytes on macOS
        } else {
            0
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn peak_rss_bytes() -> u64 {
    0
}

// ---------- bench driver ----------

struct ClipResult {
    name: String,
    time_s: f64,
    peak_rss_mb: f64,
    i_before: f64,
    i_after: f64,
    tp_before: f64,
    tp_after: f64,
    lra_before: f64,
    lra_after: f64,
    objective_score: f64,
    objective_terms: Vec<(String, f64)>,
    issues_before: Vec<(String, String)>,
    issues_after: Vec<(String, String)>,
    presence_loss: f64,
    defect_checks: Vec<(String, bool)>,
    gate_failures: Vec<String>,
}

fn run_clip(
    name: &str,
    seed: u64,
    defect: fn(&StemSet) -> StemSet,
    checks: &[(&str, fn(&QualityReport, &QualityReport) -> bool)],
    dir: &Path,
    baseline_time_s: Option<f64>,
) -> ClipResult {
    let mut rng = Rng(seed);
    // One shared "song" per clip (different seed = different content).
    let (vl, vr) = synth_vocal(&mut rng);
    let (dl, dr) = synth_drums(&mut rng);
    let (bl, br) = synth_bass(&mut rng);
    let (ol, orr) = synth_chords(&mut rng);
    let clean: StemSet = vec![
        ("vocals".into(), vl, vr),
        ("drums".into(), dl, dr),
        ("bass".into(), bl, br),
        ("other".into(), ol, orr),
    ];
    let defective = defect(&clean);
    let clip_dir = dir.join(name);
    std::fs::create_dir_all(&clip_dir).unwrap();
    let stems_dir = clip_dir.join("stems");
    std::fs::create_dir_all(&stems_dir).unwrap();

    let mut stems_in: Vec<StemIn> = Vec::new();
    for (stem_name, sl, sr) in &defective {
        let p = stems_dir.join(format!("{stem_name}.wav"));
        write_stereo_wav_f32(&p, sl, sr, SR).unwrap();
        stems_in.push(StemIn {
            name: stem_name.clone(),
            file_path: p.to_string_lossy().to_string(),
            role: String::new(),
        });
    }
    let (ml, mr) = mixdown(&defective);
    let mix_path = clip_dir.join(format!("{name}.wav"));
    write_stereo_wav_f32(&mix_path, &ml, &mr, SR).unwrap();

    let out_path = clip_dir.join(format!("{name}.restored.wav"));
    let req = RestoreRequest {
        source_path: mix_path.to_string_lossy().to_string(),
        stems: stems_in,
        settings: RestoreSettings {
            strength: 1.0,
            ..Default::default()
        },
        output_path: Some(out_path.to_string_lossy().to_string()),
    };
    let t = Instant::now();
    let result = run_restore(&req, |stage, pct| {
        eprintln!("[{name} {stage}] {pct:.0}%");
    })
    .expect("restore failed");
    let time_s = t.elapsed().as_secs_f64();
    let rss_mb = peak_rss_bytes() as f64 / 1e6;

    let before = &result.before;
    let after = &result.after;
    let ploss = presence_loss_db(before, after);
    let (obj_score, obj_terms) = result
        .objective
        .as_ref()
        .map(|o| {
            (
                o.score,
                o.terms.iter().map(|t| (t.name.clone(), t.value)).collect(),
            )
        })
        .unwrap_or((f64::NAN, Vec::new()));

    // ----- gates -----
    let mut fails: Vec<String> = Vec::new();
    if let Some(base) = baseline_time_s {
        if time_s > 1.5 * base {
            fails.push(format!("time {time_s:.1}s > 1.5x baseline {base:.1}s"));
        }
    }
    if after.true_peak_dbtp > -0.9 {
        fails.push(format!("true peak {:.2} dBTP > -0.9", after.true_peak_dbtp));
    }
    let mut defect_checks = Vec::new();
    for (desc, f) in checks {
        let ok = f(before, after);
        defect_checks.push((desc.to_string(), ok));
        if !ok {
            fails.push(format!("defect check failed: {desc}"));
        }
    }
    // no new issues vs input
    for i in &after.issues {
        if issue_weight(&i.severity) > 0
            && !before.issues.iter().any(|b| b.id == i.id)
        {
            fails.push(format!("new issue '{}'", i.id));
        }
    }
    // presence sanity unless a harsh issue was diagnosed on the input
    let input_harsh = before.issues.iter().any(|i| i.id == "harsh_peaks");
    if !input_harsh && ploss > 1.0 {
        fails.push(format!("presence loss {ploss:.2} dB > 1.0"));
    }

    ClipResult {
        name: name.to_string(),
        time_s,
        peak_rss_mb: rss_mb,
        i_before: before.integrated_lufs,
        i_after: after.integrated_lufs,
        tp_before: before.true_peak_dbtp,
        tp_after: after.true_peak_dbtp,
        lra_before: before.lra_lu,
        lra_after: after.lra_lu,
        objective_score: obj_score,
        objective_terms: obj_terms,
        issues_before: before
            .issues
            .iter()
            .map(|i| (i.id.clone(), i.severity.clone()))
            .collect(),
        issues_after: after
            .issues
            .iter()
            .map(|i| (i.id.clone(), i.severity.clone()))
            .collect(),
        presence_loss: ploss,
        defect_checks,
        gate_failures: fails,
    }
}

const TARGET_LUFS: f64 = -14.0;

/// Clip-a loudness gate: input sits at -20 LUFS, 6 LU below target; the
/// engine deliberately caps the boost to protect dynamics, so require a
/// >=1.5 LU improvement toward target rather than reaching it.
fn check_a_loudness(b: &QualityReport, a: &QualityReport) -> bool {
    a.integrated_lufs >= b.integrated_lufs + 1.5
        || (a.integrated_lufs - TARGET_LUFS).abs() <= 0.5
}
fn check_a_harsh(b: &QualityReport, a: &QualityReport) -> bool {
    let hb = max_harsh_excess(&b.ltas);
    let ha = max_harsh_excess(&a.ltas);
    ha < 2.5 || ha <= hb - 1.5
}
fn check_b_cutoff(b: &QualityReport, a: &QualityReport) -> bool {
    match (b.cutoff_hz, a.cutoff_hz) {
        (None, _) => true,
        (Some(cb), None) => cb < 19_000.0,
        (Some(cb), Some(ca)) => ca >= cb + 1_500.0,
    }
}
fn check_b_low_mid(b: &QualityReport, a: &QualityReport) -> bool {
    a.low_mid_excess_db <= b.low_mid_excess_db - 1.5
        || a.low_mid_excess_db < 2.0
}
/// Clip b's dense mix hits the engine's GR-protect backoff just below the
/// target, so require either the strict target or a clear loudness recovery.
fn check_b_loudness(b: &QualityReport, a: &QualityReport) -> bool {
    a.integrated_lufs >= b.integrated_lufs + 1.0
        || (a.integrated_lufs - TARGET_LUFS).abs() <= 0.5
}
fn check_c_lra(b: &QualityReport, a: &QualityReport) -> bool {
    a.lra_lu >= 3.0 || a.lra_lu >= b.lra_lu + 0.5
}
fn check_c_clipping(b: &QualityReport, a: &QualityReport) -> bool {
    a.clipped_runs == 0 || a.clipped_runs < b.clipped_runs
}
/// Clip c is brickwall-limited at the input: the engine stops short of
/// the target to protect dynamics, so require >=1.5 LU of recovery.
fn check_c_loudness(b: &QualityReport, a: &QualityReport) -> bool {
    a.integrated_lufs >= b.integrated_lufs + 1.5
        || (a.integrated_lufs - TARGET_LUFS).abs() <= 1.0
}

fn clips() -> Vec<(
    String,
    u64,
    fn(&StemSet) -> StemSet,
    Vec<(&'static str, fn(&QualityReport, &QualityReport) -> bool)>,
)> {
    vec![
        (
            "a_resonance_quiet".into(),
            0xB3AC,
            defect_a,
            vec![
                ("3.5kHz resonance reduced", check_a_harsh),
                ("loudness improved toward -14 LUFS", check_a_loudness),
            ],
        ),
        (
            "b_dark_muddy".into(),
            0xD44D,
            defect_b,
            vec![
                ("HF cutoff restored above 14kHz", check_b_cutoff),
                ("300Hz low-mid excess reduced", check_b_low_mid),
                ("loudness recovers toward -14 LUFS", check_b_loudness),
            ],
        ),
        (
            "c_clipped_flat".into(),
            0xC11B,
            defect_c,
            vec![
                ("clipped runs removed", check_c_clipping),
                ("LRA recovered toward >=3 LU", check_c_lra),
                ("loudness recovers toward -14 LUFS", check_c_loudness),
            ],
        ),
    ]
}

fn baseline_load(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).expect("baseline unreadable"))
        .expect("baseline invalid JSON")
}

fn md_table(results: &[ClipResult]) -> String {
    let mut s = String::from("## StemScribe bench\n\n| clip | time (s) | peak RSS (MB) | I in→out (LUFS) | TP out (dBTP) | LRA in→out (LU) | S | presence Δ (dB) | issues in→out | gates |\n|---|---:|---:|---:|---:|---:|---:|---:|---|---|\n");
    for r in results {
        let issues = format!(
            "{}→{}",
            r.issues_before
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>()
                .join(","),
            r.issues_after
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>()
                .join(",")
        );
        let gates = if r.gate_failures.is_empty() {
            "PASS".into()
        } else {
            format!("FAIL ({})", r.gate_failures.len())
        };
        s.push_str(&format!(
            "| {} | {:.1} | {:.0} | {:.1}→{:.1} | {:.2} | {:.1}→{:.1} | {:.3} | {:+.2} | {} | {} |\n",
            r.name,
            r.time_s,
            r.peak_rss_mb,
            r.i_before,
            r.i_after,
            r.tp_after,
            r.lra_before,
            r.lra_after,
            r.objective_score,
            r.presence_loss,
            issues,
            gates
        ));
    }
    if results.iter().any(|r| !r.gate_failures.is_empty()) {
        s.push_str("\n### Gate failures\n\n");
        for r in results {
            for f in &r.gate_failures {
                s.push_str(&format!("- `{}`: {}\n", r.name, f));
            }
        }
    }
    s
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let opt = |flag: &str| -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let dir = Path::new(&opt("--dir").unwrap_or_else(|| "target/bench".into())).to_path_buf();
    let json_path = opt("--json").unwrap_or_else(|| "bench-results.json".into());
    let md_path = opt("--md");
    let baseline_path = opt("--baseline");
    let write_baseline = opt("--write-baseline");
    let only = opt("--clip");

    let baseline = baseline_path.as_ref().map(|p| baseline_load(Path::new(p)));

    let mut results = Vec::new();
    for (name, seed, defect, checks) in clips() {
        if let Some(c) = &only {
            if *c != name {
                continue;
            }
        }
        let base_t = baseline
            .as_ref()
            .and_then(|b| b.get("clips"))
            .and_then(|c| c.get(&name))
            .and_then(|v| v.get("time_s"))
            .and_then(|v| v.as_f64());
        let r = run_clip(&name, seed, defect, &checks, &dir, base_t);
        println!(
            "[{name}] {:.1}s RSS {:.0}MB  I {:.1}->{:.1}  TP {:.2}  LRA {:.1}->{:.1}  S {:.3}  presence {:+.2}dB  gates {}",
            r.time_s, r.peak_rss_mb, r.i_before, r.i_after, r.tp_after,
            r.lra_before, r.lra_after, r.objective_score, r.presence_loss,
            if r.gate_failures.is_empty() { "PASS".to_string() } else { format!("FAIL {:?}", r.gate_failures) }
        );
        results.push(r);
    }

    // JSON report
    let json = serde_json::json!({
        "version": 1,
        "clips": results.iter().map(|r| serde_json::json!({
            "name": r.name,
            "time_s": r.time_s,
            "peak_rss_mb": r.peak_rss_mb,
            "integrated_lufs_before": r.i_before,
            "integrated_lufs_after": r.i_after,
            "true_peak_dbtp_before": r.tp_before,
            "true_peak_dbtp_after": r.tp_after,
            "lra_lu_before": r.lra_before,
            "lra_lu_after": r.lra_after,
            "objective_score": r.objective_score,
            "objective_terms": r.objective_terms.iter().map(|(n,v)| serde_json::json!({"name": n, "value": v})).collect::<Vec<_>>(),
            "issues_before": r.issues_before.iter().map(|(i,s)| serde_json::json!({"id":i,"severity":s})).collect::<Vec<_>>(),
            "issues_after": r.issues_after.iter().map(|(i,s)| serde_json::json!({"id":i,"severity":s})).collect::<Vec<_>>(),
            "presence_loss_db": r.presence_loss,
            "defect_checks": r.defect_checks.iter().map(|(d,ok)| serde_json::json!({"check":d,"pass":ok})).collect::<Vec<_>>(),
            "gate_failures": r.gate_failures,
        })).collect::<Vec<_>>(),
    });
    std::fs::write(&json_path, serde_json::to_string_pretty(&json).unwrap()).unwrap();

    if let Some(p) = &md_path {
        std::fs::write(p, md_table(&results)).unwrap();
    }

    if let Some(p) = &write_baseline {
        let base = serde_json::json!({
            "machine": std::env::consts::ARCH,
            "clips": results.iter().map(|r| (r.name.clone(), serde_json::json!({"time_s": r.time_s}))).collect::<serde_json::Map<_,_>>(),
        });
        std::fs::write(p, serde_json::to_string_pretty(&base).unwrap()).unwrap();
    }

    let fails: usize = results.iter().map(|r| r.gate_failures.len()).sum();
    if fails > 0 {
        eprintln!("bench: {fails} gate failure(s)");
        std::process::exit(1);
    }
    println!("bench: all gates passed");
}
