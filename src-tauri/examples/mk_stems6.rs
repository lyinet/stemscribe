//! Build a Suno-like 6-stem set from a 4-stem separation dir.
//! Usage: mk_stems6 <stems_dir> <out_dir> <basename>
//!   vocals -> Vocals (-0.4 dB) + Backing Vocals (-20 dB)
//!   other  -> Guitar (-6 dB) + Synth (-6 dB)   (they sum back to `other`)
//!   drums, bass -> copied as-is

use stemscribe_lib::audio::{decode_audio_file, write_stereo_wav_f32};
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let src_dir = args.first().expect("usage: mk_stems6 <stems_dir> <out_dir> <basename>").clone();
    let out_dir = args.get(1).expect("usage: mk_stems6 <stems_dir> <out_dir> <basename>").clone();
    let base = args.get(2).cloned().unwrap_or_else(|| "song".into());
    std::fs::create_dir_all(&out_dir).unwrap();

    let load = |name: &str| -> (Vec<f32>, Vec<f32>, u32) {
        let d = decode_audio_file(&format!("{src_dir}/{name}.wav")).expect("decode failed");
        let (l, r) = d.to_stereo_planar();
        (l, r, d.sample_rate)
    };
    let scale = |v: &[f32], db: f64| -> Vec<f32> {
        let g = 10f64.powf(db / 20.0) as f32;
        v.iter().map(|&x| x * g).collect()
    };
    let write = |tag: &str, l: &[f32], r: &[f32], sr: u32| {
        let p = Path::new(&out_dir).join(format!("{base} ({tag}).wav"));
        write_stereo_wav_f32(&p, l, r, sr).expect("write failed");
        println!("wrote {}", p.display());
    };

    let (vl, vr, vsr) = load("vocals");
    write("Vocals", &scale(&vl, -0.4), &scale(&vr, -0.4), vsr);
    write("Backing Vocals", &scale(&vl, -20.0), &scale(&vr, -20.0), vsr);
    drop((vl, vr));

    let (ol, orr, osr) = load("other");
    write("Guitar", &scale(&ol, -6.0), &scale(&orr, -6.0), osr);
    write("Synth", &scale(&ol, -6.0), &scale(&orr, -6.0), osr);
    drop((ol, orr));

    let (dl, dr, dsr) = load("drums");
    write("Drums", &dl, &dr, dsr);
    drop((dl, dr));
    let (bl, br, bsr) = load("bass");
    write("Bass", &bl, &br, bsr);
}
