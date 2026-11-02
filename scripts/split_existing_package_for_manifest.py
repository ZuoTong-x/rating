from __future__ import annotations

import argparse
import json
import os
import zipfile
from collections import defaultdict, deque
from pathlib import Path

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
MAX_MANIFEST_BYTES = 64 * 1024 * 1024


def references(task):
    out = set()
    for item in task.get("images", []):
        if isinstance(item, str):
            out.add(item.replace("\\", "/"))
        else:
            out.add(str(item.get("src_rel_path") or item.get("filename") or item.get("originalPath") or "").replace("\\", "/"))
    return out


def connected_groups(tasks):
    image_tasks = defaultdict(list)
    refs = []
    for i, task in enumerate(tasks):
        names = references(task)
        refs.append(names)
        for name in names:
            image_tasks[name].append(i)
    parent = list(range(len(tasks)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        a, b = find(a), find(b)
        if a != b:
            parent[b] = a

    for indexes in image_tasks.values():
        for i in indexes[1:]:
            union(indexes[0], i)
    groups = defaultdict(list)
    for i in range(len(tasks)):
        groups[find(i)].append(i)
    return list(groups.values()), refs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, required=True)
    ap.add_argument("--out-dir", type=Path, required=True)
    args = ap.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.source) as source:
        tasks_doc = json.loads(source.read("tasks.json"))
        manifest_doc = json.loads(source.read("manifest.json"))
        tasks = tasks_doc["tasks"]
        rows = manifest_doc["rows"]
        info = {i.filename: i for i in source.infolist()}
        sizes = {name: info[name].file_size for name in info if Path(name).suffix.lower() in IMAGE_SUFFIXES}
        row_by_name = {str(r.get("src_rel_path") or r.get("image_filename")): r for r in rows}
        groups, refs = connected_groups(tasks)
        if len(groups) < 2:
            raise RuntimeError("任务图片引用关系只有一个连通分量，不能无损拆成两个包")
        groups.sort(key=lambda g: sum(sizes[n] for i in g for n in refs[i]), reverse=True)
        buckets = [[], []]
        bucket_images = [set(), set()]
        bucket_bytes = [0, 0]
        for group in groups:
            names = set().union(*(refs[i] for i in group))
            size = sum(sizes[n] for n in names)
            target = 0 if bucket_bytes[0] <= bucket_bytes[1] else 1
            buckets[target].extend(group)
            bucket_images[target].update(names)
            bucket_bytes[target] += size
        for number in range(2):
            selected = set(buckets[number])
            out = args.out_dir / f"V030_images_remaining_20G_003_{number + 1}.zip"
            partial = out.with_suffix(out.suffix + ".partial")
            task_out = {"version": 1, "tasks": [tasks[i] for i in buckets[number]]}
            manifest_out = {"version": 1, "rows": [row_by_name[n] for n in sorted(bucket_images[number])]}
            task_bytes = json.dumps(task_out, ensure_ascii=False, separators=(",", ":")).encode()
            manifest_bytes = json.dumps(manifest_out, ensure_ascii=False, separators=(",", ":")).encode()
            if len(manifest_bytes) > MAX_MANIFEST_BYTES:
                raise RuntimeError(f"part {number + 1} manifest exceeds 64MiB")
            if partial.exists():
                partial.unlink()
            with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as target:
                target.writestr("tasks.json", task_bytes)
                target.writestr("manifest.json", manifest_bytes)
                for name in sorted(bucket_images[number]):
                    with source.open(name) as inp, target.open(name, "w", force_zip64=True) as outp:
                        while chunk := inp.read(1024 * 1024):
                            outp.write(chunk)
            os.replace(partial, out)
            with zipfile.ZipFile(out) as check:
                if check.testzip():
                    raise RuntimeError(f"CRC failure in {out.name}")
                check_tasks = json.loads(check.read("tasks.json"))["tasks"]
                check_rows = json.loads(check.read("manifest.json"))["rows"]
                images = {i.filename for i in check.infolist() if Path(i.filename).suffix.lower() in IMAGE_SUFFIXES}
                refs_check = {n for t in check_tasks for n in references(t)}
                rows_check = {str(r.get("src_rel_path") or r.get("image_filename")) for r in check_rows}
                if not refs_check <= images or rows_check != images:
                    raise RuntimeError(f"coverage mismatch in {out.name}")
            print(json.dumps({"part": number + 1, "tasks": len(buckets[number]), "images": len(bucket_images[number]), "bytes": out.stat().st_size, "manifest_bytes": len(manifest_bytes), "path": str(out)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
