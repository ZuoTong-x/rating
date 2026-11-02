import argparse
import json
import os
import sys
import time
import zipfile
from collections import defaultdict


TARGET_BYTES = 20_000_000_000
JSON_NAMES = {"tasks.json", "manifest.json"}


class DisjointSet:
    def __init__(self, values):
        self.parent = {value: value for value in values}
        self.rank = {value: 0 for value in values}

    def find(self, value):
        parent = self.parent[value]
        if parent != value:
            self.parent[value] = self.find(parent)
        return self.parent[value]

    def union(self, left, right):
        left = self.find(left)
        right = self.find(right)
        if left == right:
            return
        if self.rank[left] < self.rank[right]:
            left, right = right, left
        self.parent[right] = left
        if self.rank[left] == self.rank[right]:
            self.rank[left] += 1


def read_source(source_path):
    with zipfile.ZipFile(source_path) as archive:
        infos = archive.infolist()
        info_by_name = {info.filename: info for info in infos}
        if not JSON_NAMES.issubset(info_by_name):
            raise ValueError("source ZIP must contain root tasks.json and manifest.json")
        image_infos = [
            info
            for info in infos
            if info.filename not in JSON_NAMES and not info.is_dir()
        ]
        image_names = {info.filename for info in image_infos}
        tasks_doc = json.load(archive.open("tasks.json"))
        manifest_doc = json.load(archive.open("manifest.json"))

    tasks = tasks_doc.get("tasks")
    rows = manifest_doc.get("rows")
    if not isinstance(tasks, list) or not isinstance(rows, list):
        raise ValueError("source JSON must contain tasks and rows arrays")
    manifest_names = [row.get("src_rel_path") for row in rows]
    if len(set(manifest_names)) != len(manifest_names):
        raise ValueError("manifest contains duplicate src_rel_path values")
    if set(manifest_names) != image_names:
        missing = image_names - set(manifest_names)
        extra = set(manifest_names) - image_names
        raise ValueError(
            f"manifest/image mismatch: missing={len(missing)} extra={len(extra)}"
        )
    task_ids = [task.get("id") for task in tasks]
    if len(set(task_ids)) != len(task_ids):
        raise ValueError("source tasks contain duplicate IDs")

    dsu = DisjointSet(image_names)
    task_images = []
    for task_index, task in enumerate(tasks):
        images = task.get("images")
        if not isinstance(images, list) or not 1 <= len(images) <= 5:
            raise ValueError(f"task {task_index} must contain 1-5 images")
        names = [image.get("src_rel_path") for image in images]
        if any(name not in image_names for name in names):
            raise ValueError(f"task {task_index} references an image outside the ZIP")
        if len(set(names)) != len(names):
            raise ValueError(f"task {task_index} repeats an image")
        for name in names[1:]:
            dsu.union(names[0], name)
        task_images.append(names)

    component_images = defaultdict(set)
    for name in image_names:
        component_images[dsu.find(name)].add(name)
    component_tasks = defaultdict(list)
    for task_index, names in enumerate(task_images):
        component_tasks[dsu.find(names[0])].append(task_index)

    image_sizes = {info.filename: info.file_size for info in image_infos}
    components = []
    for root, names in component_images.items():
        components.append(
            (
                sum(image_sizes[name] for name in names),
                root,
                names,
                component_tasks.get(root, []),
            )
        )
    components.sort(reverse=True, key=lambda item: (item[0], item[1]))

    buckets = [{"image_names": set(), "task_indices": [], "bytes": 0} for _ in range(3)]
    bucket_index = 0
    for component_bytes, _root, names, indices in components:
        if bucket_index < 2 and buckets[bucket_index]["bytes"]:
            if buckets[bucket_index]["bytes"] + component_bytes > TARGET_BYTES:
                bucket_index += 1
        bucket = buckets[bucket_index]
        bucket["image_names"].update(names)
        bucket["task_indices"].extend(indices)
        bucket["bytes"] += component_bytes

    # Images not referenced by a task still belong in the final package.
    referenced = set().union(*(bucket["image_names"] for bucket in buckets))
    buckets[2]["image_names"].update(image_names - referenced)
    buckets[2]["bytes"] += sum(image_sizes[name] for name in image_names - referenced)

    for bucket in buckets:
        bucket["task_indices"].sort()
        bucket["task_ids"] = {tasks[i]["id"] for i in bucket["task_indices"]}

    return {
        "infos": infos,
        "info_by_name": info_by_name,
        "image_names": image_names,
        "image_sizes": image_sizes,
        "tasks_doc": tasks_doc,
        "manifest_doc": manifest_doc,
        "tasks": tasks,
        "rows": rows,
        "buckets": buckets,
    }


