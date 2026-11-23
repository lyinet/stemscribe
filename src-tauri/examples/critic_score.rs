//! Score audio files with the Audiobox Aesthetics critic model.
//! Prints one JSON line per file: {file, ce, cu, pc, pq, secs, elapsed_ms}.
//! Usage: cargo run --release --example critic_score -- <file>...

use stemscribe_lib::audio::quality::critic::score_audio;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("usage: critic_score <file>...");
        std::process::exit(2);
    }
    for f in &files {
        let t = Instant::now();
        match score_audio(f) {
            Ok(s) => println!(
                "{{\"file\":{:?},\"ce\":{:.4},\"cu\":{:.4},\"pc\":{:.4},\"pq\":{:.4},\"secs\":{:.2},\"elapsed_ms\":{}}}",
                f, s.ce, s.cu, s.pc, s.pq, s.duration_sec, t.elapsed().as_millis()
            ),
            Err(e) => println!("{{\"file\":{f:?},\"error\":{e:?}}}"),
        }
    }
    Ok(())
}
