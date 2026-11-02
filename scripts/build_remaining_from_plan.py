from __future__ import annotations

import argparse
import json
import os
import time
import zipfile
from collections import defaultdict
from pathlib import Path

TARGET_BYTES = 19_500_000_000
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def ref(item):
    if isinstance(item, str):
        return item.replace("\\", "/")
    return str(item.get("src_rel_path") or item.get("originalPath") or item.get("filename") or "").replace("\\", "/")


def find(parent, x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def union(parent, rank, a, b):
    a, b = find(parent, a), find(parent, b)
    if a == b:
        return
    if rank[a] < rank[b]:
        a, b = b, a
    parent[b] = a
    if rank[a] == rank[b]:
        rank[a] += 1


def make_bins(tasks, records, task_rows, row_record, excluded, sizes):
    record_names = [record["dest"] for record in records]
    remaining = [
        (index, task) for index, task in enumerate(tasks)
        if str(task.get("id")) not in excluded
    ]
    parent = list(range(len(remaining)))
    rank = [0] * len(remaining)
    image_tasks = defaultdict(list)
    refs_by_task = []
    for local, (task_index, task) in enumerate(remaining):
        image_ids = {row_record[str(row)] if str(row) in row_record else row_record[row] for row in task_rows[task_index]}
        names = {record_names[item] for item in image_ids}
        refs_by_task.append(names)
        for name in names:
            image_tasks[name].append(local)
    for indexes in image_tasks.values():
        for index in indexes[1:]:
            union(parent, rank, indexes[0], index)
    components = {}
    for local, (task_index, task) in enumerate(remaining):
        root = find(parent, local)
        component = components.setdefault(root, {"tasks": [], "images": set(), "bytes": 0})
        component["tasks"].append((task_index, task))
        component["images"].update(refs_by_task[local])
    for component in components.values():
        component["bytes"] = sum(sizes[name] for name in component["images"])
        if component["bytes"] > TARGET_BYTES:
            raise ValueError("task-image component exceeds package target")
    bins = []
    for component in sorted(components.values(), key=lambda item: item["bytes"], reverse=True):
        bucket = next((item for item in bins if item["bytes"] + component["bytes"] <= TARGET_BYTES), None)
        if bucket is None:
            bucket = {"tasks": [], "images": set(), "bytes": 0}
            bins.append(bucket)
        bucket["tasks"].extend(component["tasks"])
        bucket["images"].update(component["images"])
        bucket["bytes"] += component["bytes"]
    return remaining, bins


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, required=True)
    ap.add_argument("--plan", type=Path, required=True)
    ap.add_argument("--done", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--progress", type=Path, required=True)
    ap.add_argument("--index", type=int, required=True)
    args = ap.parse_args()
    plan = load(args.plan)
    done = {str(t["id"]) for t in load(args.done)["tasks"]}
    with zipfile.ZipFile(args.source) as source_zip:
        infos = {item.filename: item for item in source_zip.infolist()}
    sizes = {name: info.file_size for name, info in infos.items() if Path(name).suffix.lower() in IMAGE_SUFFIXES}
    remaining, bins = make_bins(plan["tasks"], plan["records"], plan["task_rows"], plan["row_record"], done, sizes)
    if not 1 <= args.index <= len(bins):
        raise ValueError(f"package index must be between 1 and {len(bins)}")
    bucket = bins[args.index - 1]
    record_by_name = {record["dest"]: record for record in plan["records"]}
    row_by_record = {}
    for row_index, record_index in plan["row_record"].items():
        row_by_record.setdefault(str(record_index), plan["rows"][int(row_index)])
    rows_out = []
    for name in sorted(bucket["images"]):
        row = dict(row_by_record.get(str(next(i for i, r in enumerate(plan["records"]) if r["dest"] == name)), {"source": "task_reference"}))
        row.update({"src_rel_path": name, "dest_rel_path": name, "image_filename": name, "image_path": name})
        rows_out.append(row)
    tasks_out = [{"id": str(task["id"]), "criterion": task["criterion"], "images": [{"src_rel_path": record_by_name[plan["records"][plan["row_record"][str(row)]]["dest"]]["dest"]} for row in plan["task_rows"][task_index]]} for task_index, task in bucket["tasks"]]
    partial = args.output.with_suffix(args.output.suffix + ".partial")
    if partial.exists():
        raise ValueError(f"partial output exists: {partial}")
    with zipfile.ZipFile(args.source) as source_zip, zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as target:
        target.writestr("tasks.json", json.dumps({"version": 1, "tasks": tasks_out}, ensure_ascii=False, separators=(",", ":")).encode())
        target.writestr("manifest.json", json.dumps({"version": 1, "rows": rows_out}, ensure_ascii=False, separators=(",", ":")).encode())
        for name in sorted(bucket["images"]):
            with source_zip.open(name) as source, target.open(name, "w", force_zip64=True) as output:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
    os.replace(partial, args.output)
    with zipfile.ZipFile(args.output) as check:
        if check.testzip():
            raise ValueError("ZIP CRC failure")
        check_tasks = json.loads(check.read("tasks.json"))["tasks"]
        check_rows = json.loads(check.read("manifest.json"))["rows"]
        images = {name for name in check.namelist() if Path(name).suffix.lower() in IMAGE_SUFFIXES}
        refs = {ref(item) for task in check_tasks for item in task["images"]}
        if not refs <= images or {str(row.get("image_filename")) for row in check_rows} != images:
            raise ValueError("task/manifest/image coverage mismatch")
    if args.output.stat().st_size > 20_000_000_000:
        raise ValueError("package exceeds 20GB")
    result = {"status": "built_and_validated", "package_index": args.index, "package_count": len(bins), "tasks": len(tasks_out), "images": len(bucket["images"]), "bytes": args.output.stat().st_size, "remaining_tasks": len(remaining), "updated_at": time.time()}
    args.progress.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
