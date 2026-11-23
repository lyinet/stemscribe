#!/usr/bin/env python3
"""
StemScribe cross-layer verification & contract test suite.
"""

import json
import py_compile
import re
import struct
import subprocess
import sys
import tomllib
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def check_configs() -> str:
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    tauri_cfg = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    cargo = tomllib.loads((ROOT / "src-tauri/Cargo.toml").read_text(encoding="utf-8"))

    v_pkg = pkg["version"]
    v_tauri = tauri_cfg["version"]
    v_cargo = cargo["package"]["version"]
    assert v_pkg == v_tauri == v_cargo, f"Version mismatch: {v_pkg} vs {v_tauri} vs {v_cargo}"
    display = pkg.get("displayVersion")
    if display is not None:
        parts = display.split(".")
        assert len(parts) == 4 and all(p.isdigit() for p in parts), \
            f"displayVersion must be 4-part numeric (0.<milestone>.<feature>.<fix>), got {display}"
        assert ".".join(parts[:3]) == v_pkg, \
            f"displayVersion {display} must start with semver {v_pkg}"

    for rel in ["tsconfig.json", "src-tauri/capabilities/default.json"]:
        json.loads((ROOT / rel).read_text(encoding="utf-8"))

    # Verify macOS Info.plist exists and declares microphone usage description
    plist_path = ROOT / "src-tauri/Info.plist"
    assert plist_path.exists(), "Missing src-tauri/Info.plist"
    plist_txt = plist_path.read_text(encoding="utf-8")
    ET.fromstring(plist_txt)
    assert "NSMicrophoneUsageDescription" in plist_txt, "Info.plist missing NSMicrophoneUsageDescription"

    print(f"[PASS] Configs, Info.plist & unified version: v{pkg.get("displayVersion", v_pkg)}")
    return v_pkg


def check_tauri_command_contract() -> None:
    lib_rs = (ROOT / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
    handler_match = re.search(r"tauri::generate_handler!\[(.*?)\]", lib_rs, re.S)
    assert handler_match, "Could not find tauri::generate_handler![] in lib.rs"
    registered_list = [tok.strip() for tok in handler_match.group(1).split(",") if tok.strip()]
    assert len(registered_list) == len(set(registered_list)), "Duplicate Rust handlers detected!"
    registered = set(registered_list)

    tauri_api = (ROOT / "src/lib/tauriApi.ts").read_text(encoding="utf-8")
    invoked = set(re.findall(r'invoke(?:<[^>]+>)?\(\s*"([a-z0-9_]+)"', tauri_api))

    missing_in_rust = invoked - registered
    assert not missing_in_rust, f"Frontend invokes unregistered Rust commands: {missing_in_rust}"
    print(f"[PASS] Tauri IPC contract: {len(invoked)} frontend commands == {len(registered)} Rust handlers")


def check_menu_event_contract() -> None:
    menu_rs = (ROOT / "src-tauri/src/menu.rs").read_text(encoding="utf-8")
    emitted_ids = set(re.findall(r'MenuItemBuilder::with_id\(\s*"([a-z0-9_]+)"', menu_rs))
    app_tsx = (ROOT / "src/App.tsx").read_text(encoding="utf-8")
    handled_ids = set(re.findall(r'case\s+"([a-z0-9_]+)":', app_tsx))
    missing = emitted_ids - handled_ids
    assert not missing, f"Unhandled macOS menu actions in App.tsx: {missing}"
    print(f"[PASS] macOS Menu contract: {len(emitted_ids)} native menu items handled in React")


def check_ts_imports() -> None:
    src_dir = ROOT / "src"
    checked = 0
    for ts_file in src_dir.rglob("*.ts*"):
        text = ts_file.read_text(encoding="utf-8")
        for imp in re.findall(r'from\s+"(\.[^"]+)"', text):
            base = (ts_file.parent / imp).resolve()
            candidates = [base, base.with_suffix(".ts"), base.with_suffix(".tsx"), base / "index.ts"]
            assert any(c.exists() for c in candidates), f"Broken import '{imp}' in {ts_file}"
            checked += 1
    print(f"[PASS] TypeScript relative imports: {checked} imports resolved cleanly")


def check_rust_modules() -> None:
    rust_src = ROOT / "src-tauri/src"
    checked = 0
    for rs_file in rust_src.rglob("*.rs"):
        text = rs_file.read_text(encoding="utf-8")
        for mod_name in re.findall(r"(?:pub\s+)?mod\s+([a-z0-9_]+)\s*;", text):
            parent = rs_file.parent
            candidates = [parent / f"{mod_name}.rs", parent / mod_name / "mod.rs"]
            assert any(c.exists() for c in candidates), f"Missing Rust module '{mod_name}' in {rs_file}"
            checked += 1
    print(f"[PASS] Rust module tree: {checked} module declarations resolved")


def check_icons() -> None:
    expected = {
        "src-tauri/icons/32x32.png": (32, 32),
        "src-tauri/icons/128x128.png": (128, 128),
        "src-tauri/icons/128x128@2x.png": (256, 256),
        "src-tauri/icons/icon.png": (1024, 1024),
    }
    for rel, dims in expected.items():
        p = ROOT / rel
        assert p.exists(), f"Missing icon: {rel}"
        head = p.read_bytes()[:24]
        assert head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR", f"Invalid PNG: {rel}"
        size = struct.unpack(">II", head[16:24])
        assert size == dims, f"Icon {rel} size {size} != {dims}"
    icns_path = ROOT / "src-tauri/icons/icon.icns"
    assert icns_path.exists() and icns_path.read_bytes()[:4] == b"icns", "Invalid or missing icon.icns"
    print(f"[PASS] macOS Bundle Icons: 4 PNG assets + Retina icon.icns verified")


def check_scripts() -> None:
    for py in ["scripts/export_models_onnx.py", "scripts/generate_mac_icon.py", "scripts/verify_project.py"]:
        py_compile.compile(str(ROOT / py), doraise=True)
    for sh in ["scripts/setup_mac.sh", "scripts/build_macos_dmg.sh"]:
        subprocess.run(["bash", "-n", str(ROOT / sh)], check=True)
    assert (ROOT / ".github/workflows/macos-build.yml").exists(), "Missing GitHub Actions workflow"
    assert (ROOT / ".gitignore").exists(), "Missing .gitignore"
    print("[PASS] Helper scripts, .gitignore & GitHub Actions macOS workflow valid")


def main() -> int:
    ver = check_configs()
    check_tauri_command_contract()
    check_menu_event_contract()
    check_ts_imports()
    check_rust_modules()
    check_icons()
    check_scripts()
    print(f"\nALL v{ver} RELEASE CHECKS PASSED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
