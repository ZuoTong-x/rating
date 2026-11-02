from __future__ import annotations

import argparse
import json
import shutil
import time
import zipfile
from pathlib import Path


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_progress(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def validate_folder(folder: Path) -> dict:
    tasks = load_json(folder / "tasks.json")
    manifest = load_json(folder / "manifest.json")
    images = {
        p.name for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES
    }
    task_ids = set()
    refs = []
    missing = 0
    duplicate_ids = 0
    duplicate_task_images = 0
    bad_shapes = 0
    for task in tasks.get("tasks", []):
        task_id = task.get("id")
        if task_id in task_ids:
            duplicate_ids += 1
        task_ids.add(task_id)
        items = task.get("images", [])
        if not 1 <= len(items) <= 5:
            bad_shapes += 1
        local = []
        for item in items:
            ref = item if isinstance(item, str) else item.get("src_rel_path")
            refs.append(ref)
            local.append(ref)
            if ref not in images:
                missing += 1
        if len(local) != len(set(local)):
            duplicate_task_images += 1
    manifest_refs = [row.get("src_rel_path") for row in manifest.get("rows", [])]
    missing_manifest = sum(ref not in images for ref in manifest_refs)
    result = {
        "tasks": len(tasks.get("tasks", [])),
        "task_refs": len(refs),
        "unique_task_ids": len(task_ids),
        "duplicate_task_ids": duplicate_ids,
        "bad_task_shapes": bad_shapes,
        "duplicate_images_inside_tasks": duplicate_task_images,
        "missing_task_refs": missing,
        "manifest_rows": len(manifest.get("rows", [])),
        "unique_manifest_refs": len(set(manifest_refs)),
        "missing_manifest_refs": missing_manifest,
        "image_files": len(images),
        "extra_images": len(images - set(manifest_refs)),
    }
    if any(result[key] for key in (
        "duplicate_task_ids", "bad_task_shapes", "duplicate_images_inside_tasks",
        "missing_task_refs", "missing_manifest_refs",
    )):
        raise RuntimeError(f"Folder JSON validation failed: {result}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--folder", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    args = parser.parse_args()

    folder = args.folder
    output = args.output
    partial = output.with_suffix(output.suffix + ".partial")
    before = validate_folder(folder)
    print("JSON_PRECHECK", json.dumps(before, ensure_ascii=False), flush=True)

    progress = {
        "version": 1,
        "status": "running",
        "folder": str(folder),
        "output": str(output),
        "processed_images": 0,
        "processed_bytes": 0,
        "started_at": time.time(),
    }
    completed = set()
    mode = "w"
    if partial.exists():
        mode = "a"
        with zipfile.ZipFile(partial, "r") as existing:
            completed = set(existing.namelist())
        progress["processed_images"] = sum(
            1 for name in completed if Path(name).suffix.lower() in IMAGE_SUFFIXES
        )
    if args.progress.exists():
        old = load_json(args.progress)
        if old.get("status") != "complete":
            progress.update(old)

    images = sorted(
        p for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES
    )
    total_bytes = sum(p.stat().st_size for p in images if p.exists())
    progress["total_images"] = before["image_files"]
    progress["total_bytes"] = total_bytes + progress.get("processed_bytes", 0)
    progress["status"] = "running"
    write_progress(args.progress, progress)

    with zipfile.ZipFile(partial, mode=mode, compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for index, image in enumerate(images, start=1):
            name = image.name
            if name in completed:
                continue
            size = image.stat().st_size
            with image.open("rb") as source, archive.open(name, "w", force_zip64=True) as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
            info = archive.getinfo(name)
            if info.file_size != size:
                raise RuntimeError(f"ZIP entry size mismatch: {name}")
            image.unlink()
            completed.add(name)
            progress["processed_images"] += 1
            progress["processed_bytes"] += size
            if progress["processed_images"] % 250 == 0:
                elapsed = max(time.time() - progress["started_at"], 0.001)
                speed = progress["processed_bytes"] / elapsed
                remaining = max(progress["total_bytes"] - progress["processed_bytes"], 0)
                eta = remaining / speed if speed else 0
                print(
                    f"PROGRESS images={progress['processed_images']}/{before['image_files']} "
                    f"bytes={progress['processed_bytes']} speed={speed / 1_000_000:.2f}MB/s "
                    f"eta={eta / 60:.1f}min",
                    flush=True,
                )
                write_progress(args.progress, progress)

        for json_name in ("tasks.json", "manifest.json"):
            if json_name not in archive.namelist():
                archive.write(folder / json_name, arcname=json_name)

    partial.replace(output)
    with zipfile.ZipFile(output, "r") as archive:
        bad = archive.testzip()
        if bad is not None:
            raise RuntimeError(f"ZIP CRC validation failed: {bad}")
        zipped_tasks = json.loads(archive.read("tasks.json").decode("utf-8"))
        zipped_manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
        names = set(archive.namelist())
        zipped_images = {n for n in names if Path(n).suffix.lower() in IMAGE_SUFFIXES}
        task_refs = {
            item if isinstance(item, str) else item.get("src_rel_path")
            for task in zipped_tasks["tasks"] for item in task["images"]
        }
        manifest_refs = {row["src_rel_path"] for row in zipped_manifest["rows"]}
        final = {
            "zip_bytes": output.stat().st_size,
            "zip_entries": len(names),
            "zip_images": len(zipped_images),
            "tasks": len(zipped_tasks["tasks"]),
            "manifest_rows": len(zipped_manifest["rows"]),
            "missing_task_refs": len(task_refs - zipped_images),
            "missing_manifest_refs": len(manifest_refs - zipped_images),
            "status": "complete",
        }
    progress.update(final)
    write_progress(args.progress, progress)
    print("COMPLETE", json.dumps(final, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
