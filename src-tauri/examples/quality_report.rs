//! Prints the QualityReport for a file as JSON.
//! Usage: cargo run --release --example quality_report -- <audio> > report.json

use stemscribe_lib::audio::quality::analyze_quality;

fn main() {
    let path = std::env::args().nth(1).expect("usage: quality_report <audio>");
    let t0 = std::time::Instant::now();
    let report = analyze_quality(&path).expect("analysis failed");
    eprintln!("analyzed in {:.2}s", t0.elapsed().as_secs_f64());
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
