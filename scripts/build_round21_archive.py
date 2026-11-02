from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
import time
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def task_ref(value):
    if isinstance(value, str):
        return value.replace("\\", "/")
    return str(
        value.get("src_rel_path")
        or value.get("originalPath")
        or value.get("filename")
        or ""
    ).replace("\\", "/")


def archive_name(reference):
    return reference.lstrip("/")


def load_db_mapping(compose_dir: Path, roots: list[str]):
    roots_sql = ",".join("'" + root.replace("'", "''") + "'" for root in roots)
    query = f"""
COPY (
  SELECT s.storageroot, s.originalfilename, i.storagepath, i.originalpath
  FROM images i
  JOIN subjects s ON s.id = i.subjectid
  WHERE s.storageroot IN ({roots_sql})
) TO STDOUT WITH CSV
"""
    result = subprocess.run(
        [
            "docker", "compose", "exec", "-T", "postgres", "psql",
            "-U", "image_rating", "-d", "image_rating", "-c", query,
        ],
        cwd=compose_dir,
        check=True,
        capture_output=True,
        text=True,
    )
    mapping = {}
    for row in csv.reader(result.stdout.splitlines()):
        if len(row) != 4:
            continue
        root, source_zip, storage_path, original_path = row
        key = "/files/" + storage_path.lstrip("/")
        mapping[key] = {
            "root": root,
            "source_zip": source_zip,
            "storage_path": storage_path,
            "original_path": original_path,
        }
    return mapping


