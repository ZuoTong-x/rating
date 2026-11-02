from __future__ import annotations

import argparse
import json
import os
import time
import zipfile
from pathlib import Path


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
JSON_NAMES = {"tasks.json", "manifest.json"}
DEFAULT_TARGET = 1_800_000_000


def load_source(source_path: Path):
    with zipfile.ZipFile(source_path, "r") as archive:
        infos = archive.infolist()
        info_by_name = {info.filename: info for info in infos}
        tasks_doc = json.loads(archive.read("tasks.json").decode("utf-8"))
        manifest_doc = json.loads(archive.read("manifest.json").decode("utf-8"))

    tasks = tasks_doc.get("tasks")
    rows = manifest_doc.get("rows")
    if not isinstance(tasks, list) or not isinstance(rows, list):
        raise ValueError("source JSON must contain tasks and rows arrays")
    image_infos = {
        info.filename: info
        for info in infos
        if not info.is_dir()
        and info.filename not in JSON_NAMES
        and Path(info.filename).suffix.lower() in IMAGE_SUFFIXES
    }
    image_names = set(image_infos)
    manifest_names = {row.get("src_rel_path") for row in rows}
    if manifest_names != image_names:
        raise ValueError(
            f"manifest/image mismatch: manifest={len(manifest_names)} images={len(image_names)}"
        )
    task_ids = [str(task.get("id", "")) for task in tasks]
    if len(task_ids) != len(set(task_ids)):
        raise ValueError("source tasks contain duplicate IDs")
    for index, task in enumerate(tasks):
        images = task.get("images")
        if not isinstance(images, list) or not 1 <= len(images) <= 5:
            raise ValueError(f"task {index} must contain 1-5 images")
        refs = [image.get("src_rel_path") for image in images]
        if len(refs) != len(set(refs)) or not set(refs) <= image_names:
            raise ValueError(f"task {index} contains invalid image references")
    return tasks_doc, manifest_doc, tasks, rows, image_infos


def read_progress(path: Path) -> set[str]:
    if not path.exists():
        return set()
    document = json.loads(path.read_text(encoding="utf-8"))
    return {str(value) for value in document.get("processed_task_ids", [])}


def write_progress(path: Path, processed_ids: set[str], package: dict) -> None:
    payload = {
        "version": 1,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "processed_task_ids": sorted(processed_ids),
        "last_package": package,
    }
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def validate(path: Path) -> dict:
    with zipfile.ZipFile(path, "r") as archive:
        bad = archive.testzip()
        if bad:
            raise ValueError(f"CRC failure: {bad}")
        members = {info.filename for info in archive.infolist() if not info.is_dir()}
        tasks_doc = json.loads(archive.read("tasks.json").decode("utf-8"))
        manifest_doc = json.loads(archive.read("manifest.json").decode("utf-8"))
    images = {name for name in members if Path(name).suffix.lower() in IMAGE_SUFFIXES}
    tasks = tasks_doc.get("tasks")
    rows = manifest_doc.get("rows")
    if not isinstance(tasks, list) or not isinstance(rows, list):
        raise ValueError("package JSON shape is invalid")
    ids = [str(task.get("id")) for task in tasks]
    if len(ids) != len(set(ids)):
        raise ValueError("package contains duplicate task IDs")
    task_refs = set()
    for task in tasks:
        refs = [item.get("src_rel_path") for item in task["images"]]
        if len(refs) != len(set(refs)) or not set(refs) <= images:
            raise ValueError(f"invalid task refs in {task.get('id')}")
        task_refs.update(refs)
    row_refs = [row.get("src_rel_path") for row in rows]
    if len(row_refs) != len(set(row_refs)) or set(row_refs) != images:
        raise ValueError("manifest rows do not exactly match package images")
    return {
        "bytes": path.stat().st_size,
        "entries": len(members),
        "images": len(images),
        "tasks": len(tasks),
        "task_image_refs": sum(len(task["images"]) for task in tasks),
        "manifest_rows": len(rows),
        "missing_task_images": len(task_refs - images),
    }


def build(source_path: Path, output_path: Path, progress_path: Path, target: int) -> dict:
    tasks_doc, manifest_doc, tasks, rows, image_infos = load_source(source_path)
    processed_ids = read_progress(progress_path)
    selected_tasks = []
    selected_images: set[str] = set()
    selected_bytes = 0
    for task in tasks:
        task_id = str(task["id"])
        if task_id in processed_ids:
            continue
        refs = [item["src_rel_path"] for item in task["images"]]
        new_bytes = sum(image_infos[ref].file_size for ref in set(refs) - selected_images)
        if selected_tasks and selected_bytes + new_bytes > target:
            break
        selected_tasks.append(task)
        selected_images.update(refs)
        selected_bytes += new_bytes
    if not selected_tasks:
        raise ValueError("no unprocessed task fits in the requested package")

    selected_rows = [row for row in rows if row.get("src_rel_path") in selected_images]
    tasks_out = dict(tasks_doc)
    tasks_out["tasks"] = selected_tasks
    manifest_out = dict(manifest_doc)
    manifest_out["rows"] = selected_rows
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".partial")
    if temporary.exists():
        temporary.unlink()
    started = time.time()
    copied = 0
    with zipfile.ZipFile(source_path, "r") as source, zipfile.ZipFile(
        temporary, "w", compression=zipfile.ZIP_STORED, allowZip64=False
    ) as target_archive:
        target_archive.writestr(
            "tasks.json",
            json.dumps(tasks_out, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )
        target_archive.writestr(
            "manifest.json",
            json.dumps(manifest_out, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )
        for name in sorted(selected_images):
            target_archive.writestr(name, source.read(image_infos[name]))
            copied += image_infos[name].file_size
            if copied and copied % (256 * 1024 * 1024) < image_infos[name].file_size:
                elapsed = max(time.time() - started, 0.001)
                print(
                    f"copied={copied / 1e9:.2f}GB speed={copied / elapsed / 1e6:.1f}MB/s",
                    flush=True,
                )
    os.replace(temporary, output_path)
    result = validate(output_path)
    if result["bytes"] >= 2_000_000_000:
        raise ValueError(f"package is not below 2GB: {result['bytes']}")
    result["planned_image_bytes"] = selected_bytes
    result["processed_task_ids"] = len(selected_tasks)
    write_progress(
        progress_path,
        processed_ids | {str(task["id"]) for task in selected_tasks},
        result | {"output": str(output_path)},
    )
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--target", type=int, default=DEFAULT_TARGET)
    args = parser.parse_args()
    build(args.source, args.output, args.progress, args.target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
