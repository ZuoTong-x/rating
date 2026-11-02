#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import zipfile
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mapping", type=Path, required=True)
    parser.add_argument("--uploads", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    payload = json.loads(args.mapping.read_text(encoding="utf-8"))
    failures = payload.get("failures") or []
    if failures:
        raise RuntimeError(f"Refusing to build with {len(failures)} unmapped/invalid tasks")
    if args.output.exists():
        raise RuntimeError(f"Refusing to overwrite {args.output}")

    rows = payload["rows"]
    tasks = payload["tasks"]
    destinations = set()
    partial = args.output.with_suffix(args.output.suffix + ".partial")
    if partial.exists():
        raise RuntimeError(f"Partial output already exists: {partial}")
    args.output.parent.mkdir(parents=True, exist_ok=True)

    try:
        with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as target:
            for index, row in enumerate(rows, start=1):
                destination = row["src_rel_path"]
                source = args.uploads / row["source_storage_path"]
                if destination in destinations:
                    raise RuntimeError(f"Duplicate ZIP destination {destination}")
                if not source.is_file():
                    raise RuntimeError(f"Missing server image {source}")
                destinations.add(destination)
                with source.open("rb") as stream, target.open(destination, "w", force_zip64=True) as sink:
                    shutil.copyfileobj(stream, sink, length=1024 * 1024)
                if index % 500 == 0 or index == len(rows):
                    print(f"images={index}/{len(rows)}", flush=True)
            target.writestr("tasks.json", json.dumps({"version": 1, "tasks": tasks}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            target.writestr("manifest.json", json.dumps({"version": 1, "rows": rows}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

        with zipfile.ZipFile(partial) as check:
            bad = check.testzip()
            if bad:
                raise RuntimeError(f"Corrupt ZIP member: {bad}")
            checked_tasks = json.loads(check.read("tasks.json"))
            checked_manifest = json.loads(check.read("manifest.json"))
            images = {name for name in check.namelist() if Path(name).suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".gif"}}
            refs = {item["src_rel_path"] for task in checked_tasks["tasks"] for item in task["images"]}
            manifest_refs = {row["src_rel_path"] for row in checked_manifest["rows"]}
            if refs - images or manifest_refs != images:
                raise RuntimeError(f"Validation failed: missing_task_images={len(refs-images)} extra_or_missing_manifest_images={len(images ^ manifest_refs)}")
        os.replace(partial, args.output)
    except Exception:
        partial.unlink(missing_ok=True)
        raise

    print(json.dumps({
        "zip": str(args.output),
        "bytes": args.output.stat().st_size,
        "tasks": len(tasks),
        "images": len(rows),
        "manifest_rows": len(rows),
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
