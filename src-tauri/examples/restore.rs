//! Restoration render: separates (with stem cache), runs the delta-remix
//! restoration pipeline, prints before/after quality JSON + notes + timings.
//!
//! Usage:
//!   restore <input> <out_dir> [light|standard|strong] [--ref <path>] [--drums <0.3|0.5|0.8>] [--stems <dir>]
//!   restore --compare <input> <out_dir>            # three-strength comparison
//!   restore --import <stems_dir> <out_dir> [light|standard|strong]  # Suno-style stem import (mix = Σstems)

use stemscribe_lib::audio::restore::{run_restore_compare, RestoreRequest, RestoreSettings, StemIn};
use stemscribe_lib::audio::stem_import::{import_stems, ImportStemSpec};
use stemscribe_lib::ml::separator::run_separation;
use std::path::Path;
use std::time::Instant;

fn stems_from_dir(dir: &Path) -> Vec<StemIn> {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| {
            let p = e.unwrap().path();
            if p.extension().is_some_and(|x| x == "wav") {
                Some(StemIn {
                    name: p.file_stem().unwrap().to_string_lossy().to_string(),
                    file_path: p.to_string_lossy().to_string(),
                    role: String::new(),
                })
            } else {
                None
            }
        })
        .collect()
}

fn print_result(result: &stemscribe_lib::audio::restore::RestoreResult, sep_s: f64, res_s: f64) {
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
    if let Some(o) = &result.objective {
        println!("objective S = {:.3}", o.score);
        for t in &o.terms {
            println!("  {} = {:+.3}", t.name, t.value);
        }
    }
    if let (Some(a), Some(b)) = (&result.critic_before, &result.critic) {
        println!("critic PQ: {:.2} -> {:.2}", a.pq, b.pq);
    }
    if let Some(r) = &result.reference {
        println!(
            "reference distance: {:.2} -> {:.2} dB ({})",
            r.distance_before_db, r.distance_after_db, r.path
        );
    }
    println!("separation/import: {sep_s:.1}s | restore: {res_s:.1}s");
    println!("output: {}", result.output_path);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let opt = |flag: &str| -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };

    // ---------- --import <stems_dir> <out_dir> [strength] ----------
    if args.first().is_some_and(|a| a == "--import") {
        let stems_dir = args.get(1).expect("usage: restore --import <stems_dir> <out_dir> [strength]").clone();
        let out_dir = args.get(2).expect("usage: restore --import <stems_dir> <out_dir> [strength]").clone();
        let strength = match args.get(3).map(|s| s.as_str()) {
            Some("light") => 0.5,
            Some("strong") => 1.5,
            _ => 1.0,
        };
        let specs: Vec<ImportStemSpec> = std::fs::read_dir(&stems_dir)
            .unwrap()
            .filter_map(|e| {
                let p = e.unwrap().path();
                p.extension()
                    .is_some_and(|x| x == "wav")
                    .then(|| ImportStemSpec {
                        file_path: p.to_string_lossy().to_string(),
                        role: String::new(),
                    })
            })
            .collect();
        let t0 = Instant::now();
        let imp = import_stems(&specs, None).expect("stem import failed");
        let imp_s = t0.elapsed().as_secs_f64();
        println!("import: {} stems -> mix {} (synth={})", imp.stems.len(), imp.mix_path, imp.mix_is_synth);
        for s in &imp.stems {
            println!("  {} [{}] {}", s.name, s.role.clone().unwrap_or_default(), s.label_zh);
        }
        for n in &imp.notes {
            println!("  note: {n}");
        }
        let stems: Vec<StemIn> = imp
            .stems
            .iter()
            .map(|s| StemIn {
                name: s.name.clone(),
                file_path: s.file_path.clone(),
                role: s.role.clone().unwrap_or_default(),
            })
            .collect();
        let out_path = Path::new(&out_dir)
            .join("imported.restored.wav")
            .to_string_lossy()
            .to_string();
        std::fs::create_dir_all(&out_dir).unwrap();
        let req = RestoreRequest {
            source_path: imp.mix_path.clone(),
            stems,
            settings: RestoreSettings {
                strength,
                ..Default::default()
            },
            output_path: Some(out_path),
        };
        let t = Instant::now();
        let result = stemscribe_lib::audio::restore::run_restore(&req, |stage, pct| {
            eprintln!("[{stage}] {pct:.0}%");
        })
        .expect("restore failed");
        print_result(&result, imp_s, t.elapsed().as_secs_f64());
        return;
    }

    // ---------- --compare <input> <out_dir> ----------
    if args.first().is_some_and(|a| a == "--compare") {
        let input = args.get(1).expect("usage: restore --compare <input> <out_dir>").clone();
        let out_dir = args.get(2).expect("usage: restore --compare <input> <out_dir>").clone();
        let fname = Path::new(&input).file_name().unwrap().to_string_lossy().to_string();
        let stems_dir = Path::new(&out_dir).join(format!("stems_{fname}"));
        let stems = if stems_dir.is_dir() {
            println!("reusing cached stems in {}", stems_dir.display());
            stems_from_dir(&stems_dir)
        } else {
            std::fs::create_dir_all(&stems_dir).unwrap();
            run_separation(&input, Some(stems_dir.to_string_lossy().to_string()), false)
                .expect("separation failed")
                .iter()
                .map(|o| StemIn {
                    name: o.name.clone(),
                    file_path: o.file_path.clone(),
                    role: o.role.clone().unwrap_or_default(),
                })
                .collect()
        };
        let req = RestoreRequest {
            source_path: input.clone(),
            stems,
            settings: RestoreSettings::default(),
            output_path: None,
        };
        let t = Instant::now();
        let res = run_restore_compare(&req, |stage, pct| {
            eprintln!("[+{:.1}s {stage}] {pct:.0}%", t.elapsed().as_secs_f64());
        })
        .expect("compare failed");
        println!("\n=== COMPARE ({:.1}s total) ===", t.elapsed().as_secs_f64());
        println!(
            "input: I={:.2} LRA={:.2} TP={:.2}{}",
            res.before.integrated_lufs,
            res.before.lra_lu,
            res.before.true_peak_dbtp,
            res.critic_before
                .as_ref()
                .map(|c| format!(" PQ={:.2}", c.pq))
                .unwrap_or_default()
        );
        for (i, c) in res.candidates.iter().enumerate() {
            println!(
                "\n[{}] {} (x{:.2}){} -> {}",
                i,
                c.strength_label,
                c.strength,
                if i == res.recommended { " ★推荐" } else { "" },
                c.output_path
            );
            println!(
                "  S = {:.3} | issues {} | LRA {:.2}->{:.2} | TP {:.2} | I {:.2}{}",
                c.objective.score,
                c.after.issues.len(),
                res.before.lra_lu,
                c.after.lra_lu,
                c.after.true_peak_dbtp,
                c.after.integrated_lufs,
                c.critic
                    .as_ref()
                    .map(|k| format!(" | PQ {:.2}", k.pq))
                    .unwrap_or_default()
            );
            for t in &c.objective.terms {
                println!("    {} = {:+.3}", t.name, t.value);
            }
            if let Some(w) = &c.warning {
                println!("  ⚠ {w}");
            }
            for n in &c.notes {
                println!("  - {n}");
            }
        }
        println!("\n推荐: [{}] {}", res.recommended, res.candidates[res.recommended].strength_label);
        println!("reason: {}", res.reason);
        return;
    }

    // ---------- single render ----------
    let input = args.first().expect("usage: restore <input> <out_dir> [strength] [--ref p] [--drums a] [--stems dir]").clone();
    let out_dir = args.get(1).expect("usage: restore <input> <out_dir> [strength] [--ref p] [--drums a] [--stems dir]").clone();
    let strength_tag = args.get(2).cloned().unwrap_or_else(|| "standard".into());
    let strength = match strength_tag.as_str() {
        "light" => 0.5,
        "strong" => 1.5,
        _ => 1.0,
    };
    let ref_path = opt("--ref");
    let drums_amount = opt("--drums").map(|v| v.parse::<f32>().expect("--drums needs 0.3/0.5/0.8"));
    let stems_override = opt("--stems");
    std::fs::create_dir_all(&out_dir).unwrap();

    let fname = Path::new(&input).file_name().unwrap().to_string_lossy().to_string();

    // --- separation (cached) or explicit stems dir ---
    let t_sep = Instant::now();
    let stems: Vec<StemIn>;
    if let Some(sd) = stems_override {
        stems = stems_from_dir(Path::new(&sd));
        println!("using stems dir {sd}");
    } else {
        let stems_dir = Path::new(&out_dir).join(format!("stems_{fname}"));
        if stems_dir.is_dir()
            && std::fs::read_dir(&stems_dir).unwrap().filter(|e| {
                e.as_ref().unwrap().path().extension().is_some_and(|x| x == "wav")
            }).count() >= 4
        {
            println!("reusing cached stems in {}", stems_dir.display());
            stems = stems_from_dir(&stems_dir);
        } else {
            std::fs::create_dir_all(&stems_dir).unwrap();
            let outs = run_separation(&input, Some(stems_dir.to_string_lossy().to_string()), false)
                .expect("separation failed");
            stems = outs
                .iter()
                .map(|o| StemIn {
                    name: o.name.clone(),
                    file_path: o.file_path.clone(),
                    role: o.role.clone().unwrap_or_default(),
                })
                .collect();
        }
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
    print_result(&result, sep_s, res_s);
}
