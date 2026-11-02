#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import posixpath
import zipfile
from collections import defaultdict
from pathlib import Path

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def is_image(name: str) -> bool:
    return Path(name).suffix.lower() in IMAGE_SUFFIXES


def task_ref(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(
            value.get("src_rel_path")
            or value.get("originalPath")
            or value.get("path")
            or value.get("filename")
            or value.get("image")
            or ""
        )
    return ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--limit", type=int, default=49000)
    parser.add_argument("--max-bytes", type=int, default=19 * 1024 * 1024 * 1024)
    parser.add_argument("--only-part", type=int)
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()

    with zipfile.ZipFile(args.source) as source:
        names = set(source.namelist())
        tasks_name = "tasks.json" if "tasks.json" in names else next(
            name for name in names if name.endswith("/tasks.json")
        )
        manifest_name = "manifest.json" if "manifest.json" in names else next(
            name for name in names if name.endswith("/manifest.json")
        )
        tasks_doc = json.loads(source.read(tasks_name))
        manifest_doc = json.loads(source.read(manifest_name))
        tasks = tasks_doc["tasks"]
        rows = {row["src_rel_path"]: row for row in manifest_doc["rows"]}
        image_infos = {
            info.filename: info
            for info in source.infolist()
            if not info.is_dir() and is_image(info.filename)
        }
        image_sizes = {name: info.file_size for name, info in image_infos.items()}

        # Shared-image tasks form the smallest indivisible groups. Keeping each
        # connected component together prevents repeated references crossing packages.
        print(f"loaded tasks={len(tasks)} images={len(image_infos)}", flush=True)

        parent = list(range(len(tasks)))

        def find(index: int) -> int:
            while parent[index] != index:
                parent[index] = parent[parent[index]]
                index = parent[index]
            return index

        def union(left: int, right: int) -> None:
            left, right = find(left), find(right)
            if left != right:
                parent[right] = left

        first_task_for_image: dict[str, int] = {}
        task_refs: list[set[str]] = []
        for index, task in enumerate(tasks):
            refs = {task_ref(item) for item in task.get("images", [])}
            refs.discard("")
            missing = {name for name in refs if name not in image_infos}
            if missing:
                raise RuntimeError(f"task {task.get('id')} references missing images: {sorted(missing)[:3]}")
            task_refs.append(refs)
            for image in refs:
                previous = first_task_for_image.setdefault(image, index)
                union(index, previous)
            if (index + 1) % 10000 == 0:
                print(f"linked tasks={index + 1}", flush=True)

        groups: dict[int, list[int]] = defaultdict(list)
        for index in range(len(tasks)):
            groups[find(index)].append(index)
        group_data = []
        for indexes in groups.values():
            images = set().union(*(task_refs[index] for index in indexes))
            group_data.append((min(indexes), indexes, images, sum(image_sizes[name] for name in images)))
        group_data.sort(key=lambda item: item[0])

        parts: list[tuple[list[dict], set[str]]] = []
        current_tasks: list[dict] = []
        current_images: set[str] = set()
        current_bytes = 0
        for _, indexes, images, group_bytes in group_data:
            if len(images) + 2 > args.limit or group_bytes > args.max_bytes:
                raise RuntimeError(
                    f"indivisible task group exceeds package limit: tasks={len(indexes)}, "
                    f"images={len(images)}, bytes={group_bytes}"
                )
            added_bytes = sum(image_sizes[name] for name in images - current_images)
            if current_tasks and (
                len(current_images | images) + 2 > args.limit
                or current_bytes + added_bytes > args.max_bytes
            ):
                parts.append((current_tasks, current_images))
                current_tasks = []
                current_images = set()
                current_bytes = 0
            current_tasks.extend(tasks[index] for index in indexes)
            current_images.update(images)
            current_bytes += added_bytes
        if current_tasks:
            parts.append((current_tasks, current_images))

        print(json.dumps({
            "source": str(args.source),
            "parts": len(parts),
            "source_tasks": len(tasks),
            "source_images": len(image_infos),
            "task_groups": len(group_data),
            "part_summaries": [
                {"part": i + 1, "tasks": len(ts), "images": len(imgs), "entries": len(imgs) + 2}
                for i, (ts, imgs) in enumerate(parts)
            ],
        }, ensure_ascii=False, indent=2), flush=True)

        if args.plan_only:
            return 0
        args.output_dir.mkdir(parents=True, exist_ok=True)
        for part_index, (part_tasks, part_images) in enumerate(parts, start=1):
            if args.only_part and part_index != args.only_part:
                continue
            output = args.output_dir / f"new_selected_images_export_part_{part_index:02d}.zip"
            partial = output.with_suffix(".zip.partial")
            if output.exists():
                raise RuntimeError(f"refusing to overwrite {output}")
            if partial.exists():
                partial.unlink()
            ordered_images = sorted(part_images)
            part_rows = [rows[name] for name in ordered_images]
            tasks_json = json.dumps({"version": 1, "tasks": part_tasks}, ensure_ascii=False, separators=(",", ":")).encode()
            manifest_json = json.dumps({"version": 1, "rows": part_rows}, ensure_ascii=False, separators=(",", ":")).encode()
            if len(tasks_json) >= 64 * 1024 * 1024 or len(manifest_json) >= 64 * 1024 * 1024:
                raise RuntimeError(f"JSON too large for part {part_index}")
            with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as target:
                for i, name in enumerate(ordered_images, start=1):
                    with source.open(name) as reader, target.open(name, "w", force_zip64=True) as writer:
                        while True:
                            chunk = reader.read(1024 * 1024)
                            if not chunk:
                                break
                            writer.write(chunk)
                    if i % 500 == 0 or i == len(ordered_images):
                        print(f"part={part_index} images={i}/{len(ordered_images)}", flush=True)
                target.writestr("tasks.json", tasks_json)
                target.writestr("manifest.json", manifest_json)
            with zipfile.ZipFile(partial) as check:
                if check.testzip():
                    raise RuntimeError(f"CRC failure in part {part_index}")
                if len(check.infolist()) > args.limit:
                    raise RuntimeError(f"entry limit exceeded in part {part_index}")
            os.replace(partial, output)
            print(json.dumps({
                "built": str(output),
                "bytes": output.stat().st_size,
                "tasks": len(part_tasks),
                "images": len(ordered_images),
                "entries": len(ordered_images) + 2,
                "source_bytes": sum(image_sizes[name] for name in ordered_images),
                "tasks_json_bytes": len(tasks_json),
                "manifest_json_bytes": len(manifest_json),
            }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
