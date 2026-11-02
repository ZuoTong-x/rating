from __future__ import annotations

import argparse
import io
import json
import os
import time
import zipfile
from collections import defaultdict
from pathlib import Path

from PIL import Image


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
TARGET = 1_800_000_000


def load_source(path: Path):
    with zipfile.ZipFile(path) as z:
        infos = {i.filename: i for i in z.infolist()}
        tasks_doc = json.loads(z.read("tasks.json"))
        manifest_doc = json.loads(z.read("manifest.json"))
    tasks = tasks_doc["tasks"]
    rows = manifest_doc["rows"]
    sizes = {row["src_rel_path"]: infos[row["src_rel_path"]].file_size for row in rows}
    return tasks_doc, manifest_doc, tasks, rows, infos, sizes


def old_task_ids(paths):
    result = set()
    for path in paths:
        if not path.exists():
            continue
        with zipfile.ZipFile(path) as z:
            result.update(str(task["id"]) for task in json.loads(z.read("tasks.json"))["tasks"])
    return result


def components(tasks):
    image_tasks = defaultdict(list)
    for index, task in enumerate(tasks):
        for item in {image["src_rel_path"] for image in task["images"]}:
            image_tasks[item].append(index)
    parent = list(range(len(tasks)))
    rank = [0] * len(tasks)

    def find(value):
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = parent[value]
        return value

    def union(left, right):
        left, right = find(left), find(right)
        if left == right:
            return
        if rank[left] < rank[right]:
            left, right = right, left
        parent[right] = left
        if rank[left] == rank[right]:
            rank[left] += 1

    for indexes in image_tasks.values():
        first = indexes[0]
        for index in indexes[1:]:
            union(first, index)
    groups = defaultdict(list)
    for index in range(len(tasks)):
        groups[find(index)].append(index)
    return list(groups.values()), image_tasks


def make_chunks(groups, tasks, sizes):
    chunks = []
    for indexes in groups:
        current, image_names, byte_count = [], set(), 0
        for index in indexes:
            refs = {item["src_rel_path"] for item in tasks[index]["images"]}
            added = sum(sizes[name] for name in refs - image_names)
            if current and byte_count + added > TARGET:
                chunks.append((byte_count, current, image_names))
                current, image_names, byte_count = [], set(), 0
            current.append(index)
            image_names.update(refs)
            byte_count += added
        if current:
            chunks.append((byte_count, current, image_names))
    return sorted(chunks, key=lambda item: item[0], reverse=True)


def pack_chunks(chunks):
    bins = []
    for size, indexes, images in chunks:
        for bucket in bins:
            if bucket[0] + size <= TARGET:
                bucket[0] += size
                bucket[1].extend(indexes)
                bucket[2].update(images)
                break
        else:
            bins.append([size, list(indexes), set(images)])
    return bins


def normalize_image(data, name):
    extension = Path(name).suffix.lower()
    with Image.open(io.BytesIO(data)) as image:
        actual = (image.format or "").upper()
        expected = {
            ".jpg": {"JPEG"}, ".jpeg": {"JPEG"}, ".png": {"PNG"},
            ".webp": {"WEBP"}, ".gif": {"GIF"},
        }.get(extension, set())
        image.verify()
    if actual in expected:
        return data, None
    with Image.open(io.BytesIO(data)) as image:
        image = image.convert("RGB") if extension in {".jpg", ".jpeg"} else image.copy()
        output = io.BytesIO()
        fmt = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP", ".gif": "GIF"}.get(extension)
        if not fmt:
            raise ValueError(f"unsupported image extension: {name}")
        image.save(output, format=fmt, quality=95 if fmt == "JPEG" else None)
        return output.getvalue(), {"name": name, "actual": actual, "target": fmt}


def build(source_path, output_path, progress_path, old_paths, package_index):
    tasks_doc, manifest_doc, tasks, rows, infos, sizes = load_source(source_path)
    excluded = old_task_ids(old_paths)
    remaining = [task for task in tasks if str(task["id"]) not in excluded]
    groups, _ = components(remaining)
    bins = pack_chunks(make_chunks(groups, remaining, sizes))
    if package_index < 1 or package_index > len(bins):
        raise ValueError(f"package index must be between 1 and {len(bins)}")
    byte_count, indexes, image_names = bins[package_index - 1]
    selected_tasks = [remaining[index] for index in indexes]
    selected_rows = [row for row in rows if row["src_rel_path"] in image_names]
    package_tasks = dict(tasks_doc)
    package_tasks["tasks"] = selected_tasks
    package_manifest = dict(manifest_doc)
    package_manifest["rows"] = selected_rows

    temporary = output_path.with_suffix(output_path.suffix + ".partial")
    if temporary.exists():
        temporary.unlink()
    repaired = []
    with zipfile.ZipFile(source_path) as source, zipfile.ZipFile(
        temporary, "w", compression=zipfile.ZIP_STORED, allowZip64=False
    ) as target:
        target.writestr("tasks.json", json.dumps(package_tasks, ensure_ascii=False, separators=(",", ":")).encode())
        target.writestr("manifest.json", json.dumps(package_manifest, ensure_ascii=False, separators=(",", ":")).encode())
        for name in sorted(image_names):
            data, repair = normalize_image(source.read(infos[name].filename), name)
            if repair:
                repaired.append(repair)
            target.writestr(name, data)
    os.replace(temporary, output_path)
    with zipfile.ZipFile(output_path) as check:
        bad = check.testzip()
        if bad:
            raise ValueError(f"CRC failure: {bad}")
        tasks_check = json.loads(check.read("tasks.json"))["tasks"]
        rows_check = json.loads(check.read("manifest.json"))["rows"]
        images_check = {i.filename for i in check.infolist() if Path(i.filename).suffix.lower() in IMAGE_SUFFIXES}
        refs = {x["src_rel_path"] for task in tasks_check for x in task["images"]}
        row_refs = {row["src_rel_path"] for row in rows_check}
        if not refs <= images_check or row_refs != images_check:
            raise ValueError("task/manifest/image coverage mismatch")
    if output_path.stat().st_size >= 2_000_000_000:
        raise ValueError("package is not below 2GB")
    progress = {
        "version": 1,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "package_index": package_index,
        "package_count_estimate": len(bins),
        "processed_task_ids": [str(task["id"]) for task in selected_tasks],
        "repaired_images": repaired,
        "output": str(output_path),
        "bytes": output_path.stat().st_size,
        "tasks": len(selected_tasks),
        "images": len(image_names),
        "manifest_rows": len(rows_check),
    }
    progress_path.write_text(json.dumps(progress, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(progress, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--old", type=Path, action="append", default=[])
    parser.add_argument("--index", type=int, default=1)
    args = parser.parse_args()
    build(args.source, args.output, args.progress, args.old, args.index)


if __name__ == "__main__":
    main()