def manifest_index(source: zipfile.ZipFile):
    document = json.loads(source.read("manifest.json"))
    index = {}
    for row in document.get("rows", []):
        keys = [
            row.get("src_rel_path"), row.get("dest_rel_path"),
            row.get("image_filename"), row.get("image_path"),
        ]
        for key in keys:
            if key:
                index.setdefault(str(key).replace("\\", "/"), row)
    return index


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--processed", type=Path, required=True)
    parser.add_argument("--compose-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()

    tasks_document = json.loads(args.tasks.read_text(encoding="utf-8"))
    tasks = tasks_document.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise ValueError("tasks.json must contain a non-empty tasks array")
    references = {task_ref(item) for task in tasks for item in task.get("images", [])}
    if "" in references:
        raise ValueError("tasks.json contains an empty image reference")
    roots = sorted({ref.split("/", 3)[2] for ref in references if ref.startswith("/files/")})
    if len(roots) != 6:
        raise ValueError(f"expected 6 storage roots, found {roots}")

    mapping = load_db_mapping(args.compose_dir, roots)
    missing_db = references - mapping.keys()
    if missing_db:
        raise ValueError(f"database mapping missing {len(missing_db)} references; first={next(iter(missing_db))}")

    by_zip = {}
    for reference in references:
        by_zip.setdefault(mapping[reference]["source_zip"], []).append(reference)
    source_names = {
        "V030_images_20G_1.zip",
        "V030_images_remaining_20G_001.zip",
        "V030_images_remaining_20G_002.zip",
        "V030_images_remaining_20G_003_1.zip",
        "V030_images_remaining_20G_003_2.zip",
        "V030_images_remaining_20G_004.zip",
    }
    if set(by_zip) != source_names:
        raise ValueError(f"unexpected source ZIP set: {sorted(by_zip)}")

    tasks_bytes = json.dumps(
        {"version": 1, "tasks": tasks}, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    rows_out = []
    work = []
    estimated_image_bytes = 0
    for source_name in sorted(by_zip):
        source_path = args.processed / source_name
        with zipfile.ZipFile(source_path) as source:
            infos = {item.filename.replace("\\", "/"): item for item in source.infolist()}
            rows = manifest_index(source)
            for reference in sorted(by_zip[source_name]):
                record = mapping[reference]
                original = record["original_path"].replace("\\", "/")
                info = infos.get(original)
                if info is None:
                    raise ValueError(f"source image missing: {source_name}:{original}")
                row = rows.get(original) or rows.get(PurePosixPath(original).name)
                if row is None:
                    raise ValueError(f"manifest row missing: {source_name}:{original}")
                target_name = archive_name(reference)
                updated = dict(row)
                updated.update({
                    "src_rel_path": target_name,
                    "dest_rel_path": target_name,
                    "image_filename": target_name,
                    "image_path": target_name,
                })
                rows_out.append(updated)
                work.append((source_name, original, target_name, info.file_size))
                estimated_image_bytes += info.file_size

    manifest_bytes = json.dumps(
        {"version": 1, "rows": rows_out}, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    print(json.dumps({
        "status": "mapped",
        "tasks": len(tasks),
        "images": len(references),
        "tasks_bytes": len(tasks_bytes),
        "manifest_bytes": len(manifest_bytes),
        "estimated_image_bytes": estimated_image_bytes,
        "source_counts": {name: len(items) for name, items in sorted(by_zip.items())},
        "source_bytes": {
            name: sum(size for source_name, _original, _target, size in work if source_name == name)
            for name in sorted(by_zip)
        },
    }, ensure_ascii=False), flush=True)

    if args.plan_only:
        return

    partial = args.output.with_suffix(args.output.suffix + ".partial")
    if partial.exists() or args.output.exists():
        raise ValueError(f"refusing to overwrite existing output: {partial} or {args.output}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    copied = 0
    opened = {}
    try:
        with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as target:
            target.writestr("tasks.json", tasks_bytes)
            target.writestr("manifest.json", manifest_bytes)
            for source_name, original, target_name, _ in work:
                source = opened.get(source_name)
                if source is None:
                    source = zipfile.ZipFile(args.processed / source_name)
                    opened[source_name] = source
                with source.open(original) as inp, target.open(target_name, "w", force_zip64=True) as out:
                    while chunk := inp.read(4 * 1024 * 1024):
                        out.write(chunk)
                copied += 1
                if copied % 500 == 0 or copied == len(work):
                    print(f"COPY {copied}/{len(work)} {copied / len(work) * 100:.2f}%", flush=True)
    finally:
        for source in opened.values():
            source.close()
    os.replace(partial, args.output)

    with zipfile.ZipFile(args.output) as check:
        bad = check.testzip()
        names = set(check.namelist())
        check_tasks = json.loads(check.read("tasks.json"))["tasks"]
        check_rows = json.loads(check.read("manifest.json"))["rows"]
        images = {name for name in names if Path(name).suffix.lower() in IMAGE_SUFFIXES}
        task_refs = {archive_name(task_ref(item)) for task in check_tasks for item in task.get("images", [])}
        row_refs = {str(row.get("image_filename", "")).lstrip("/") for row in check_rows}
        ids = [str(task.get("id", "")) for task in check_tasks]
        result = {
            "zip_test": "PASS" if bad is None else bad,
            "zip_bytes": args.output.stat().st_size,
            "zip_entries": len(names),
            "tasks": len(check_tasks),
            "unique_task_ids": len(set(ids)),
            "images": len(images),
            "manifest_rows": len(check_rows),
            "missing_task_images": len(task_refs - images),
            "task_refs_missing_manifest": len(task_refs - row_refs),
            "images_missing_manifest": len(images - row_refs),
            "duplicate_archive_names": sum(count - 1 for count in Counter(check.namelist()).values()),
            "zip64": any(item.header_offset > 0xFFFFFFFF or item.file_size > 0xFFFFFFFF for item in check.infolist()),
        }
    print(json.dumps(result, ensure_ascii=False), flush=True)
    if result["zip_test"] != "PASS" or any(result[key] for key in (
        "missing_task_images", "task_refs_missing_manifest", "images_missing_manifest", "duplicate_archive_names"
    )) or result["tasks"] != result["unique_task_ids"]:
        raise RuntimeError("archive validation failed")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR {error}", file=sys.stderr, flush=True)
        raise