def write_json_entry(archive, name, document):
    payload = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
    archive.writestr(name, payload.encode("utf-8"), compress_type=zipfile.ZIP_STORED)


def validate_package(path, expected_task_count, expected_image_names):
    with zipfile.ZipFile(path) as archive:
        bad = archive.testzip()
        if bad:
            raise ValueError(f"CRC failure in {path}: {bad}")
        names = {info.filename for info in archive.infolist() if info.filename not in JSON_NAMES and not info.is_dir()}
        if names != expected_image_names:
            raise ValueError(
                f"package image mismatch: expected={len(expected_image_names)} actual={len(names)}"
            )
        tasks_doc = json.load(archive.open("tasks.json"))
        manifest_doc = json.load(archive.open("manifest.json"))
    tasks = tasks_doc.get("tasks")
    rows = manifest_doc.get("rows")
    if len(tasks) != expected_task_count:
        raise ValueError(f"package task count mismatch: {len(tasks)} != {expected_task_count}")
    ids = [task.get("id") for task in tasks]
    if len(ids) != len(set(ids)):
        raise ValueError("package contains duplicate task IDs")
    refs = []
    for task in tasks:
        images = task.get("images")
        if not isinstance(images, list) or not 1 <= len(images) <= 5:
            raise ValueError(f"invalid image count in task {task.get('id')}")
        task_refs = [image.get("src_rel_path") for image in images]
        if len(task_refs) != len(set(task_refs)) or not set(task_refs) <= names:
            raise ValueError(f"invalid image refs in task {task.get('id')}")
        refs.extend(task_refs)
    row_names = [row.get("src_rel_path") for row in rows]
    if len(row_names) != len(set(row_names)) or set(row_names) != names:
        raise ValueError("package manifest does not exactly match package images")
    return {
        "tasks": len(tasks),
        "images": len(names),
        "task_image_refs": len(refs),
        "bytes": os.path.getsize(path),
    }


def build_package(source_path, output_path, part):
    if part not in (1, 2, 3):
        raise ValueError("--part must be 1, 2, or 3")
    source = read_source(source_path)
    bucket = source["buckets"][part - 1]
    task_indices = bucket["task_indices"]
    image_names = bucket["image_names"]
    output_tmp = output_path + ".partial"
    if os.path.exists(output_tmp):
        os.remove(output_tmp)
    if os.path.exists(output_path):
        os.remove(output_path)

    selected_tasks = [source["tasks"][i] for i in task_indices]
    selected_rows = [row for row in source["rows"] if row.get("src_rel_path") in image_names]
    if len(selected_rows) != len(image_names):
        raise ValueError("failed to select one manifest row for each image")
    tasks_doc = dict(source["tasks_doc"])
    tasks_doc["tasks"] = selected_tasks
    manifest_doc = dict(source["manifest_doc"])
    manifest_doc["rows"] = selected_rows

    started = time.time()
    copied = 0
    with zipfile.ZipFile(source_path, "r") as source_archive, zipfile.ZipFile(
        output_tmp, "w", compression=zipfile.ZIP_STORED, allowZip64=True
    ) as output_archive:
        for info in source["infos"]:
            if info.filename in JSON_NAMES or info.is_dir() or info.filename not in image_names:
                continue
            with source_archive.open(info, "r") as input_stream, output_archive.open(
                info.filename, "w", force_zip64=True
            ) as output_stream:
                while True:
                    chunk = input_stream.read(8 * 1024 * 1024)
                    if not chunk:
                        break
                    output_stream.write(chunk)
            copied += info.file_size
            if copied == info.file_size or copied % (1024**3) < info.file_size:
                elapsed = max(time.time() - started, 0.001)
                print(
                    f"part {part}: {copied / 1e9:.2f} GB / {bucket['bytes'] / 1e9:.2f} GB "
                    f"({copied / bucket['bytes'] * 100:.1f}%), {copied / elapsed / 1e6:.1f} MB/s",
                    flush=True,
                )
        write_json_entry(output_archive, "tasks.json", tasks_doc)
        write_json_entry(output_archive, "manifest.json", manifest_doc)
    os.replace(output_tmp, output_path)
    result = validate_package(output_path, len(selected_tasks), image_names)
    result.update({"part": part, "planned_image_bytes": bucket["bytes"]})
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--part", type=int, required=True)
    args = parser.parse_args()
    try:
        build_package(args.source, args.output, args.part)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
