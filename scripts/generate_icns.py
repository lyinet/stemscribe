#!/usr/bin/env python3
"""Generate a spec-compliant macOS Retina .icns bundle from existing PNG icons."""
import pathlib
import struct

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"

CHUNKS = [
    (b"ic07", ICONS / "128x128.png"),     # 128x128 PNG
    (b"ic08", ICONS / "128x128@2x.png"),  # 256x256 PNG
    (b"ic10", ICONS / "icon.png"),        # 1024x1024 (512x512@2x Retina) PNG
]


def build_icns() -> pathlib.Path:
    body = bytearray()
    for ostype, png_path in CHUNKS:
        raw = png_path.read_bytes()
        assert raw[:8] == b"\x89PNG\r\n\x1a\n", f"Not a valid PNG: {png_path}"
        body += ostype + struct.pack(">I", len(raw) + 8) + raw

    out = ICONS / "icon.icns"
    out.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + bytes(body))
    return out


if __name__ == "__main__":
    icns = build_icns()
    print(f"[OK] Generated {icns} ({icns.stat().st_size:,} bytes)")
