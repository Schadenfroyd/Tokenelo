"""Hidden, bounded supervisor for the task-local Electron SVG icon render."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import struct
import subprocess
import sys
import time


EXPECTED_ELECTRON_VERSION = "44.6.0"
EXPECTED_ELECTRON_SHA256 = "c61802364a1e34a5c39335a97c5cf2a8ab2ea04937e4d83378a65508a34cb826"
EXPECTED_SOURCE_BANNER_SHA256 = "61a248aeeea598434384a824767c19db9f8874b2af36bf98a11e5a5949740619"
EXPECTED_MARK_SVG_SHA256 = "66b0857f938dc83a4af3e14538e672524e695983fad4644802493d9941aa32a2"
OUTER_RENDER_CAP_SECONDS = 45
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
MACOS_ICONSET_FRAMES = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]
EXPECTED_NATIVE_ICNS_SHA256 = "3a63e6d4676d395c0ea52eef888f7f39a1961954b9392a698bf9138329a9534c"
EXPECTED_NATIVE_BINDING_SHA256 = "5afb854c92413f78087f910c42dbf50a3495430bae218490e376d267776c8e03"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json_exclusive(path: pathlib.Path, value: object) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def png_info(data: bytes, label: str) -> dict[str, int]:
    if len(data) < 33 or data[:8] != PNG_SIGNATURE or data[12:16] != b"IHDR":
        raise ValueError(f"{label} is not a PNG with an IHDR")
    if struct.unpack(">I", data[8:12])[0] != 13:
        raise ValueError(f"{label} has a noncanonical IHDR length")
    width, height = struct.unpack(">II", data[16:24])
    bit_depth, color_type = data[24], data[25]
    if bit_depth != 8 or color_type != 6:
        raise ValueError(f"{label} must be 8-bit RGBA PNG")
    return {"width": width, "height": height, "bitDepth": bit_depth, "colorType": color_type}


def validate_ico(data: bytes) -> list[dict[str, int]]:
    if len(data) < 6:
        raise ValueError("ICO header is truncated")
    reserved, kind, count = struct.unpack("<HHH", data[:6])
    if reserved != 0 or kind != 1 or count != len(ICO_SIZES):
        raise ValueError("ICO directory header/count differs from the pinned multi-size set")
    if len(data) < 6 + count * 16:
        raise ValueError("ICO directory entries are truncated")
    frames = []
    previous_end = 6 + count * 16
    for index in range(count):
        offset = 6 + index * 16
        width_byte, height_byte = data[offset], data[offset + 1]
        width = 256 if width_byte == 0 else width_byte
        height = 256 if height_byte == 0 else height_byte
        planes, bit_count = struct.unpack("<HH", data[offset + 4 : offset + 8])
        length, image_offset = struct.unpack("<II", data[offset + 8 : offset + 16])
        if width != ICO_SIZES[index] or height != width or planes != 1 or bit_count != 32:
            raise ValueError(f"ICO entry {index} has unexpected dimensions or pixel metadata")
        if image_offset != previous_end or length < 33 or image_offset + length > len(data):
            raise ValueError(f"ICO entry {index} has an invalid or noncontiguous PNG range")
        info = png_info(data[image_offset : image_offset + length], f"ICO frame {width}")
        if info["width"] != width or info["height"] != height:
            raise ValueError(f"ICO frame {width} embeds mismatched PNG dimensions")
        frames.append({"width": width, "height": height, "pngBytes": length})
        previous_end = image_offset + length
    if previous_end != len(data):
        raise ValueError("ICO contains unreferenced trailing bytes")
    return frames


def validate_macos_iconset(iconset_dir: pathlib.Path, binding: dict) -> list[dict[str, int | str]]:
    if iconset_dir.is_symlink() or not iconset_dir.is_dir():
        raise ValueError("standard macOS iconset directory is missing or unsafe")
    records = binding.get("inputIconset", {}).get("files")
    if not isinstance(records, list):
        raise ValueError("native ICNS binding has no input iconset file list")
    expected = {record.get("name"): record for record in records if isinstance(record, dict)}
    expected_names = {name for name, _ in MACOS_ICONSET_FRAMES}
    if len(expected) != len(records) or set(expected) != expected_names:
        raise ValueError("native ICNS binding filename set differs from the pinned standard iconset")
    entries = list(iconset_dir.iterdir())
    if any(entry.is_symlink() or not entry.is_file() for entry in entries):
        raise ValueError("standard iconset contains a non-file or reparse entry")
    if {entry.name for entry in entries} != expected_names:
        raise ValueError("standard macOS iconset filenames differ from the pinned 10-file set")
    frames = []
    for name, size in MACOS_ICONSET_FRAMES:
        record = expected[name]
        if record.get("width") != size or record.get("height") != size:
            raise ValueError(f"native ICNS binding dimensions differ for {name}")
        data = (iconset_dir / name).read_bytes()
        info = png_info(data, f"macOS iconset {name}")
        if info["width"] != size or info["height"] != size:
            raise ValueError(f"macOS iconset frame {name} has unexpected dimensions")
        digest = sha256(data)
        if digest != record.get("sha256") or len(data) != record.get("bytes"):
            raise ValueError(f"macOS iconset frame {name} differs from the native ICNS input binding")
        frames.append({"name": name, "width": size, "height": size, "bytes": len(data), "sha256": digest})
    return frames


def validate_native_icns(data: bytes, binding: dict) -> dict[str, int | str]:
    output = binding.get("output", {})
    if len(data) < 8 or data[:4] != b"icns" or struct.unpack(">I", data[4:8])[0] != len(data):
        raise ValueError("native iconutil ICNS header or declared length is invalid")
    digest = sha256(data)
    if digest != EXPECTED_NATIVE_ICNS_SHA256 or digest != output.get("sha256"):
        raise ValueError("native ICNS artifact differs from the exact reviewed iconutil output pin")
    if len(data) != output.get("bytes"):
        raise ValueError("native ICNS artifact size differs from its binding")
    return {"bytes": len(data), "sha256": digest, "magic": "icns", "declaredLength": len(data)}


def write_binary_exclusive(path: pathlib.Path, data: bytes) -> None:
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--electron-exe", required=True)
    parser.add_argument("--expected-electron-sha256", required=True)
    parser.add_argument("--evidence-dir", required=True)
    args = parser.parse_args()

    icons_dir = pathlib.Path(__file__).resolve().parent
    source_svg = icons_dir / "tokenelo-mark.svg"
    output_dir = icons_dir / "generated"
    evidence_dir = pathlib.Path(args.evidence_dir).resolve()
    electron_exe = pathlib.Path(args.electron_exe).resolve()
    if not source_svg.is_file() or not electron_exe.is_file():
        raise FileNotFoundError("pinned SVG or Electron executable is missing")
    if output_dir.exists():
        raise FileExistsError(f"refusing to overwrite existing icon output directory: {output_dir}")
    if args.expected_electron_sha256.lower() != EXPECTED_ELECTRON_SHA256:
        raise ValueError("caller Electron SHA pin differs from the reviewed 44.6.0 executable")

    source_bytes = source_svg.read_bytes()
    source_hash = sha256(source_bytes)
    if source_hash != EXPECTED_MARK_SVG_SHA256:
        raise ValueError("extracted SVG bytes differ from the frozen icon source pin")
    source_binding = json.loads((icons_dir / "source-binding.json").read_text(encoding="utf-8"))
    if source_binding.get("sourceSha256") != EXPECTED_SOURCE_BANNER_SHA256:
        raise ValueError("public banner provenance pin changed")
    executable_hash = sha256(electron_exe.read_bytes())
    if executable_hash != EXPECTED_ELECTRON_SHA256:
        raise ValueError("Electron executable SHA does not match locked 44.6.0")
    if evidence_dir.exists():
        raise FileExistsError(f"refusing to overwrite evidence directory: {evidence_dir}")
    evidence_dir.mkdir(parents=True, exist_ok=False)
    output_dir.mkdir(parents=True, exist_ok=False)
    profile_root = evidence_dir / "electron-profile"
    scratch = evidence_dir / "scratch"
    for directory in (profile_root, scratch, profile_root / "user-data", profile_root / "session",
                      profile_root / "cache", profile_root / "temp"):
        directory.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env.update({
        "TOKENELO_ICON_SOURCE": str(source_svg),
        "TOKENELO_ICON_SOURCE_SHA256": source_hash,
        "TOKENELO_ICON_SOURCE_BANNER_SHA256": EXPECTED_SOURCE_BANNER_SHA256,
        "TOKENELO_ICON_OUTPUT_DIR": str(output_dir),
        "TOKENELO_ICON_USER_DATA_DIR": str(profile_root),
        "APPDATA": str(profile_root / "appdata"),
        "LOCALAPPDATA": str(profile_root / "localappdata"),
        "TEMP": str(scratch),
        "TMP": str(scratch),
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    for directory in (profile_root / "appdata", profile_root / "localappdata"):
        directory.mkdir(parents=True, exist_ok=True)

    command = [str(electron_exe), "--disable-gpu", "--disable-background-networking", str(icons_dir)]
    launch_record = {
        "command": command,
        "cwd": str(icons_dir),
        "createNoWindow": True,
        "redirected": ["stdin=DEVNULL", "stdout=PIPE", "stderr=PIPE"],
        "electronSha256": executable_hash,
        "sourceSvgSha256": source_hash,
        "sourceBannerSha256": EXPECTED_SOURCE_BANNER_SHA256,
        "renderCapSeconds": OUTER_RENDER_CAP_SECONDS,
    }
    write_json_exclusive(evidence_dir / "launch.json", launch_record)
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = 0
    started = time.monotonic()
    child = subprocess.Popen(
        command,
        cwd=str(icons_dir),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW,
        startupinfo=startup,
    )
    write_json_exclusive(evidence_dir / "spawned-child.json", {
        "pid": child.pid,
        "startedMonotonic": started,
        "electronSha256": executable_hash,
        "unresolved": False,
    })
    try:
        stdout, stderr = child.communicate(timeout=OUTER_RENDER_CAP_SECONDS)
    except subprocess.TimeoutExpired:
        child.terminate()
        try:
            stdout, stderr = child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            try:
                stdout, stderr = child.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                stdout, stderr = b"", b""
        unresolved = True
        (evidence_dir / "renderer.stdout.bin").write_bytes(stdout)
        (evidence_dir / "renderer.stderr.bin").write_bytes(stderr)
        write_json_exclusive(evidence_dir / "failure.json", {
            "status": "FAIL_TIMEOUT",
            "exitCode": child.poll(),
            "elapsedSeconds": round(time.monotonic() - started, 3),
            "renderCapSeconds": OUTER_RENDER_CAP_SECONDS,
            "unresolvedProcess": unresolved,
            "retainedOutputDirectory": str(output_dir),
            "cleanupSkippedReason": "render timeout; output/profile retained for owner review",
        })
        return 124
    elapsed = round(time.monotonic() - started, 3)
    (evidence_dir / "renderer.stdout.bin").write_bytes(stdout)
    (evidence_dir / "renderer.stderr.bin").write_bytes(stderr)
    if child.returncode != 0:
        write_json_exclusive(evidence_dir / "failure.json", {
            "status": "FAIL_RENDERER",
            "exitCode": child.returncode,
            "elapsedSeconds": elapsed,
            "renderCapSeconds": OUTER_RENDER_CAP_SECONDS,
            "retainedOutputDirectory": str(output_dir),
            "stderrSha256": sha256(stderr),
            "cleanupSkippedReason": "renderer failed; all task-owned outputs and profile retained",
        })
        return child.returncode or 1

    renderer_manifest_path = output_dir / "renderer-manifest.json"
    renderer_manifest_data = renderer_manifest_path.read_bytes()
    renderer = json.loads(renderer_manifest_data.decode("utf-8"))
    if renderer.get("status") != "PASS_RENDERER" or renderer.get("electronVersion") != EXPECTED_ELECTRON_VERSION:
        raise ValueError("renderer manifest does not report the exact expected Electron result")
    if renderer.get("sourceSha256") != source_hash:
        raise ValueError("renderer manifest source hash changed")

    binding_path = icons_dir / "native" / "native-iconutil-binding.json"
    binding_data = binding_path.read_bytes()
    binding_hash = sha256(binding_data)
    if binding_hash != EXPECTED_NATIVE_BINDING_SHA256:
        raise ValueError("native iconutil binding differs from the reviewed source pin")
    binding = json.loads(binding_data.decode("utf-8"))
    if binding.get("schema") != "tokenelo.native-iconutil-binding.v1" or binding.get("status") != "PASS_FORMAT_ONLY":
        raise ValueError("native iconutil binding schema/status is invalid")
    if binding.get("source", {}).get("derivedMarkSvgSha256") != source_hash:
        raise ValueError("native iconutil binding belongs to another source SVG")

    iconset_dir = output_dir / "tokenelo-macos.iconset"
    macos_iconset_frames = validate_macos_iconset(iconset_dir, binding)
    renderer_frames = renderer.get("macosIconsetFrames")
    expected_renderer_frames = [
        {"name": row["name"], "size": row["width"], "pngBytes": row["bytes"], "sha256": row["sha256"]}
        for row in macos_iconset_frames
    ]
    if renderer_frames != expected_renderer_frames:
        raise ValueError("renderer manifest macOS iconset hashes/dimensions differ from the native binding")

    native_icns_path = icons_dir / "native" / "tokenelo-macos.icns"
    native_icns_data = native_icns_path.read_bytes()
    native_icns = validate_native_icns(native_icns_data, binding)
    output_icns_path = output_dir / "tokenelo-macos.icns"
    if output_icns_path.exists():
        raise FileExistsError("renderer must not emit or overwrite the native macOS ICNS artifact")
    write_binary_exclusive(output_icns_path, native_icns_data)

    output_records = {}
    for name in ("tokenelo-1024.png", "tokenelo-linux-512.png", "tokenelo-windows.ico", "tokenelo-macos.icns"):
        data = (output_dir / name).read_bytes()
        output_records[name] = {"bytes": len(data), "sha256": sha256(data)}
    png_master = png_info((output_dir / "tokenelo-1024.png").read_bytes(), "master PNG")
    png_linux = png_info((output_dir / "tokenelo-linux-512.png").read_bytes(), "Linux PNG")
    if png_master["width"] != 1024 or png_master["height"] != 1024:
        raise ValueError("native 1024px PNG dimensions are incorrect")
    if png_linux["width"] != 512 or png_linux["height"] != 512:
        raise ValueError("Linux 512px PNG dimensions are incorrect")
    ico_frames = validate_ico((output_dir / "tokenelo-windows.ico").read_bytes())
    native_converter = binding["converter"]
    asset_manifest = {
        "schema": "tokenelo.native-icon-assets.v1",
        "status": "PASS_ASSET_CONSTRUCTION",
        "scope": "FILED-EXAMPLE branded asset construction only; no app build/config/installer/native OS acceptance",
        "electronVersion": EXPECTED_ELECTRON_VERSION,
        "electronExeSha256": executable_hash,
        "sourceSvgSha256": source_hash,
        "sourceBannerSha256": EXPECTED_SOURCE_BANNER_SHA256,
        "rendererManifestSha256": sha256(renderer_manifest_data),
        "nativeIconutilBindingSha256": binding_hash,
        "macosIconsetFrames": macos_iconset_frames,
        "nativeMacosIcns": {
            **native_icns,
            "tool": native_converter["path"],
            "toolSha256": native_converter["sha256"],
            "macOSProductVersion": native_converter["macOSProductVersion"],
            "artifactOrigin": "Previously generated by native macOS iconutil and pinned to this exact standard iconset; this Windows renderer run does not invoke iconutil.",
            "roundtrip": binding["roundtrip"],
        },
        "outputs": output_records,
    }
    asset_manifest_path = output_dir / "asset-manifest.json"
    write_json_exclusive(asset_manifest_path, asset_manifest)
    receipt = {
        "status": "PASS",
        "scope": "FILED-EXAMPLE branded asset construction only; no app build/config/installer/native OS action",
        "elapsedSeconds": elapsed,
        "renderCapSeconds": OUTER_RENDER_CAP_SECONDS,
        "electronVersion": EXPECTED_ELECTRON_VERSION,
        "electronExeSha256": executable_hash,
        "sourceSvgSha256": source_hash,
        "sourceBannerSha256": EXPECTED_SOURCE_BANNER_SHA256,
        "renderer": renderer,
        "rendererManifestSha256": sha256(renderer_manifest_data),
        "masterPng": png_master,
        "linuxPng": png_linux,
        "icoFrames": ico_frames,
        "macosIconsetFrames": macos_iconset_frames,
        "nativeMacosIcns": {
            **native_icns,
            "bindingPath": str(binding_path),
            "bindingSha256": binding_hash,
            "tool": native_converter["path"],
            "toolSha256": native_converter["sha256"],
            "macOSProductVersion": native_converter["macOSProductVersion"],
            "roundtrip": binding["roundtrip"],
            "conversionExecutedByThisWindowsSupervisor": False,
        },
        "outputs": output_records,
        "assetManifest": str(asset_manifest_path),
        "rawLogs": {
            "stdout": str(evidence_dir / "renderer.stdout.bin"),
            "stderr": str(evidence_dir / "renderer.stderr.bin"),
        },
        "cleanup": "task-owned evidence/profile retained; no borrowed or system files touched",
    }
    write_json_exclusive(evidence_dir / "receipt.json", receipt)
    print(json.dumps({"status": "PASS", "receipt": str(evidence_dir / "receipt.json"), "outputs": output_records}))
    return 0


if __name__ == "__main__":
    if os.name != "nt":
        raise SystemExit("This task-local supervisor is Windows-only.")
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"icon supervisor failure: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
