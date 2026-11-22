#!/usr/bin/env python3
"""
Export HTDemucs (4-stem separation) and Spotify Basic Pitch (audio-to-MIDI)
to ONNX models compatible with StemScribe's Rust `ort` + Apple Silicon CoreML backend.

Usage on macOS:
    python3 -m venv .venv && source .venv/bin/activate
    pip install torch torchaudio demucs basic-pitch onnx onnxruntime
    python3 scripts/export_models_onnx.py
"""

from pathlib import Path
import shutil
import sys

MODELS_DIR = Path.home() / "Library" / "Application Support" / "StemScribe" / "models"


def export_basic_pitch(output_path: Path) -> None:
    """Copy or export Basic Pitch's official pre-built ONNX model."""
    try:
        from basic_pitch import ICASSP_2022_MODEL_PATH
    except ImportError:
        print("[Skip] basic-pitch not installed. Run: pip install basic-pitch")
        return

    src_onnx = Path(str(ICASSP_2022_MODEL_PATH)).with_suffix(".onnx")
    if not src_onnx.exists():
        # Some basic-pitch distributions store the file as nmp.onnx inside saved_models
        candidates = list(Path(str(ICASSP_2022_MODEL_PATH)).parent.glob("*.onnx"))
        if candidates:
            src_onnx = candidates[0]

    if src_onnx.exists():
        shutil.copy2(src_onnx, output_path)
        print(f"[OK] Basic Pitch ONNX copied to: {output_path}")
    else:
        print(
            "[Info] Could not find bundled .onnx in basic-pitch package. "
            "You can convert the SavedModel with: python -m tf2onnx.convert"
        )


def export_htdemucs(output_path: Path) -> None:
    """Export Demucs HTDemucs 4-stem model to fixed-chunk ONNX for CoreML."""
    try:
        import torch
        from demucs.pretrained import get_model
    except ImportError:
        print("[Skip] torch/demucs not installed. Run: pip install torch demucs")
        return

    print("[Export] Loading htdemucs pretrained weights...")
    bag = get_model("htdemucs")
    model = bag.models[0].eval().cpu()

    # Fixed 7.8s stereo chunk (343,980 samples @ 44.1kHz) matches Rust separator.rs
    dummy_input = torch.randn(1, 2, 343_980, dtype=torch.float32)

    print(f"[Export] Exporting ONNX to {output_path} ...")
    torch.onnx.export(
        model,
        dummy_input,
        str(output_path),
        opset_version=17,
        input_names=["audio"],
        output_names=["stems"],
        do_constant_folding=True,
    )
    print(f"[OK] HTDemucs ONNX exported to: {output_path}")


def main() -> int:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Target macOS models directory: {MODELS_DIR}\n")

    export_basic_pitch(MODELS_DIR / "basic_pitch.onnx")
    export_htdemucs(MODELS_DIR / "htdemucs.onnx")

    print("\nDone. Restart StemScribe to verify model detection.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
