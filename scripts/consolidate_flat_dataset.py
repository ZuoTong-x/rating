from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import time
import zipfile
from collections import defaultdict
from pathlib import Path


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
CASE_FILE_RE = re.compile(r"^(?P<prefix>.+?)-(?P<number>\d+)(?:-(?P<suffix>.+))?$")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(path)


def clean_path(value: object) -> str:
    return str(value or "").replace("\\", "/").strip()


def normalized(value: object) -> str:
    return clean_path(value).lower().lstrip("./")


def basename(value: object) -> str:
    return Path(clean_path(value)).name.lower()


def case_id_from_filename(name: str) -> str | None:
    match = CASE_FILE_RE.match(Path(name).stem)
    if not match:
        return None
    value = f"{match.group('prefix')}:{match.group('number')}"
    if match.group("suffix"):
        value += f":{match.group('suffix')}"
    return value


def model_key(value: object) -> str:
    key = re.sub(r"[^a-z0-9]+", "", str(value or "").lower())
    aliases = [
        ("gemini31flash", "gemini31flash"),
        ("hunyuanimage3", "hunyuanimage3"),
        ("seedream5pro", "seedream5pro"),
        ("qwenimage2512", "qwenimage2512"),
        ("qwenimage30", "qwenimage30"),
        ("gptimage2", "gptimage2"),
        ("sd35large", "sd35large"),
        ("hidreamo1", "hidreamo1"),
        ("ideogram4", "ideogram4"),
        ("glmimage", "glmimage"),
        ("midjourney", "midjourney"),
        ("u1fast", "u1fast"),
        ("u15", "u15"),
        ("flux2", "flux2"),
        ("flux1", "flux1"),
        ("u1", "u1"),
        ("wan27image", "wan27image"),
    ]
    for alias, canonical in aliases:
        if key == alias or key.startswith(alias):
            return canonical
    if key.startswith("flux2dev"):
        return "flux2"
    if key.startswith("zimage"):
        return "zimage"
    return key


def source_label(root: Path, archive: Path) -> str:
    relative = archive.relative_to(root).parts
    if len(relative) == 1:
        group = "root"
    elif "第二批" in relative:
        group = "batch2"
    elif "第三批" in relative:
        group = "batch3"
    elif "第四批" in relative and "第三和第四批" in relative:
        group = "batch4"
    elif "真正的第四批" in relative:
        group = "real4"
    else:
        group = "source"
    return f"{group}__{archive.stem}"


def is_source_archive(root: Path, path: Path) -> bool:
    if path.suffix.lower() == ".tar":
        return True
    if path.name == "v030_12000_images.zip":
        return True
    return False


def archive_files(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and is_source_archive(root, path)
    )


def scan_archive(root: Path, archive: Path) -> list[dict]:
    label = source_label(root, archive)
    records = []
    if archive.suffix.lower() == ".tar":
        with tarfile.open(archive, mode="r:*") as container:
            for member in container:
                if not member.isfile() or Path(member.name).suffix.lower() not in IMAGE_SUFFIXES:
                    continue
                records.append(
                    {
                        "archive": str(archive),
                        "member": member.name,
                        "size": int(member.size),
                        "case_id": case_id_from_filename(Path(member.name).name),
                        "model": model_key(Path(member.name).parts[0] if Path(member.name).parts else archive.stem),
                        "zip": False,
                        "dest": None,
                    }
                )
    else:
        with zipfile.ZipFile(archive) as container:
            for member in container.infolist():
                if member.is_dir() or Path(member.filename).suffix.lower() not in IMAGE_SUFFIXES:
                    continue
                records.append(
                    {
                        "archive": str(archive),
                        "member": member.filename,
                        "size": int(member.file_size),
                        "case_id": None,
                        "model": "mixed30",
                        "zip": True,
                        "dest": None,
                    }
                )
    for record in records:
        safe_member = re.sub(r"[^A-Za-z0-9._-]+", "_", record["member"].replace("/", "__"))
        record["dest"] = f"{label}__{safe_member}"
    return records


