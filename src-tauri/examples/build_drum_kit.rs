//! Builds the bundled drum kit for the 鼓替换 module.
//! Downloads Big Rusty Drums (CC0-1.0) FLACs, mixes mic channels,
//! trims/fades/normalizes, and writes mono 48 kHz 16-bit WAVs +
//! kit.json + LICENSE.txt into `src-tauri/resources/drums/`.
//!
//! Usage: cargo run --release --example build_drum_kit

use stemscribe_lib::audio::decode_audio_file;
use stemscribe_lib::audio::resample::resample_hq;
use std::path::{Path, PathBuf};

const BASE: &str = "https://raw.githubusercontent.com/sfzinstruments/karoryfer.big-rusty-drums/main";
const OUT_SR: u32 = 48_000;

/// (class, out layer 1..=5, source vl, rr)
const KICK_VL: [u32; 5] = [2, 5, 8, 11, 14];
const SNARE_VL: [u32; 5] = [1, 3, 5, 8, 10];
const HAT_VL: [u32; 5] = [1, 2, 3, 5, 6];
const RRS: [u32; 2] = [1, 2];

fn curl(url: &str, dest: &Path) -> Result<(), String> {
    for attempt in 0..4 {
        let st = std::process::Command::new("curl")
            .args(["-sfL", "--connect-timeout", "15", "--retry", "3", "-o"])
            .arg(dest)
            .arg(url)
            .status()
            .map_err(|e| e.to_string())?;
        if st.success() && dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(800 * (attempt + 1) as u64));
    }
    Err(format!("curl failed {url}"))
}

/// Decode a flac (downloading first), mix down to mono f32 at 48 kHz.
fn fetch_mono(cache: &Path, rel: &str) -> Vec<f32> {
    let dest = cache.join(rel.replace('/', "_"));
    if !dest.exists() {
        curl(&format!("{BASE}/{rel}"), &dest).expect("download");
    }
    let d = decode_audio_file(dest.to_str().unwrap()).expect("decode");
    let frames = d.samples.len() / d.channels.max(1);
    let mut mono = vec![0.0f32; frames];
    for i in 0..frames {
        let mut s = 0.0f32;
        for c in 0..d.channels {
            s += d.samples[i * d.channels + c];
        }
        mono[i] = s / d.channels as f32;
    }
    resample_hq(&mono, d.sample_rate, OUT_SR)
}

/// Trim leading silence to the attack, cap length, 20 ms fade-out.
fn finalize(mut x: Vec<f32>, max_len_s: f64) -> Vec<f32> {
    let peak = x.iter().fold(0.0f32, |m, v| m.max(v.abs())).max(1e-9);
    let thr = peak * 10f32.powf(-40.0 / 20.0);
    let pre = (0.001 * OUT_SR as f64) as usize;
    let first = x.iter().position(|v| v.abs() >= thr).unwrap_or(0);
    let start = first.saturating_sub(pre);
    x.drain(..start);
    let max_n = (max_len_s * OUT_SR as f64) as usize;
    x.truncate(max_n);
    let fade = (0.02 * OUT_SR as f64) as usize;
    let n = x.len();
    for i in 0..fade.min(n) {
        // raised-cosine 1 -> 0 over the last 20 ms
        x[n - fade + i] *= 0.5 + 0.5 * (i as f32 / fade as f32 * std::f32::consts::PI).cos();
    }
    x
}

fn write_wav(path: &Path, x: &[f32]) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: OUT_SR,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for &v in x {
        w.write_sample((v.clamp(-1.0, 1.0) * 32767.0).round() as i16).unwrap();
    }
    w.finalize().unwrap();
}

