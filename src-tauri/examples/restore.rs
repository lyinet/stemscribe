//! Restoration render: separates (with stem cache), runs the delta-remix
//! restoration pipeline, prints before/after quality JSON + notes + timings.
//! Usage: cargo run --release --example restore -- <input> <out_dir> [light|standard|strong]

use stemscribe_lib::audio::restore::{RestoreRequest, RestoreSettings, StemIn};
use stemscribe_lib::ml::separator::run_separation;
use std::path::Path;
use std::time::Instant;

fn main() {
    let input = std::env::args().nth(1).expect("usage: restore <input> <out_dir> [strength]");
    let out_dir = std::env::args().nth(2).expect("usage: restore <input> <out_dir> [strength]");
    let strength_tag = std::env::args().nth(3).unwrap_or_else(|| "standard".into());
    let strength = match strength_tag.as_str() {
        "light" => 0.5,
        "strong" => 1.5,
        _ => 1.0,
    };
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
    let out_path = Path::new(&out_dir)
        .join(format!("{fname_base}.restored_{strength_tag}.wav"))
        .to_string_lossy()
        .to_string();
    let req = RestoreRequest {
        source_path: input.clone(),
        stems,
        settings: RestoreSettings {
            strength,
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
    println!("separation: {sep_s:.1}s | restore: {res_s:.1}s");
    println!("output: {}", result.output_path);
}