def row_source_values(row: dict) -> list[str]:
    catalog = row.get("catalog_row") or {}
    values = [
        row.get("src_abs_path"),
        row.get("src_rel_path"),
        row.get("dest_rel_path"),
        row.get("image_path"),
        catalog.get("task_image_path"),
        catalog.get("image_path"),
        catalog.get("relative_path"),
        catalog.get("src_rel_path"),
    ]
    return [clean_path(value) for value in values if clean_path(value)]


def row_source_set(row: dict) -> str:
    catalog = row.get("catalog_row") or {}
    return str(
        catalog.get("source_task_set")
        or row.get("source_task_set")
        or row.get("source")
        or ""
    )


def row_case_id(row: dict) -> str:
    catalog = row.get("catalog_row") or {}
    return str(catalog.get("source_case_id") or row.get("case_id") or "")


def row_model(row: dict) -> str:
    catalog = row.get("catalog_row") or {}
    return model_key(
        catalog.get("model_name")
        or catalog.get("model_id")
        or row.get("model")
        or ""
    )


def make_indexes(records: list[dict]):
    mixed_by_name = defaultdict(list)
    annot_by_case_model = defaultdict(list)
    for record in records:
        name = basename(record["member"])
        mixed_by_name[name].append(record)
        if record["case_id"]:
            annot_by_case_model[(record["case_id"], record["model"])].append(record)
    special_by_model = defaultdict(list)
    for record in records:
        if record.get("special_batch"):
            special_by_model[record["model"]].append(record)
    return mixed_by_name, annot_by_case_model, special_by_model


def choose_row_record(row: dict, mixed_by_name, annot_by_case_model) -> dict | None:
    if row_source_set(row) == "mixed30_93000":
        candidates = mixed_by_name.get(basename(row.get("src_rel_path")), [])
        return candidates[0] if len(candidates) == 1 else None
    candidates = annot_by_case_model.get((row_case_id(row), row_model(row)), [])
    if len(candidates) == 1:
        return candidates[0]
    if candidates:
        return sorted(candidates, key=lambda item: (item["archive"], item["member"]))[0]
    return None


def task_row_lookup(rows: list[dict]):
    exact = defaultdict(list)
    names = defaultdict(list)
    for row in rows:
        for value in row_source_values(row):
            exact[normalized(value)].append(row)
            names[basename(value)].append(row)
    return exact, names


def resolve_task_row(reference: str, exact, names) -> dict | None:
    candidates = exact.get(normalized(reference), [])
    if len(candidates) == 1:
        return candidates[0]
    if candidates:
        return candidates[0]
    candidates = names.get(basename(reference), [])
    if len(candidates) == 1:
        return candidates[0]
    return None