fn main() {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/drums");
    std::fs::create_dir_all(&out).unwrap();
    let cache = std::env::temp_dir().join("stemscribe_drumkit_dl");
    std::fs::create_dir_all(&cache).unwrap();

    let mut entries: Vec<(String, u32, u32, String, Vec<f32>)> = Vec::new();

    for (li, &vl) in KICK_VL.iter().enumerate() {
        for &rr in &RRS {
            let close = fetch_mono(&cache, &format!("Samples/kick_24/kick/kick/k_vl{vl}_rr{rr}.flac"));
            let oh = fetch_mono(&cache, &format!("Samples/kick_24/kick/oh/k_vl{vl}_rr{rr}.flac"));
            let n = close.len().min(oh.len());
            let x: Vec<f32> = (0..n).map(|i| close[i] + 0.5 * oh[i]).collect();
            entries.push(("kick".into(), (li + 1) as u32, rr, format!("kick_l{}_rr{rr}.wav", li + 1), x));
        }
    }
    for (li, &vl) in SNARE_VL.iter().enumerate() {
        for &rr in &RRS {
            let top = fetch_mono(&cache, &format!("Samples/snare_14/center/top/sn_center_vl{vl}_rr{rr}.flac"));
            let btm = fetch_mono(&cache, &format!("Samples/snare_14/center/btm/sn_center_vl{vl}_rr{rr}.flac"));
            let oh = fetch_mono(&cache, &format!("Samples/snare_14/center/oh/sn_center_vl{vl}_rr{rr}.flac"));
            let n = top.len().min(btm.len()).min(oh.len());
            let x: Vec<f32> = (0..n).map(|i| top[i] + 0.4 * btm[i] + 0.5 * oh[i]).collect();
            entries.push(("snare".into(), (li + 1) as u32, rr, format!("snare_l{}_rr{rr}.wav", li + 1), x));
        }
    }
    for (li, &vl) in HAT_VL.iter().enumerate() {
        for &rr in &RRS {
            let cl = fetch_mono(&cache, &format!("Samples/hihat_14/cl/cl/ht_cl_vl{vl}_rr{rr}.flac"));
            let oh = fetch_mono(&cache, &format!("Samples/hihat_14/cl/oh/ht_cl_vl{vl}_rr{rr}.flac"));
            let n = cl.len().min(oh.len());
            let x: Vec<f32> = (0..n).map(|i| cl[i] + 0.5 * oh[i]).collect();
            entries.push(("hihat".into(), (li + 1) as u32, rr, format!("hihat_l{}_rr{rr}.wav", li + 1), x));
        }
    }

    // Trim + length caps.
    for e in &mut entries {
        let cap = if e.0 == "hihat" { 0.6 } else { 1.2 };
        e.4 = finalize(std::mem::take(&mut e.4), cap);
    }

    // Peak-normalize per class preserving inter-layer ratios: the loudest
    // file of each class becomes 0.95, everything scales by that factor.
    let mut manifest: Vec<String> = Vec::new();
    for class in ["kick", "snare", "hihat"] {
        let class_peak = entries
            .iter()
            .filter(|e| e.0 == class)
            .fold(0.0f32, |m, e| m.max(e.4.iter().fold(0.0f32, |p, v| p.max(v.abs()))))
            .max(1e-9);
        let scale = 0.95 / class_peak;
        for e in entries.iter_mut().filter(|e| e.0 == class) {
            let raw_peak = e.4.iter().fold(0.0f32, |p, v| p.max(v.abs()));
            let level = raw_peak / class_peak;
            for v in &mut e.4 {
                *v *= scale;
            }
            write_wav(&out.join(&e.3), &e.4);
            manifest.push(format!(
                "  {{\"class\": \"{}\", \"layer\": {}, \"rr\": {}, \"file\": \"{}\", \"level\": {:.4}}}",
                e.0, e.1, e.2, e.3, level
            ));
        }
    }

    let json = format!(
        "{{\n  \"name\": \"big-rusty-drums\",\n  \"source\": \"https://github.com/sfzinstruments/karoryfer.big-rusty-drums\",\n  \"license\": \"CC0-1.0\",\n  \"sample_rate\": 48000,\n  \"samples\": [\n{}\n  ]\n}}\n",
        manifest.join(",\n")
    );
    std::fs::write(out.join("kit.json"), json).unwrap();
    std::fs::write(
        out.join("LICENSE.txt"),
        "Big Rusty Drums - Karoryfer Samples\n\
         Source: https://github.com/sfzinstruments/karoryfer.big-rusty-drums\n\
         License: CC0-1.0 (public domain)\n\
         https://creativecommons.org/publicdomain/zero/1.0/\n\
         \n\
         Courtesy attribution: drum samples by Karoryfer Samples,\n\
         used under CC0 1.0 Universal.\n",
    )
    .unwrap();

    let total: u64 = std::fs::read_dir(&out)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.metadata().unwrap().len())
        .sum();
    println!("kit written to {} ({} bytes, {:.2} MB)", out.display(), total, total as f64 / 1e6);
}
