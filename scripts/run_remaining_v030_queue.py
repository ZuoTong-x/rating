from __future__ import annotations

import argparse
import json
import os
import time
import zipfile
from collections import defaultdict
from pathlib import Path


# Reserve room for tasks.json, manifest.json, and ZIP metadata.
TARGET_BYTES = 19_500_000_000
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def task_ref(item: object) -> str:
    if isinstance(item, str):
        return item.replace("\\", "/")
    if isinstance(item, dict):
        return str(
            item.get("src_rel_path")
            or item.get("originalPath")
            or item.get("path")
            or item.get("filename")
            or ""
        ).replace("\\", "/")
    return ""


def find(value: int, parent: list[int]) -> int:
    while parent[value] != value:
        parent[value] = parent[parent[value]]
        value = parent[value]
    return value


def union(left: int, right: int, parent: list[int], rank: list[int]) -> None:
    left, right = find(left, parent), find(right, parent)
    if left == right:
        return
    if rank[left] < rank[right]:
        left, right = right, left
    parent[right] = left
    if rank[left] == rank[right]:
        rank[left] += 1


def build_bins(tasks: list[dict], excluded: set[str], sizes: dict[str, int]):
    remaining = [task for task in tasks if str(task.get("id")) not in excluded]
    parent = list(range(len(remaining)))
    rank = [0] * len(remaining)
    image_tasks: dict[str, list[int]] = defaultdict(list)
    refs_by_task: list[set[str]] = []

    for index, task in enumerate(remaining):
        refs = {task_ref(item) for item in task.get("images", []) if task_ref(item)}
        if not refs:
            raise ValueError(f"task has no image references: {task.get('id')}")
        refs_by_task.append(refs)
        for ref in refs:
            image_tasks[ref].append(index)

    for indexes in image_tasks.values():
        for index in indexes[1:]:
            union(indexes[0], index, parent, rank)

    components: dict[int, dict] = {}
    for index, task in enumerate(remaining):
        root = find(index, parent)
        component = components.setdefault(root, {"tasks": [], "images": set(), "bytes": 0})
        component["tasks"].append(task)
        component["images"].update(refs_by_task[index])

    for component in components.values():
        component["bytes"] = sum(sizes[name] for name in component["images"])
        if component["bytes"] > TARGET_BYTES:
            raise ValueError("one task-image component exceeds the 20GB package target")

    bins: list[dict] = []
    for component in sorted(components.values(), key=lambda item: item["bytes"], reverse=True):
        bucket = next((item for item in bins if item["bytes"] + component["bytes"] <= TARGET_BYTES), None)
        if bucket is None:
            bucket = {"tasks": [], "images": set(), "bytes": 0}
            bins.append(bucket)
        bucket["tasks"].extend(component["tasks"])
        bucket["images"].update(component["images"])
        bucket["bytes"] += component["bytes"]
    return remaining, bins


def validate_package(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        bad = archive.testzip()
        if bad:
            raise ValueError(f"CRC failure: {bad}")
        task_doc = json.loads(archive.read("tasks.json"))
        manifest_doc = json.loads(archive.read("manifest.json"))
        tasks = task_doc.get("tasks")
        rows = manifest_doc.get("rows")
        if not isinstance(tasks, list) or not isinstance(rows, list):
            raise ValueError("tasks.json or manifest.json has invalid shape")
        image_names = {
            name
            for name in archive.namelist()
            if Path(name).suffix.lower() in IMAGE_SUFFIXES
        }
        refs = {task_ref(item) for task in tasks for item in task.get("images", [])}
        row_names = {str(row.get("image_filename") or row.get("src_rel_path") or "") for row in rows}
        if not refs <= image_names:
            raise ValueError(f"task references missing images: {sorted(refs - image_names)[:3]}")
        if row_names != image_names:
            raise ValueError("manifest/image coverage mismatch")
        if len({str(task.get("id")) for task in tasks}) != len(tasks):
            raise ValueError("duplicate task ids")
        if path.stat().st_size > TARGET_BYTES:
            raise ValueError(f"package exceeds target: {path.stat().st_size}")
        return {"bytes": path.stat().st_size, "tasks": len(tasks), "images": len(image_names), "manifest_rows": len(rows)}


def build_one(source: Path, tasks_path: Path, manifest_path: Path, done_tasks_path: Path, output: Path, progress: Path, index: int) -> None:
    source_doc = load_json(tasks_path)
    manifest_doc = load_json(manifest_path)
    tasks = source_doc["tasks"]
    rows = manifest_doc["rows"]
    done_doc = load_json(done_tasks_path)
    excluded = {str(task["id"]) for task in done_doc["tasks"]}

    with zipfile.ZipFile(source) as archive:
        infos = {info.filename: info for info in archive.infolist()}
        sizes = {name: infos[name].file_size for name in infos if Path(name).suffix.lower() in IMAGE_SUFFIXES}

    remaining, bins = build_bins(tasks, excluded, sizes)
    if index < 1 or index > len(bins):
        raise ValueError(f"package index must be between 1 and {len(bins)}")
    bucket = bins[index - 1]
    selected_names = set(bucket["images"])
    selected_tasks = bucket["tasks"]
    rows_by_name = {
        str(row.get("image_filename") or row.get("src_rel_path") or ""): row
        for row in rows
    }
    selected_rows = [rows_by_name[name] for name in sorted(selected_names)]
    tasks_out = {key: value for key, value in source_doc.items() if key != "tasks"}
    tasks_out["tasks"] = selected_tasks
    manifest_out = {key: value for key, value in manifest_doc.items() if key != "rows"}
    manifest_out["rows"] = selected_rows

    partial = output.with_suffix(output.suffix + ".partial")
    if partial.exists():
        raise ValueError(f"partial output exists: {partial}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source) as source_zip, zipfile.ZipFile(
        partial, "w", compression=zipfile.ZIP_STORED, allowZip64=True
    ) as target:
        target.writestr("tasks.json", json.dumps(tasks_out, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        target.writestr("manifest.json", json.dumps(manifest_out, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        for name in sorted(selected_names):
            with source_zip.open(name) as source_file, target.open(name, "w", force_zip64=True) as target_file:
                while chunk := source_file.read(1024 * 1024):
                    target_file.write(chunk)
    os.replace(partial, output)
    result = validate_package(output)
    record = {
        "version": 1,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "package_index": index,
        "package_count": len(bins),
        "remaining_tasks": len(remaining),
        "output": str(output),
        **result,
        "status": "built_and_validated",
    }
    progress.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(record, ensure_ascii=False), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--done-tasks", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--index", type=int, required=True)
    args = parser.parse_args()
    build_one(args.source, args.tasks, args.manifest, args.done_tasks, args.output, args.progress, args.index)


if __name__ == "__main__":
    main()