def build_plan(root: Path, tasks_path: Path, manifest_path: Path):
    tasks_doc = load_json(tasks_path)
    manifest_doc = load_json(manifest_path)
    tasks = tasks_doc.get("tasks", [])
    rows = manifest_doc.get("rows", [])
    archives = archive_files(root)
    records = []
    archive_summaries = []
    for archive in archives:
        current = scan_archive(root, archive)
        records.extend(current)
        archive_summaries.append(
            {
                "archive": str(archive),
                "bytes": archive.stat().st_size,
                "images": len(current),
                "image_bytes": sum(item["size"] for item in current),
            }
        )

    mixed_by_name, annot_by_case_model, special_by_model = make_indexes(records)
    special_assignments = {}
    for model, special_records in special_by_model.items():
        special_rows = [
            row
            for row in rows
            if row_source_set(row) == "annot_18000_9metrics"
            and row_model(row) == model
            and (row_case_id(row), model) not in annot_by_case_model
        ]
        special_rows.sort(key=lambda row: (row.get("flat_index", 0), id(row)))
        if len(special_rows) != len(special_records):
            raise RuntimeError(
                f"Special batch mapping count mismatch for {model}: "
                f"manifest={len(special_rows)} archive={len(special_records)}"
            )
        for row, record in zip(special_rows, special_records):
            special_assignments[id(row)] = record
    row_records = {}
    missing_rows = []
    for index, row in enumerate(rows):
        record = special_assignments.get(id(row))
        if record is None:
            record = choose_row_record(row, mixed_by_name, annot_by_case_model)
        if record is None:
            missing_rows.append(index)
        else:
            row_records[index] = record

    exact, names = task_row_lookup(rows)
    row_indexes_by_id = {id(row): index for index, row in enumerate(rows)}
    missing_tasks = []
    task_row_indexes = []
    for task_index, task in enumerate(tasks):
        indexes = []
        for reference in task.get("images", []):
            row = resolve_task_row(str(reference), exact, names)
            if row is None:
                indexes.append(None)
                continue
            indexes.append(row_indexes_by_id.get(id(row)))
        if any(index is None or index not in row_records for index in indexes):
            missing_tasks.append(task_index)
        task_row_indexes.append(indexes)

    return {
        "tasks_doc": tasks_doc,
        "manifest_doc": manifest_doc,
        "tasks": tasks,
        "rows": rows,
        "archives": archives,
        "records": records,
        "row_records": row_records,
        "task_row_indexes": task_row_indexes,
        "missing_rows": missing_rows,
        "missing_tasks": missing_tasks,
        "archive_summaries": archive_summaries,
    }


def print_plan(plan: dict, output_dir: Path) -> None:
    unique_records = {id(record): record for record in plan["row_records"].values()}
    missing_source_counts = defaultdict(int)
    missing_model_counts = defaultdict(int)
    missing_samples = []
    for index in plan["missing_rows"]:
        row = plan["rows"][index]
        missing_source_counts[row_source_set(row)] += 1
        missing_model_counts[row_model(row)] += 1
        if len(missing_samples) < 10:
            missing_samples.append(
                {
                    "index": index,
                    "source": row_source_set(row),
                    "case_id": row_case_id(row),
                    "model": row_model(row),
                    "src_abs_path": row.get("src_abs_path"),
                    "src_rel_path": row.get("src_rel_path"),
                    "task_image_path": (row.get("catalog_row") or {}).get("task_image_path"),
                }
            )
    print(
        json.dumps(
            {
                "output_dir": str(output_dir),
                "archive_count": len(plan["archives"]),
                "archive_image_count": len(plan["records"]),
                "archive_image_bytes": sum(item["size"] for item in plan["records"]),
                "task_count": len(plan["tasks"]),
                "manifest_row_count": len(plan["rows"]),
                "mapped_manifest_rows": len(plan["row_records"]),
                "mapped_unique_task_images": len(unique_records),
                "missing_manifest_rows": len(plan["missing_rows"]),
                "missing_tasks": len(plan["missing_tasks"]),
                "missing_rows_by_source": dict(missing_source_counts),
                "missing_rows_by_model": dict(missing_model_counts),
                "missing_row_samples": missing_samples,
                "archive_summaries": plan["archive_summaries"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def consolidate(plan: dict, output_dir: Path, delete_source: bool) -> None:
    if plan["missing_rows"] or plan["missing_tasks"]:
        raise RuntimeError(
            f"Refusing to modify files: missing manifest rows={len(plan['missing_rows'])}, "
            f"missing tasks={len(plan['missing_tasks'])}"
        )
    output_dir.mkdir(parents=True, exist_ok=True)
    image_dir = output_dir
    by_record = {id(record): record for record in plan["records"]}
    expected_destinations = {record["dest"] for record in plan["records"]}
    progress_path = output_dir / "consolidation_progress.json"
    progress = {
        "version": 1,
        "status": "running",
        "source_tasks": str(plan["tasks_doc"].get("source_tasks", "")),
        "source_archives": [str(path) for path in plan["archives"]],
        "processed_archives": [],
        "processed_image_count": 0,
        "expected_image_count": len(plan["records"]),
    }
    write_json(progress_path, progress)

    processed_records = set()
    for archive in plan["archives"]:
        archive_records = [record for record in plan["records"] if record["archive"] == str(archive)]
        for record in archive_records:
            destination = image_dir / record["dest"]
            if destination.exists():
                if destination.stat().st_size != record["size"]:
                    raise RuntimeError(f"Existing destination size mismatch: {destination}")
                processed_records.add(id(record))
                continue
            temporary = destination.with_suffix(destination.suffix + ".partial")
            if temporary.exists():
                temporary.unlink()
            if record["zip"]:
                with zipfile.ZipFile(record["archive"]) as container:
                    with container.open(record["member"]) as source, temporary.open("wb") as target:
                        shutil.copyfileobj(source, target, length=1024 * 1024)
            else:
                with tarfile.open(record["archive"], mode="r:*") as container:
                    source = container.extractfile(record["member"])
                    if source is None:
                        raise RuntimeError(f"Cannot read {record['member']}")
                    with source, temporary.open("wb") as target:
                        shutil.copyfileobj(source, target, length=1024 * 1024)
            if temporary.stat().st_size != record["size"]:
                temporary.unlink(missing_ok=True)
                raise RuntimeError(f"Extracted size mismatch: {record['member']}")
            temporary.replace(destination)
            processed_records.add(id(record))
        progress["processed_archives"].append(str(archive))
        progress["processed_image_count"] = len(processed_records)
        write_json(progress_path, progress)
        if delete_source:
            archive.unlink()
        print(
            f"ARCHIVE_DONE {archive.name} images={len(archive_records)} "
            f"processed={len(processed_records)}/{len(plan['records'])}",
            flush=True,
        )

    if processed_records != set(by_record):
        raise RuntimeError("Not all source images were extracted")

    row_destinations = {
        index: record["dest"] for index, record in plan["row_records"].items()
    }
    output_tasks = {"version": 1, "tasks": []}
    for task, indexes in zip(plan["tasks"], plan["task_row_indexes"]):
        output_tasks["tasks"].append(
            {
                "id": str(task["id"]),
                "criterion": str(task["criterion"]),
                "images": [{"src_rel_path": row_destinations[index]} for index in indexes],
            }
        )

    row_for_record = {}
    for index, row in enumerate(plan["rows"]):
        record = plan["row_records"][index]
        row_for_record.setdefault(id(record), row)
    output_rows = []
    for record in plan["records"]:
        row = row_for_record.get(id(record))
        rewritten = copy.deepcopy(row) if row is not None else {}
        destination = row_destinations[index]
        destination = record["dest"]
        rewritten.update(
            {
                "src_rel_path": destination,
                "dest_rel_path": destination,
                "image_filename": Path(destination).name,
                "image_path": destination,
            }
        )
        output_rows.append(rewritten)
    output_manifest = {"version": 1, "rows": output_rows}
    write_json(output_dir / "tasks.json", output_tasks)
    write_json(output_dir / "manifest.json", output_manifest)

    final_progress = {
        **progress,
        "status": "complete",
        "processed_image_count": len(processed_records),
        "task_count": len(output_tasks["tasks"]),
        "manifest_row_count": len(output_rows),
        "expected_destinations": len(expected_destinations),
        "output_dir": str(output_dir),
    }
    write_json(progress_path, final_progress)
    print(
        f"COMPLETE images={len(processed_records)} tasks={len(output_tasks['tasks'])} "
        f"rows={len(output_rows)} output={output_dir}",
        flush=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--delete-source", action="store_true")
    args = parser.parse_args()
    plan = build_plan(args.root, args.tasks, args.manifest)
    print_plan(plan, args.output_dir)
    if args.dry_run:
        return 0
    if not args.delete_source:
        print("REFUSING_TO_RUN_WITHOUT_DELETE_SOURCE", file=sys.stderr)
        print("Use --delete-source because the source archives must be replaced by the flat output.", file=sys.stderr)
        return 2
    consolidate(plan, args.output_dir, delete_source=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
