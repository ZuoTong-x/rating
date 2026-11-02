from __future__ import annotations

import argparse
import json
import os
import zipfile
from pathlib import Path


JSON_NAMES = {"tasks.json", "manifest.json"}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def copy_entry(source: zipfile.ZipFile, target: zipfile.ZipFile, info: zipfile.ZipInfo) -> None:
    # Write a complete entry with a known size. This avoids data descriptors
    # and ZIP64 local headers that the v10 unzipper cannot seek through.
    output_info = zipfile.ZipInfo(info.filename, info.date_time)
    output_info.compress_type = zipfile.ZIP_STORED
    output_info.external_attr = info.external_attr
    output_info.create_system = info.create_system
    data = source.read(info)
    target.writestr(output_info, data)


def repair(source_path: Path, output_path: Path) -> dict:
    temporary = output_path.with_suffix(output_path.suffix + ".repair.partial")
    if temporary.exists():
        temporary.unlink()
    with zipfile.ZipFile(source_path, "r") as source:
        tasks = json.loads(source.read("tasks.json").decode("utf-8"))
        manifest = json.loads(source.read("manifest.json").decode("utf-8"))
        if not isinstance(tasks.get("tasks"), list):
            raise ValueError("tasks.json.tasks must be an array")
        if not isinstance(manifest.get("rows"), list):
            raise ValueError("manifest.json.rows must be an array")
        infos = [
            info
            for info in source.infolist()
            if not info.is_dir() and info.filename not in JSON_NAMES
        ]
        images = {
            info.filename
            for info in infos
            if Path(info.filename).suffix.lower() in IMAGE_SUFFIXES
        }
        manifest_names = {row.get("src_rel_path") for row in manifest["rows"]}
        task_names = {
            image.get("src_rel_path")
            for task in tasks["tasks"]
            for image in task.get("images", [])
        }
        if manifest_names != images:
            raise ValueError(f"manifest/image mismatch: {len(manifest_names)} != {len(images)}")
        if not task_names <= images:
            raise ValueError("tasks.json references an image outside the package")

        with zipfile.ZipFile(
            temporary, "w", compression=zipfile.ZIP_STORED, allowZip64=True
        ) as target:
            # Keep JSON offsets small and use ordinary ZIP headers. This also
            # avoids a known unzipper failure on late ZIP64 entries.
            target.writestr("tasks.json", json.dumps(tasks, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            target.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            for info in infos:
                if info.filename in images:
                    copy_entry(source, target, info)
    os.replace(temporary, output_path)
    with zipfile.ZipFile(output_path) as check:
        bad = check.testzip()
        if bad:
            raise ValueError(f"CRC failure: {bad}")
    return {
        "path": str(output_path),
        "bytes": output_path.stat().st_size,
        "tasks": len(tasks["tasks"]),
        "manifest_rows": len(manifest["rows"]),
        "images": len(images),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps(repair(args.source, args.output), ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
