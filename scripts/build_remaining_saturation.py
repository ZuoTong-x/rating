from __future__ import annotations

import argparse
import json
import os
import sys
import time
import zipfile
from collections import defaultdict
from pathlib import Path


MAX_ZIP_BYTES = 21_206_401_024
# Keep several MiB below the hard limit for ZIP central-directory overhead.
TARGET_PAYLOAD_BYTES = 21_000_000_000
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def ref(image):
    if isinstance(image, str):
        return image.replace("\\", "/")
    return str(
        image.get("src_rel_path")
        or image.get("originalPath")
        or image.get("filename")
        or ""
    ).replace("\\", "/")


def find(parent, value):
    while parent[value] != value:
        parent[value] = parent[parent[value]]
        value = parent[value]
    return value


def union(parent, rank, left, right):
    left = find(parent, left)
    right = find(parent, right)
    if left == right:
        return
    if rank[left] < rank[right]:
        left, right = right, left
    parent[right] = left
    if rank[left] == rank[right]:
        rank[left] += 1


def task_ids_from_zip(paths: list[Path]) -> set[str]:
    done: set[str] = set()
    for path in paths:
        with zipfile.ZipFile(path) as archive:
            payload = json.loads(archive.read("tasks.json"))
        for task in payload.get("tasks", []):
            done.add(str(task["id"]))
    return done


def task_ids_from_json(paths: list[Path]) -> set[str]:
    done: set[str] = set()
    for path in paths:
        payload = load_json(path)
        done.update(str(task["id"]) for task in payload.get("tasks", []))
    return done


def build_bins(tasks, source_index, done_ids):
    remaining = [task for task in tasks if str(task["id"]) not in done_ids]
    refs_by_task: list[set[str]] = []
    image_tasks: dict[str, list[int]] = defaultdict(list)
    for index, task in enumerate(remaining):
        refs = {ref(item) for item in task.get("images", [])}
        if not refs or any(name not in source_index for name in refs):
            missing = sorted(name for name in refs if name not in source_index)
            raise ValueError(f"source index missing image references: {missing[:3]}")
        refs_by_task.append(refs)
        for name in refs:
            image_tasks[name].append(index)

    parent = list(range(len(remaining)))
    rank = [0] * len(remaining)
    for indexes in image_tasks.values():
        first = indexes[0]
        for index in indexes[1:]:
            union(parent, rank, first, index)

    components = {}
    for index, task in enumerate(remaining):
        root = find(parent, index)
        component = components.setdefault(root, {"tasks": [], "images": set(), "bytes": 0})
        component["tasks"].append(task)
        component["images"].update(refs_by_task[index])

    for component in components.values():
        component["bytes"] = sum(int(source_index[name]["size"]) for name in component["images"])
        if component["bytes"] > TARGET_PAYLOAD_BYTES:
            raise ValueError("one task/image component exceeds package target")

    bins = []
    for component in sorted(components.values(), key=lambda item: item["bytes"], reverse=True):
        bucket = next(
            (item for item in bins if item["bytes"] + component["bytes"] <= TARGET_PAYLOAD_BYTES),
            None,
        )
        if bucket is None:
            bucket = {"tasks": [], "images": set(), "bytes": 0}
            bins.append(bucket)
        bucket["tasks"].extend(component["tasks"])
        bucket["images"].update(component["images"])
        bucket["bytes"] += component["bytes"]
    return remaining, bins


def manifest_rows(manifest, names):
    rows = {str(row.get("src_rel_path", "")).replace("\\", "/"): row for row in manifest.get("rows", [])}
    missing = sorted(name for name in names if name not in rows)
    if missing:
        raise ValueError(f"manifest missing image references: {missing[:3]}")
    return [rows[name] for name in sorted(names)]


def write_package(output: Path, bucket, source_index, manifest, progress_path: Path):
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_suffix(output.suffix + ".partial")
    if partial.exists():
        raise ValueError(f"partial output exists: {partial}")
    names = sorted(bucket["images"])
    rows = manifest_rows(manifest, names)
    task_payload = {"version": 1, "tasks": bucket["tasks"]}
    manifest_payload = {"version": 1, "rows": rows}
    with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as target:
        target.writestr("tasks.json", json.dumps(task_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        target.writestr("manifest.json", json.dumps(manifest_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        open_archives: dict[str, zipfile.ZipFile] = {}
        try:
            for index, name in enumerate(names, 1):
                info = source_index[name]
                with target.open(name, "w", force_zip64=True) as destination:
                    if info["kind"] == "zip":
                        source_path = info["path"]
                        archive = open_archives.get(source_path)
                        if archive is None:
                            archive = zipfile.ZipFile(source_path)
                            open_archives[source_path] = archive
                        with archive.open(info["internal"]) as source:
                            while chunk := source.read(1024 * 1024):
                                destination.write(chunk)
                    elif info["kind"] == "file":
                        with open(info["path"], "rb") as source:
                            while chunk := source.read(1024 * 1024):
                                destination.write(chunk)
                    else:
                        raise ValueError(f"unsupported source kind: {info['kind']}")
                if index == 1 or index % 250 == 0 or index == len(names):
                    progress_path.write_text(
                        json.dumps(
                            {"status": "building", "output": str(output), "image": index, "images": len(names), "updated_at": time.time()},
                            ensure_ascii=False,
                        ),
                        encoding="utf-8",
                    )
        finally:
            for archive in open_archives.values():
                archive.close()
    os.replace(partial, output)
    with zipfile.ZipFile(output) as check:
        if check.testzip() is not None:
            raise ValueError("ZIP CRC failure")
        tasks = json.loads(check.read("tasks.json"))["tasks"]
        rows = json.loads(check.read("manifest.json"))["rows"]
        images = {name for name in check.namelist() if Path(name).suffix.lower() in IMAGE_SUFFIXES}
        references = {ref(item) for task in tasks for item in task.get("images", [])}
        row_names = {str(row.get("src_rel_path", "")).replace("\\", "/") for row in rows}
        if not references <= images or row_names != images:
            raise ValueError("task/manifest/image coverage mismatch")
    size = output.stat().st_size
    if size > MAX_ZIP_BYTES:
        raise ValueError(f"ZIP exceeds limit: {size}")
    result = {"status": "built_and_validated", "output": str(output), "tasks": len(tasks), "images": len(images), "bytes": size, "updated_at": time.time()}
    progress_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source-index", type=Path, required=True)
    parser.add_argument("--done-zip", type=Path, action="append", default=[])
    parser.add_argument("--done-tasks-json", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--index", type=int, required=True)
    args = parser.parse_args()

    tasks = load_json(args.tasks)["tasks"]
    manifest = load_json(args.manifest)
    source_index = load_json(args.source_index)
    done_ids = task_ids_from_zip(args.done_zip) | task_ids_from_json(args.done_tasks_json)
    remaining, bins = build_bins(tasks, source_index, done_ids)
    if not 1 <= args.index <= len(bins):
        raise ValueError(f"package index must be between 1 and {len(bins)}")
    print(json.dumps({"status": "planned", "remaining_tasks": len(remaining), "package_count": len(bins), "index": args.index, "tasks": len(bins[args.index - 1]["tasks"]), "images": len(bins[args.index - 1]["images"]), "bytes": bins[args.index - 1]["bytes"]}, ensure_ascii=False), flush=True)
    write_package(args.output, bins[args.index - 1], source_index, manifest, args.progress)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise
