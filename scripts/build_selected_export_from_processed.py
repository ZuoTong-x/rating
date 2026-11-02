#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import json
import os
import posixpath
import shutil
import sys
import zipfile
from collections import defaultdict
from pathlib import Path


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
CRITERIA = {
    "overall", "creativity", "mood", "composition", "color", "lighting",
    "realism", "detail", "promptAlignment", "textCorrectness",
    "anatomyNormality", "informationClarity", "designQuality", "typography",
}


def clean(value: object) -> str:
    return str(value or "").replace("\\", "/").strip()


def name_of(value: object) -> str:
    return posixpath.basename(clean(value)).lower()


def is_image(name: str) -> bool:
    return Path(name).suffix.lower() in IMAGE_SUFFIXES


def task_reference(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("src_rel_path", "originalPath", "path", "filename", "image"):
            if value.get(key):
                return str(value[key])
    return ""


def compact_manifest_row(record: dict, destination: str) -> dict:
    source_row = record["manifest_row"] or {}
    catalog = source_row.get("catalog_row") or source_row
    result = {
        "src_rel_path": destination,
        "dest_rel_path": destination,
        "image_filename": posixpath.basename(destination),
        "image_path": destination,
    }
    field_map = {
        "src_abs_path": ("src_abs_path", "image_path"),
        "source": ("source",),
        "source_category": ("source_category", "source_category_label"),
        "source_dataset": ("source_dataset",),
        "source_task_set": ("source_task_set",),
        "image_id": ("image_id",),
        "content_sha256": ("content_sha256",),
        "metadata_source": ("metadata_source",),
        "is_journeydb": ("is_journeydb",),
    }
    for output_key, input_keys in field_map.items():
        for input_key in input_keys:
            value = catalog.get(input_key)
            if value is not None and value != "":
                result[output_key] = value
                break
    prompt = catalog.get("actual_input_prompt") or catalog.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        result["prompt"] = prompt.strip()
    return result


def manifest_values(row: dict) -> list[str]:
    catalog = row.get("catalog_row") or {}
    values = [
        row.get("src_abs_path"), row.get("src_rel_path"), row.get("dest_rel_path"),
        row.get("image_filename"), row.get("image_path"), row.get("filename"), row.get("path"),
        catalog.get("task_image_path"), catalog.get("image_path"),
    ]
    return [clean(value) for value in values if clean(value)]


def manifest_member_name(row: dict) -> str:
    for value in (
        row.get("dest_rel_path"), row.get("src_rel_path"), row.get("image_filename"),
        row.get("image_path"), row.get("filename"), row.get("path"),
    ):
        result = name_of(value)
        if result:
            return result
    return ""


def load_tasks(path: Path) -> list[dict]:
    document = json.loads(path.read_text(encoding="utf-8"))
    tasks = document.get("tasks") if isinstance(document, dict) else None
    if not isinstance(tasks, list):
        raise RuntimeError("tasks.json must contain a tasks array")
    return tasks


def add_record(
    record: dict,
    by_full_path: dict[str, list[dict]],
    by_filename: dict[str, list[dict]],
    by_manifest_filename: dict[str, list[dict]],
) -> None:
    by_filename[record["member_name"]].append(record)
    for value in manifest_values(record["manifest_row"] or {}):
        by_full_path[value].append(record)
        by_manifest_filename[name_of(value)].append(record)


def build_processed_index(
    processed: Path,
    source_zip: Path | None = None,
) -> tuple[dict[str, list[dict]], dict[str, list[dict]], dict[str, list[dict]], dict]:
    by_full_path: dict[str, list[dict]] = defaultdict(list)
    by_filename: dict[str, list[dict]] = defaultdict(list)
    by_manifest_filename: dict[str, list[dict]] = defaultdict(list)
    summary = {"archives": 0, "archive_images": 0, "manifest_rows": 0, "ignored_archives": []}

    for archive_path in sorted(processed.glob("*.zip")):
        try:
            with zipfile.ZipFile(archive_path) as archive:
                image_members = [
                    info for info in archive.infolist()
                    if not info.is_dir() and is_image(info.filename)
                ]
                if not image_members:
                    continue
                summary["archives"] += 1
                summary["archive_images"] += len(image_members)
                members_by_name: dict[str, list[zipfile.ZipInfo]] = defaultdict(list)
                for info in image_members:
                    members_by_name[name_of(info.filename)].append(info)

                manifest_rows = []
                try:
                    manifest = json.loads(archive.read("manifest.json"))
                    if isinstance(manifest, dict) and isinstance(manifest.get("rows"), list):
                        manifest_rows = manifest["rows"]
                except KeyError:
                    pass
                except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                    summary["ignored_archives"].append(f"{archive_path.name}: bad manifest ({exc})")

                row_by_member: dict[str, dict] = {}
                for row in manifest_rows:
                    if not isinstance(row, dict):
                        continue
                    member_name = manifest_member_name(row)
                    if member_name and len(members_by_name.get(member_name, [])) == 1:
                        row_by_member[member_name] = row
                summary["manifest_rows"] += len(manifest_rows)

                for info in image_members:
                    member_name = name_of(info.filename)
                    record = {
                        "archive": str(archive_path),
                        "archive_name": archive_path.name,
                        "member": info.filename,
                        "member_name": member_name,
                        "size": int(info.file_size),
                        "manifest_row": row_by_member.get(member_name),
                    }
                    add_record(record, by_full_path, by_filename, by_manifest_filename)
        except zipfile.BadZipFile as exc:
            summary["ignored_archives"].append(f"{archive_path.name}: bad zip ({exc})")

    if source_zip:
        try:
            with zipfile.ZipFile(source_zip) as archive:
                manifest_name = next((
                    info.filename for info in archive.infolist()
                    if not info.is_dir() and info.filename.endswith("/manifest.json")
                ), None)
                if not manifest_name:
                    raise RuntimeError("missing source manifest.json")
                document = json.loads(archive.read(manifest_name))
                source_rows = document.get("images", []) if isinstance(document, dict) else []
                rows_by_name: dict[str, list[dict]] = defaultdict(list)
                for row in source_rows:
                    if isinstance(row, dict) and row.get("image_path"):
                        rows_by_name[name_of(row["image_path"])].append(row)
                source_images = [
                    info for info in archive.infolist()
                    if not info.is_dir() and is_image(info.filename)
                ]
                summary["source_archive_images"] = len(source_images)
                summary["source_manifest_rows"] = len(source_rows)
                for info in source_images:
                    member_name = name_of(info.filename)
                    raw_name = member_name.split("_", 1)[1] if "_" in member_name else member_name
                    matching_rows = rows_by_name.get(raw_name, [])
                    if len(matching_rows) != 1:
                        continue
                    source_row = matching_rows[0]
                    record = {
                        "archive": str(source_zip),
                        "archive_name": source_zip.name,
                        "member": info.filename,
                        "member_name": member_name,
                        "size": int(info.file_size),
                        "manifest_row": {
                            "src_abs_path": source_row.get("image_path"),
                            "source": source_row.get("source"),
                            "source_category": source_row.get("source_category"),
                            "is_journeydb": source_row.get("is_journeydb"),
                            "metadata_source": source_row.get("metadata_source"),
                            "catalog_row": source_row,
                        },
                    }
                    add_record(record, by_full_path, by_filename, by_manifest_filename)
        except (OSError, RuntimeError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
            summary["ignored_archives"].append(f"{source_zip.name}: bad source ZIP ({exc})")

    return by_full_path, by_filename, by_manifest_filename, summary


def choose_record(
    reference: str,
    by_full_path: dict[str, list[dict]],
    by_filename: dict[str, list[dict]],
    by_manifest_filename: dict[str, list[dict]],
) -> tuple[dict | None, int]:
    exact = by_full_path.get(clean(reference), [])
    candidates = exact or by_manifest_filename.get(name_of(reference), []) or by_filename.get(name_of(reference), [])
    unique_candidates = {}
    for candidate in candidates:
        unique_candidates[(candidate["archive"], candidate["member"])] = candidate
    candidates = list(unique_candidates.values())
    if not candidates:
        return None, 0
    # Reimports can preserve the exact same source image in multiple archives.
    # Select a deterministic member while recording the ambiguity count.
    candidates = sorted(candidates, key=lambda item: (item["archive_name"], item["member"]))
    return candidates[0], len(candidates)


def prepare(
    tasks: list[dict],
    by_full_path: dict[str, list[dict]],
    by_filename: dict[str, list[dict]],
    by_manifest_filename: dict[str, list[dict]],
) -> dict:
    source_ids = set()
    task_groups = set()
    selected_records: dict[tuple[str, str], dict] = {}
    prepared_tasks = []
    failures = []
    duplicate_image_refs_removed = 0
    duplicate_task_groups_removed = 0
    ambiguous_reference_count = 0

    for index, raw_task in enumerate(tasks):
        task_id = str(raw_task.get("id") or "").strip() if isinstance(raw_task, dict) else ""
        criterion = str(raw_task.get("criterion") or "").strip() if isinstance(raw_task, dict) else ""
        if not task_id or len(task_id) > 160 or task_id in source_ids:
            failures.append({"index": index, "id": task_id or f"task-{index + 1}", "reason": "invalid or duplicate id"})
            continue
        source_ids.add(task_id)
        images = raw_task.get("images") if isinstance(raw_task, dict) else None
        if criterion not in CRITERIA or not isinstance(images, list) or not 1 <= len(images) <= 5:
            failures.append({"index": index, "id": task_id, "reason": "invalid criterion or image count"})
            continue

        seen = set()
        task_records = []
        missing = None
        for raw_item in images:
            reference = task_reference(raw_item)
            record, candidate_count = choose_record(reference, by_full_path, by_filename, by_manifest_filename)
            if record is None:
                missing = reference or "empty image reference"
                break
            if candidate_count > 1:
                ambiguous_reference_count += 1
            key = (record["archive"], record["member"])
            if key in seen:
                duplicate_image_refs_removed += 1
                continue
            seen.add(key)
            selected_records[key] = record
            task_records.append(record)
        if missing:
            failures.append({"index": index, "id": task_id, "reason": f"not found in processed ZIPs: {missing}"})
            continue
        if not task_records:
            failures.append({"index": index, "id": task_id, "reason": "no images remain after duplicate removal"})
            continue

        group_members = sorted(
            f"{item['archive_name']}:{item['member']}" for item in task_records
        )
        group_key = f"{criterion}|{'|'.join(group_members)}"
        if group_key in task_groups:
            duplicate_task_groups_removed += 1
            continue
        task_groups.add(group_key)
        prepared_tasks.append({"id": task_id, "criterion": criterion, "records": task_records})

    ordered_records = sorted(selected_records.values(), key=lambda item: (item["archive_name"], item["member"]))
    destinations = {}
    for index, record in enumerate(ordered_records, start=1):
        ext = Path(record["member"]).suffix.lower()
        destinations[(record["archive"], record["member"])] = f"images/{index:06d}{ext}"

    task_output = []
    for task in prepared_tasks:
        task_output.append({
            "id": task["id"],
            "criterion": task["criterion"],
            "images": [
                {"src_rel_path": destinations[(record["archive"], record["member"])]}
                for record in task["records"]
            ],
        })

    rows = []
    for record in ordered_records:
        destination = destinations[(record["archive"], record["member"])]
        rows.append(compact_manifest_row(record, destination))

    task_document = {"version": 1, "tasks": task_output}
    manifest_document = {"version": 1, "rows": rows}
    task_json = json.dumps(task_document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    manifest_json = json.dumps(manifest_document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    return {
        "tasks": task_output,
        "rows": rows,
        "task_json": task_json,
        "manifest_json": manifest_json,
        "records": ordered_records,
        "failures": failures,
        "duplicate_image_refs_removed": duplicate_image_refs_removed,
        "duplicate_task_groups_removed": duplicate_task_groups_removed,
        "ambiguous_reference_count": ambiguous_reference_count,
        "image_bytes": sum(record["size"] for record in ordered_records),
    }


def build(output: Path, plan: dict) -> None:
    if plan["failures"]:
        raise RuntimeError(f"Refusing to build with {len(plan['failures'])} missing/invalid tasks")
    max_json_bytes = 64 * 1024 * 1024
    if len(plan["task_json"]) > max_json_bytes:
        raise RuntimeError("tasks.json exceeds the server 64MB limit")
    if len(plan["manifest_json"]) > max_json_bytes:
        raise RuntimeError("manifest.json exceeds the server 64MB limit")
    if output.exists():
        raise RuntimeError(f"Refusing to overwrite existing output {output}")
    partial = output.with_suffix(output.suffix + ".partial")
    if partial.exists():
        raise RuntimeError(f"Partial output already exists {partial}")
    output.parent.mkdir(parents=True, exist_ok=True)
    destinations = {
        (record["archive"], record["member"]): row["src_rel_path"]
        for record, row in zip(plan["records"], plan["rows"], strict=True)
    }
    by_archive: dict[str, list[dict]] = defaultdict(list)
    for record in plan["records"]:
        by_archive[record["archive"]].append(record)

    try:
        with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as target:
            copied = 0
            for archive_name, records in by_archive.items():
                with zipfile.ZipFile(archive_name) as source:
                    for record in records:
                        destination = destinations[(record["archive"], record["member"])]
                        with source.open(record["member"]) as stream, target.open(destination, "w", force_zip64=True) as sink:
                            shutil.copyfileobj(stream, sink, length=1024 * 1024)
                        copied += 1
                        if copied % 500 == 0 or copied == len(plan["records"]):
                            print(f"images={copied}/{len(plan['records'])}", flush=True)
            target.writestr("tasks.json", plan["task_json"])
            target.writestr("manifest.json", plan["manifest_json"])

        with zipfile.ZipFile(partial) as archive:
            bad = archive.testzip()
            if bad:
                raise RuntimeError(f"Corrupt member {bad}")
            tasks = json.loads(archive.read("tasks.json"))["tasks"]
            rows = json.loads(archive.read("manifest.json"))["rows"]
            image_names = {name for name in archive.namelist() if is_image(name)}
            task_refs = {item["src_rel_path"] for task in tasks for item in task["images"]}
            manifest_refs = {row["src_rel_path"] for row in rows}
            if task_refs - image_names or manifest_refs != image_names:
                raise RuntimeError("Final ZIP references/images/manifest do not match")
        os.replace(partial, output)
    except Exception:
        partial.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--processed", type=Path, required=True)
    parser.add_argument("--source-zip", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()
    if not args.plan_only and not args.output:
        parser.error("--output is required unless --plan-only is used")

    tasks = load_tasks(args.tasks)
    by_full_path, by_filename, by_manifest_filename, index_summary = build_processed_index(
        args.processed, args.source_zip
    )
    plan = prepare(tasks, by_full_path, by_filename, by_manifest_filename)
    result = {
        **index_summary,
        "source_task_count": len(tasks),
        "normalized_task_count": len(plan["tasks"]),
        "image_count": len(plan["records"]),
        "image_bytes": plan["image_bytes"],
        "tasks_json_bytes": len(plan["task_json"]),
        "manifest_json_bytes": len(plan["manifest_json"]),
        "duplicate_image_refs_removed": plan["duplicate_image_refs_removed"],
        "duplicate_task_groups_removed": plan["duplicate_task_groups_removed"],
        "ambiguous_reference_count": plan["ambiguous_reference_count"],
        "failed_task_count": len(plan["failures"]),
        "failure_samples": plan["failures"][:10],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    if args.plan_only:
        return 1 if plan["failures"] else 0

    build(args.output, plan)
    print(json.dumps({"zip": str(args.output), "bytes": args.output.stat().st_size}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
