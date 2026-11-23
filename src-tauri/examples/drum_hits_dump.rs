//! Dump drum_hits detections for a stem to CSV.
//! Usage: cargo run --release --example drum_hits_dump -- <drum_stem.wav> <out.csv>
//! Columns: time_sec,class,velocity_layer,peak_db,mid_low_db,mid_high_db,noise_mid
//! (mid_low_db/mid_high_db/noise_mid = the classifier's band-energy features,
//! recomputed in the ±12 ms window at each hit's refined position.)

use stemscribe_lib::audio::drum_hits::{self, DrumClass};
use stemscribe_lib::audio::{decode_audio_file, resample::resample_hq_stereo};
use std::fmt::Write as _;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let input = args.first().expect("usage: drum_hits_dump <stem.wav> <out.csv>");
    let out = args.get(1).expect("usage: drum_hits_dump <stem.wav> <out.csv>");

    // Same conditioning as restore.rs: decode -> 44.1 kHz stereo -> detect.
    let d = decode_audio_file(input).expect("decode failed");
    let (sl, sr) = d.to_stereo_planar();
    let (l44, r44) = resample_hq_stereo(&sl, &sr, d.sample_rate, 44_100);
    drop(d);
    drop(sl);
    drop(sr);
    let sr = 44_100.0f64;

    let hits = drum_hits::detect_hits(&l44, &r44, sr);
    let g = drum_hits::gate_hits(&hits, &l44, &r44, sr);
    eprintln!(
        "gate: beat={:.3}s on_grid={}/{} disabled={} kept={}",
        g.beat_sec,
        g.on_grid,
        g.gate1,
        g.disabled,
        g.hits.len()
    );
    let kept: std::collections::HashSet<(usize, u8)> = g
        .hits
        .iter()
        .map(|h| (h.pos, h.class as u8))
        .collect();

    // Rebuild the classifier's band-limited views to report its features.
    let n = l44.len().min(r44.len());
    let mono: Vec<f32> = (0..n).map(|i| (l44[i] + r44[i]) * 0.5).collect();
    let low = drum_hits::lr4_low(&mono, sr, 120.0);
    let mid = drum_hits::lr4_band(&mono, sr, 180.0, 2500.0);
    let high = drum_hits::lr4_high(&mono, sr, 7000.0);
    let noise = drum_hits::lr4_band(&mono, sr, 3000.0, 6000.0);
    let half_win = (0.012 * sr) as usize;

    let mut csv = String::from(
        "time_sec,class,velocity_layer,peak_db,mid_low_db,mid_high_db,noise_mid,kept\n",
    );
    for h in &hits {
        let a = h.pos.saturating_sub(half_win);
        let b = h.pos + half_win;
        let e_mid = drum_hits::window_energy(&mid, a, b);
        let e_low = drum_hits::window_energy(&low, a, b);
        let e_high = drum_hits::window_energy(&high, a, b);
        let e_noise = drum_hits::window_energy(&noise, a, b);
        let ml = 10.0 * (e_mid / e_low.max(1e-20)).log10();
        let mh = 10.0 * (e_mid / e_high.max(1e-20)).log10();
        let nm = e_noise / e_mid.max(1e-20);
        let cls = match h.class {
            DrumClass::Kick => "kick",
            DrumClass::Snare => "snare",
            DrumClass::Hihat => "hihat",
        };
        let k = usize::from(kept.contains(&(h.pos, h.class as u8)));
        writeln!(
            csv,
            "{:.4},{cls},{},{:.2},{ml:.2},{mh:.2},{nm:.5},{k}",
            h.pos as f64 / sr,
            h.layer,
            h.peak_db
        )
        .unwrap();
    }
    std::fs::write(out, &csv).expect("write csv failed");
    println!("{} hits -> {out}", hits.len());
}
