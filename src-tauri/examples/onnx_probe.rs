//! Probe an ONNX model's declared I/O and run one CPU inference on a
//! sine test signal, reporting output shape and any non-finite values.
//! Usage: cargo run --release --example onnx_probe -- <model.onnx>

use ndarray::Array3;
use ort::value::Tensor;
use stemscribe_lib::ml::build_cpu_session;
use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    let path = PathBuf::from(
        std::env::args()
            .nth(1)
            .expect("usage: onnx_probe <model.onnx>"),
    );
    let mut session = build_cpu_session(&path)?;
    for (i, inp) in session.inputs.iter().enumerate() {
        println!("input[{i}]: {} {:?}", inp.name, inp.input_type);
    }
    for (i, out) in session.outputs.iter().enumerate() {
        println!("output[{i}]: {} {:?}", out.name, out.output_type);
    }
    // Test input: stereo [1,2,343980] by default; pass "mono" for [1,1,160000].
    let mono = std::env::args().nth(2).as_deref() == Some("mono");
    let (ch, n) = if mono { (1usize, 160_000usize) } else { (2, 343_980) };
    let mut input = Array3::<f32>::zeros((1, ch, n));
    let mut seed = 0x9E3779B9u64;
    for i in 0..n {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let noise = (seed >> 33) as f32 / u32::MAX as f32 - 0.5;
        let s = 0.2 * (i as f32 * 0.05).sin() + 0.05 * noise;
        input[[0, 0, i]] = s;
        if ch > 1 {
            input[[0, 1, i]] = 0.8 * s;
        }
    }
    let outs = session.run(ort::inputs![Tensor::from_array(input)?])?;
    for (i, o) in outs.iter().enumerate() {
        let (shape, data) = o.1.try_extract_tensor::<f32>()?;
        let bad = data.iter().filter(|v| !v.is_finite()).count();
        let rms = (data.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>()
            / data.len().max(1) as f64)
            .sqrt();
        println!("out[{i}] shape={shape:?} len={} nonfinite={bad} rms={rms:.5}", data.len());
    }
    Ok(())
}
