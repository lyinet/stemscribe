#!/usr/bin/env python3
"""Generate clean macOS app icons for Tauri v2 bundle (32, 128, 256, 1024px)."""

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS_DIR = ROOT / "src-tauri" / "icons"


def render_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded macOS squircle-like dark slate tile
    pad = int(size * 0.06)
    radius = int(size * 0.22)
    draw.rounded_rectangle(
        [pad, pad, size - pad, size - pad],
        radius=radius,
        fill=(18, 24, 38, 255),
        outline=(59, 130, 246, 255),
        width=max(2, size // 64),
    )

    # 4-stem waveform bars in semantic stem colors
    colors = [
        (244, 63, 94, 255),   # vocals
        (245, 158, 11, 255),  # drums
        (168, 85, 247, 255),  # bass
        (59, 130, 246, 255),  # other
    ]
    heights = [0.46, 0.68, 0.56, 0.38]
    bar_w = int(size * 0.11)
    gap = int(size * 0.065)
    total_w = 4 * bar_w + 3 * gap
    start_x = (size - total_w) // 2
    cy = size // 2

    for i, (col, h_ratio) in enumerate(zip(colors, heights)):
        bh = int(size * h_ratio)
        x0 = start_x + i * (bar_w + gap)
        y0 = cy - bh // 2
        draw.rounded_rectangle(
            [x0, y0, x0 + bar_w, y0 + bh],
            radius=max(2, bar_w // 2),
            fill=col,
        )

    return img


def main() -> None:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    targets = {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 1024,
    }
    for name, sz in targets.items():
        render_icon(sz).save(ICONS_DIR / name, format="PNG")
        print(f"[ICON OK] {name} ({sz}x{sz})")


if __name__ == "__main__":
    main()
