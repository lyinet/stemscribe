//! Separation alignment check: measures residual r = x44 - Σstems energy
//! ratio and the cross-correlation peak lag between x44 and Σstems.
//! Usage: cargo run --release --example sep_alignment -- <audio> [out_dir]

use realfft::RealFftPlanner;
use stemscribe_lib::audio::{decode_audio_file, resample::resample_hq_stereo};
use stemscribe_lib::ml::separator::run_separation;

fn rms(v: &[f32]) -> f64 {
    (v.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() / v.len().max(1) as f64).sqrt()
}

fn xcorr_peak_lag(a: &[f32], b: &[f32]) -> (isize, f64, f64) {
    let n = a.len().max(b.len());
    let nfft = (2 * n).next_power_of_two();
    let mut planner = RealFftPlanner::<f32>::new();
    let fwd = planner.plan_fft_forward(nfft);
    let inv = planner.plan_fft_inverse(nfft);

    let mut fa = fwd.make_input_vec();
    let mut fb = fwd.make_input_vec();
    fa[..a.len()].copy_from_slice(a);
    fb[..b.len()].copy_from_slice(b);
    let mut sa = fwd.make_output_vec();
    let mut sb = fwd.make_output_vec();
    fwd.process(&mut fa, &mut sa).unwrap();
    fwd.process(&mut fb, &mut sb).unwrap();

    // r = IFFT(conj(A) * B)
    let mut spec = inv.make_input_vec();
    for i in 0..spec.len() {
        spec[i] = sa[i].conj() * sb[i];
    }
    let mut r = inv.make_output_vec();
    inv.process(&mut spec, &mut r).unwrap();

    let norm = (nfft as f64) * rms(a) * rms(b);
    let mut best_lag = 0isize;
    let mut best_val = f64::MIN;
    let mut lag0_val = 0.0f64;
    for k in 0..nfft {
        let lag = if k <= nfft / 2 { k as isize } else { k as isize - nfft as isize };
        let v = r[k] as f64 / norm.max(1e-12);
        if lag == 0 {
            lag0_val = v;
        }
        if v > best_val {
            best_val = v;
            best_lag = lag;
        }
    }
    (best_lag, best_val, lag0_val)
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: sep_alignment <audio> [out_dir]");
    let out_dir = std::env::args().nth(2);
    println!("decoding {path}");
    let decoded = decode_audio_file(&path).expect("decode failed");
    let (l_raw, r_raw) = decoded.to_stereo_planar();
    let (x_l, _x_r) = resample_hq_stereo(&l_raw, &r_raw, decoded.sample_rate, 44_100);
    println!("x44 len = {}", x_l.len());

    println!("running separation (this takes a while)...");
    let t0 = std::time::Instant::now();
    let stems = run_separation(&path, out_dir).expect("separation failed");
    println!("separation done in {:.1}s", t0.elapsed().as_secs_f64());

    let n = x_l.len();
    let mut sum_l = vec![0.0f32; n];
    for stem in &stems {
        let d = decode_audio_file(&stem.file_path).expect("stem decode failed");
        let (sl, _sr) = d.to_stereo_planar();
        let sl44 = resample_hq_stereo(&sl, &vec![0.0f32; 0], d.sample_rate, 44_100).0;
        for i in 0..n.min(sl44.len()) {
            sum_l[i] += sl44[i];
        }
    }

    let mut residual = vec![0.0f32; n];
    for i in 0..n {
        residual[i] = x_l[i] - sum_l[i];
    }
    let ratio = rms(&residual) / rms(&x_l);
    let (lag, peak, lag0) = xcorr_peak_lag(&x_l, &sum_l);
    println!("rms(residual)/rms(x44) = {ratio:.4}  (threshold 0.08)");
    println!("xcorr peak lag = {lag} samples, normalized corr peak = {peak:.4}, corr@0 = {lag0:.4}");
}
