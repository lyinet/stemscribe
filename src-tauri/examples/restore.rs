//! Restoration render: separates (with stem cache), runs the delta-remix
//! restoration pipeline, prints before/after quality JSON + notes + timings.
//! Usage: cargo run --release --example restore -- <input> <out_dir> [light|standard|strong] [--ref <path>] [--drums <0.3|0.5|0.8>]

use stemscribe_lib::audio::restore::{RestoreRequest, RestoreSettings, StemIn};
use stemscribe_lib::ml::separator::run_separation;
use std::path::Path;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let input = args.first().expect("usage: restore <input> <out_dir> [strength] [--ref p] [--drums a]").clone();
    let out_dir = args.get(1).expect("usage: restore <input> <out_dir> [strength] [--ref p] [--drums a]").clone();
    let strength_tag = args.get(2).cloned().unwrap_or_else(|| "standard".into());
    let strength = match strength_tag.as_str() {
        "light" => 0.5,
        "strong" => 1.5,
        _ => 1.0,
    };
    let opt = |flag: &str| -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let ref_path = opt("--ref");
    let drums_amount = opt("--drums").map(|v| v.parse::<f32>().expect("--drums needs 0.3/0.5/0.8"));
    std::fs::create_dir_all(&out_dir).unwrap();

    let fname = Path::new(&input).file_name().unwrap().to_string_lossy().to_string();
    let stems_dir = Path::new(&out_dir).join(format!("stems_{fname}"));

    // --- separation (cached) ---
    let t_sep = Instant::now();
    let stems: Vec<StemIn>;
    if stems_dir.is_dir()
        && std::fs::read_dir(&stems_dir).unwrap().filter(|e| {
            e.as_ref().unwrap().path().extension().is_some_and(|x| x == "wav")
        }).count() >= 4
    {
        println!("reusing cached stems in {}", stems_dir.display());
        stems = std::fs::read_dir(&stems_dir)
            .unwrap()
            .filter_map(|e| {
                let p = e.unwrap().path();
                if p.extension().is_some_and(|x| x == "wav") {
                    Some(StemIn {
                        name: p.file_stem().unwrap().to_string_lossy().to_string(),
                        file_path: p.to_string_lossy().to_string(),
                    })
                } else {
                    None
                }
            })
            .collect();
    } else {
        std::fs::create_dir_all(&stems_dir).unwrap();
        let outs = run_separation(&input, Some(stems_dir.to_string_lossy().to_string()))
            .expect("separation failed");
        stems = outs
            .iter()
            .map(|o| StemIn { name: o.name.clone(), file_path: o.file_path.clone() })
            .collect();
    }
    let sep_s = t_sep.elapsed().as_secs_f64();
    println!("separation/cache done in {sep_s:.1}s ({} stems)", stems.len());
    for s in &stems {
        println!("  stem: {}", s.file_path);
    }

    // --- restore ---
    let fname_base = Path::new(&input).file_name().unwrap().to_string_lossy().to_string();
    let tag = if ref_path.is_some() {
        format!("{strength_tag}_ref")
    } else if drums_amount.is_some() {
        format!("{strength_tag}_drums")
    } else {
        strength_tag.clone()
    };
    let out_path = Path::new(&out_dir)
        .join(format!("{fname_base}.restored_{tag}.wav"))
        .to_string_lossy()
        .to_string();
    let req = RestoreRequest {
        source_path: input.clone(),
        stems,
        settings: RestoreSettings {
            strength,
            reference_path: ref_path.clone(),
            modules: stemscribe_lib::audio::restore::RestoreModules {
                drum_replace: drums_amount.is_some(),
                ..Default::default()
            },
            drum_replace_amount: drums_amount.unwrap_or(0.5),
            ..Default::default()
        },
        output_path: Some(out_path),
    };
    let t_res = Instant::now();
    let t_stages = Instant::now();
    let result = stemscribe_lib::audio::restore::run_restore(&req, |stage, pct| {
        eprintln!("[+{:.1}s {stage}] {pct:.0}%", t_stages.elapsed().as_secs_f64());
    })
    .expect("restore failed");
    let res_s = t_res.elapsed().as_secs_f64();

    println!("\n=== BEFORE ===");
    println!("{}", serde_json::to_string_pretty(&result.before).unwrap());
    println!("=== AFTER ===");
    println!("{}", serde_json::to_string_pretty(&result.after).unwrap());
    println!("=== NOTES ===");
    for n in &result.notes {
        println!("  - {n}");
    }
    println!("limiter_avg_gr_db = {:.2}", result.limiter_avg_gr_db);
    println!("loudness_match_db = {:+.2}", result.loudness_match_db);
    if let Some(r) = &result.reference {
        println!(
            "reference distance: {:.2} -> {:.2} dB ({})",
            r.distance_before_db, r.distance_after_db, r.path
        );
    }
    if let Some(a) = drums_amount {
        let dur_min = result.before.duration_sec / 60.0;
        for n in &result.notes {
            if let Some(rest) = n.strip_prefix("叠加真实鼓：") {
                // Parts are "底鼓 kept/raw" — sum the kept counts.
                let total: u64 = rest
                    .split('、')
                    .filter_map(|p| {
                        p.split('/')
                            .next()?
                            .chars()
                            .filter(|c| c.is_ascii_digit())
                            .collect::<String>()
                            .parse::<u64>()
                            .ok()
                    })
                    .sum();
                println!(
                    "drum hits: {rest} | total {} kept hits, {:.0} hits/min (amount {a})",
                    total,
                    total as f64 / dur_min.max(1e-9)
                );
            }
            if n.starts_with("鼓点不够规整") {
                println!("drum hits: {n}");
            }
        }
    }
    println!("separation: {sep_s:.1}s | restore: {res_s:.1}s");
    println!("output: {}", result.output_path);
}
