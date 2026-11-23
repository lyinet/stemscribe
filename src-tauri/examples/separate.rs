//! Measure standard vs high-quality (HTDemucs-FT vocals) separation on
//! one song: wall time, and rms(x44 − Σstems)/rms(x44) for both
//! qualities — identical by construction since the FT path preserves
//! the stem sum. Writes stems under <out_dir>/<file>/.
//! Usage: cargo run --release --example separate -- <input> <out_dir>

use stemscribe_lib::audio::{decode_audio_file, resample::resample_hq_stereo};
use stemscribe_lib::ml::separator::run_separation;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn rss_mb() -> f64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output();
    out.ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(0.0)
        / 1024.0
}

fn rms(v: &[f32]) -> f64 {
    (v.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>() / v.len().max(1) as f64).sqrt()
}

/// Decode the four stem wavs in `dir`, sum per channel, and return the
/// residual ratio rms(x44 − Σstems)/rms(x44) for L and R.
fn stem_sum_residual(dir: &Path, x44_l: &[f32], x44_r: &[f32]) -> (f64, f64) {
    let n = x44_l.len().min(x44_r.len());
    let mut sum_l = vec![0.0f32; n];
    let mut sum_r = vec![0.0f32; n];
    for name in ["drums", "bass", "other", "vocals"] {
        let p = dir.join(format!("{name}.wav"));
        let d = decode_audio_file(p.to_str().unwrap()).expect("stem decode failed");
        let (l, r) = d.to_stereo_planar();
        for i in 0..n.min(l.len()) {
            sum_l[i] += l[i];
            sum_r[i] += r[i];
        }
    }
    let (mut res_l, mut res_r) = (0.0f64, 0.0f64);
    for i in 0..n {
        let dl = x44_l[i] - sum_l[i];
        let dr = x44_r[i] - sum_r[i];
        res_l += (dl as f64) * (dl as f64);
        res_r += (dr as f64) * (dr as f64);
    }
    (
        (res_l / n as f64).sqrt() / rms(x44_l).max(1e-12),
        (res_r / n as f64).sqrt() / rms(x44_r).max(1e-12),
    )
}

fn main() -> anyhow::Result<()> {
    let input = std::env::args().nth(1).expect("usage: separate <input> <out_dir> [std|high]");
    let out_dir = PathBuf::from(std::env::args().nth(2).expect("usage: separate <input> <out_dir>"));
    let only = std::env::args().nth(3); // Some("std"|"high") → single-run RSS probe
    let fname = Path::new(&input)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let song_dir = out_dir.join(&fname);

    if let Some(q) = &only {
        let high = q == "high";
        let dir = song_dir.join(q);
        std::fs::create_dir_all(&dir)?;
        let t = Instant::now();
        run_separation(&input, Some(dir.to_string_lossy().to_string()), high)?;
        println!("{q}: {:.1}s  rss {:.0} MB", t.elapsed().as_secs_f64(), rss_mb());
        return Ok(());
    }

    let std_dir = song_dir.join("std");
    let high_dir = song_dir.join("high");
    std::fs::create_dir_all(&std_dir)?;
    std::fs::create_dir_all(&high_dir)?;

    let decoded = decode_audio_file(&input)?;
    let (l_raw, r_raw) = decoded.to_stereo_planar();
    let (x44_l, x44_r) = resample_hq_stereo(&l_raw, &r_raw, decoded.sample_rate, 44_100);
    drop(decoded);
    drop(l_raw);
    drop(r_raw);

    let t0 = Instant::now();
    run_separation(&input, Some(std_dir.to_string_lossy().to_string()), false)?;
    let t_std = t0.elapsed().as_secs_f64();
    let rss_std = rss_mb();
    println!("standard: {t_std:.1}s  rss {rss_std:.0} MB");

    let t1 = Instant::now();
    run_separation(&input, Some(high_dir.to_string_lossy().to_string()), true)?;
    let t_high = t1.elapsed().as_secs_f64();
    let rss_high = rss_mb();
    println!("high:     {t_high:.1}s  rss {rss_high:.0} MB");

    let (res_std_l, res_std_r) = stem_sum_residual(&std_dir, &x44_l, &x44_r);
    let (res_hi_l, res_hi_r) = stem_sum_residual(&high_dir, &x44_l, &x44_r);
    println!("residual rms(x44 − Σstems)/rms(x44):");
    println!("  std  L {res_std_l:.6}  R {res_std_r:.6}");
    println!("  high L {res_hi_l:.6}  R {res_hi_r:.6}");

    // Required comparison artifacts: {std,high}_vocals.wav + all high stems.
    std::fs::copy(std_dir.join("vocals.wav"), song_dir.join("std_vocals.wav"))?;
    std::fs::copy(high_dir.join("vocals.wav"), song_dir.join("high_vocals.wav"))?;
    println!("wrote {}/std_vocals.wav + high_vocals.wav (+ stems in std/ and high/)", song_dir.display());
    Ok(())
}
