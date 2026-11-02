from __future__ import annotations

import argparse
import copy
import json
import shutil
import sys
import tarfile
import time
import zipfile
from collections import defaultdict
from pathlib import Path

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def dump(path: Path, value) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def is_image(name: str) -> bool:
    return Path(name).suffix.lower() in IMAGE_SUFFIXES


def output_json(plan: dict, image_dir: Path) -> tuple[dict, dict]:
    records = plan["records"]
    row_record = {int(k): v for k, v in plan["row_record"].items()}
    record_dest = {i: records[i]["dest"] for i in range(len(records))}

    tasks = []
    for task_index, task in enumerate(plan["tasks"]):
        tasks.append({
            "id": str(task["id"]),
            "criterion": str(task["criterion"]),
            "images": [{"src_rel_path": record_dest[row_record[row_index]]}
                       for row_index in plan["task_rows"][task_index]],
        })

    canonical = {}
    for row_index, record_index in row_record.items():
        canonical.setdefault(record_index, row_index)
    manifest_rows = []
    for record_index, record in enumerate(records):
        row_index = canonical.get(record_index)
        if row_index is None:
            row = {
                "source": "unreferenced_archive_image",
                "src_abs_path": record["member"],
                "catalog_row": {
                    "source_archive": record["archive"],
                    "source_member": record["member"],
                },
            }
        else:
            row = copy.deepcopy(plan["rows"][row_index])
        destination = record_dest[record_index]
        row.update({
            "src_rel_path": destination,
            "dest_rel_path": destination,
            "image_filename": destination,
            "image_path": destination,
        })
        manifest_rows.append(row)
    return {"version": 1, "tasks": tasks}, {"version": 1, "rows": manifest_rows}


def extract_archive(archive_path: Path, records: list[dict], image_dir: Path, progress: dict) -> int:
    by_member = {record["member"]: record for record in records}
    extracted = 0
    if archive_path.suffix.lower() == ".tar":
        container = tarfile.open(archive_path, "r:*")
        iterator = ((member.name, member) for member in container
                    if member.isfile() and is_image(member.name))
    else:
        container = zipfile.ZipFile(archive_path)
        iterator = ((member.filename, member) for member in container.infolist()
                    if not member.is_dir() and is_image(member.filename))
    try:
        for member_name, member in iterator:
            record = by_member.get(member_name)
            if record is None:
                continue
            destination = image_dir / record["dest"]
            if destination.exists():
                if destination.stat().st_size != record["size"]:
                    raise RuntimeError(f"Existing image size mismatch: {destination}")
                extracted += 1
                continue
            partial = destination.with_suffix(destination.suffix + ".partial")
            partial.unlink(missing_ok=True)
            source = container.extractfile(member) if isinstance(container, tarfile.TarFile) else container.open(member)
            if source is None:
                raise RuntimeError(f"Cannot read {archive_path}:{member_name}")
            try:
                with source, partial.open("wb") as target:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
            finally:
                source.close()
            if partial.stat().st_size != record["size"]:
                partial.unlink(missing_ok=True)
                raise RuntimeError(f"Extracted size mismatch: {archive_path}:{member_name}")
            partial.replace(destination)
            extracted += 1
            progress["processed_images"] += 1
            if progress["processed_images"] % 250 == 0:
                elapsed = max(time.time() - progress["started_at"], 0.001)
                speed = progress["processed_bytes"] / elapsed
                remaining = progress["total_bytes"] - progress["processed_bytes"]
                eta = remaining / speed if speed else 0
                print(
                    f"PROGRESS images={progress['processed_images']}/{progress['total_images']} "
                    f"bytes={progress['processed_bytes']}/{progress['total_bytes']} "
                    f"speed={speed / 1_000_000:.2f}MB/s eta={eta / 60:.1f}min",
                    flush=True,
                )
            progress["processed_bytes"] += record["size"]
    finally:
        container.close()
    if extracted != len(records):
        raise RuntimeError(f"Archive image count mismatch {archive_path}: {extracted}/{len(records)}")
    return extracted


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--delete-source", action="store_true")
    args = parser.parse_args()
    plan = load(args.plan)
    root = Path(plan["root"])
    image_dir = args.output_dir
    image_dir.mkdir(parents=True, exist_ok=True)
    records_by_archive = defaultdict(list)
    for record in plan["records"]:
        records_by_archive[record["archive"]].append(record)
    archives = list(records_by_archive)
    progress = load(args.progress) if args.progress.exists() else {
        "version": 1, "status": "running", "processed_archives": [],
        "processed_images": 0, "processed_bytes": 0,
        "total_images": len(plan["records"]),
        "total_bytes": sum(r["size"] for r in plan["records"]),
        "started_at": time.time(), "output_dir": str(image_dir),
    }
    completed = set(progress.get("processed_archives", []))
    for archive_no, archive_string in enumerate(archives, start=1):
        archive = Path(archive_string)
        if archive_string in completed:
            continue
        if not archive.exists():
            raise RuntimeError(f"Source archive missing before completion: {archive}")
        count = extract_archive(archive, records_by_archive[archive_string], image_dir, progress)
        progress["processed_archives"].append(archive_string)
        dump(args.progress, progress)
        if args.delete_source:
            archive.unlink()
        print(f"ARCHIVE_DONE {archive_no}/{len(archives)} {archive.name} images={count}", flush=True)

    missing = [r["dest"] for r in plan["records"] if not (image_dir / r["dest"]).is_file()]
    if missing:
        raise RuntimeError(f"Missing flattened images: {len(missing)} sample={missing[:3]}")
    tasks_doc, manifest_doc = output_json(plan, image_dir)
    dump(image_dir / "tasks.json", tasks_doc)
    dump(image_dir / "manifest.json", manifest_doc)
    progress.update({
        "status": "complete", "completed_at": time.time(),
        "output_tasks": len(tasks_doc["tasks"]),
        "output_manifest_rows": len(manifest_doc["rows"]),
    })
    dump(args.progress, progress)
    print(json.dumps({
        "status": "complete", "images": len(plan["records"]),
        "tasks": len(tasks_doc["tasks"]), "manifest_rows": len(manifest_doc["rows"]),
        "output_dir": str(image_dir),
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
