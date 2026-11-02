from __future__ import annotations

import argparse
import copy
import json
import re
import shutil
import tarfile
import zipfile
from collections import defaultdict
from pathlib import Path


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
CASE_FILE_RE = re.compile(r"^(?P<prefix>.+?)-(?P<number>\d+)(?:-(?P<suffix>.+))?$")


def case_id_from_filename(name: str) -> str | None:
    match = CASE_FILE_RE.match(Path(name).stem)
    if not match:
        return None
    value = f"{match.group('prefix')}:{match.group('number')}"
    if match.group("suffix"):
        value += f":{match.group('suffix')}"
    return value


def archive_root(member_name: str) -> str:
    return member_name.replace("\\", "/").split("/", 1)[0]


def model_archive_root(model: str) -> str | None:
    key = re.sub(r"[^a-z0-9]+", "", model.lower())
    aliases = {
        "flux1": "flux.1",
        "flux2": "flux.2",
        "gemini31flash": "gemini-3.1-flash",
        "glmimage": "glm-image",
        "gptimage2": "gpt-image-2",
        "hidreamo1": "hidream-o1",
        "hunyuanimage3": "hunyuan-image-3",
        "ideogram4": "ideogram-4",
        "midjourney": "midjourney",
        "qwenimage2512": "qwen-image-2512",
        "qwenimage30": "qwen-image-3.0",
        "sd35large": "sd3.5-large",
        "seedream5pro": "seedream-5-pro",
        "u15": "u1.5",
        "u1fast": "u1-fast",
        "u1": "u1",
        "wan27image": "wan-2.7-image",
    }
    return aliases.get(key)


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def cases_from_manifest_rows(manifest: dict) -> list[dict]:
    grouped = defaultdict(list)
    for row in manifest.get("rows", []):
        catalog = row.get("catalog_row") or {}
        if catalog.get("source_task_set") != "annot_18000_9metrics":
            continue
        case_id = catalog.get("source_case_id") or row.get("case_id")
        if case_id:
            grouped[str(case_id)].append(row)

    cases = []
    for case_id, rows in grouped.items():
        rows.sort(key=lambda row: (row.get("catalog_row") or {}).get("group_position", 0))
        first_catalog = rows[0].get("catalog_row") or {}
        images = []
        for row in rows:
            catalog = row.get("catalog_row") or {}
            source_path = catalog.get("task_image_path") or row.get("src_abs_path")
            images.append(
                {
                    "model": catalog.get("model_name") or catalog.get("model_id") or "",
                    "image_path": source_path,
                    "source_image_path": row.get("src_abs_path") or source_path,
                    "_manifest_row": row,
                }
            )
        cases.append(
            {
                "case_index": min(row.get("flat_index", 0) for row in rows),
                "case_id": case_id,
                "prompt_id": case_id,
                "source_dataset": "manifest_8k_5model_stratified",
                "category": first_catalog.get("source_category"),
                "category_zh": first_catalog.get("source_category_label"),
                "prompt": first_catalog.get("prompt"),
                "images": images,
                "label_match": first_catalog.get("label_match"),
                "label": first_catalog.get("label"),
                "eligible_criteria": first_catalog.get("criteria", []),
                "task_ids": first_catalog.get("task_ids", {}),
            }
        )
    return cases


def write_json_atomic(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(path)


def build_archive_index(input_dir: Path):
    index = defaultdict(dict)
    archives = sorted(
        archive
        for archive in input_dir.glob("*.tar")
        if "_20260829_" not in archive.name
    )
    for archive_path in archives:
        with tarfile.open(archive_path, mode="r:*") as archive:
            for member in archive:
                if not member.isfile() or Path(member.name).suffix.lower() not in IMAGE_SUFFIXES:
                    continue
                case_id = case_id_from_filename(Path(member.name).name)
                if not case_id:
                    continue
                index[case_id][archive_root(member.name)] = {
                    "archive": archive_path,
                    "member": member.name,
                    "size": member.size,
                }
    return index, archives


def package_mapping(case: dict, members: dict[str, dict]):
    by_source = {}
    used_members = set()
    for image in case.get("images", []):
        source = image["image_path"]
        root = model_archive_root(image.get("model", ""))
        if root in members:
            by_source[source] = members[root]
            used_members.add(root)
    if len(by_source) != len(case.get("images", [])):
        remaining_paths = [
            image["image_path"]
            for image in case.get("images", [])
            if image["image_path"] not in by_source
        ]
        remaining_members = [
            info for root, info in sorted(members.items()) if root not in used_members
        ]
        if len(remaining_paths) != len(remaining_members):
            return None
        by_source.update(zip(remaining_paths, remaining_members))
    return by_source


def transformed_task(task: dict, source_to_package: dict[str, str]) -> dict:
    result = copy.deepcopy(task)
    source_images = list(result.get("images", []))
    result["source_images"] = source_images
    result["images"] = [source_to_package[source] for source in source_images]
    return result


def transformed_case(case: dict, source_to_package: dict[str, str]) -> dict:
    result = copy.deepcopy(case)
    source_paths = []
    package_paths = []
    for image in result.get("images", []):
        source = image["image_path"]
        package = source_to_package[source]
        image["source_image_path"] = source
        image["image_path"] = package
        source_paths.append(source)
        package_paths.append(package)
    result["source_image_paths"] = source_paths
    result["image_paths"] = package_paths
    return result


def manifest_rows(cases: list[dict], source_to_package: dict[str, str]) -> list[dict]:
    rows = []
    for case in cases:
        matched_index = (case.get("label_match") or {}).get(
            "matched_case_image_index"
        )
        for index, image in enumerate(case.get("images", [])):
            source = image["image_path"]
            package = source_to_package[source]
            original_row = image.get("_manifest_row")
            row = copy.deepcopy(original_row) if isinstance(original_row, dict) else {}
            row.update(
                {
                    "src_abs_path": row.get("src_abs_path") or image.get("source_image_path"),
                    "src_rel_path": package,
                    "dest_rel_path": package,
                    "image_filename": Path(package).name,
                    "image_path": package,
                    "prompt": row.get("prompt") or case.get("prompt"),
                    "category": row.get("category") or case.get("category"),
                    "category_zh": row.get("category_zh") or case.get("category_zh"),
                    "case_id": row.get("case_id") or case.get("case_id"),
                    "source_dataset": row.get("source_dataset") or case.get("source_dataset"),
                    "model": row.get("model") or image.get("model"),
                }
            )
            if index == matched_index and case.get("label") is not None:
                row["label"] = case["label"]
            rows.append({key: value for key, value in row.items() if value is not None})
    return rows


def json_bytes(value: dict) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def legacy_package(progress: dict) -> dict | None:
    if not progress.get("output_zip") or not progress.get("selected_task_count"):
        return None
    return {
        "output_zip": progress["output_zip"],
        "status": "complete",
        "case_count": progress.get("selected_case_count", len(progress.get("processed_case_ids", []))),
        "task_count": progress.get("selected_task_count", len(progress.get("processed_task_ids", []))),
        "image_count": progress.get("selected_image_count", 0),
        "image_bytes": progress.get("selected_image_bytes", 0),
        "output_zip_bytes": progress.get("output_zip_bytes", 0),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--output-zip", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--max-bytes", type=int, default=3_500_000_000)
    args = parser.parse_args()

    if args.output_zip.exists() or args.output_zip.with_suffix(args.output_zip.suffix + ".partial").exists():
        raise RuntimeError(f"Refusing to overwrite existing output: {args.output_zip}")

    manifest = load_json(args.manifest)
    tasks_doc = load_json(args.tasks)
    tasks = tasks_doc["tasks"]
    task_by_id = {task["id"]: task for task in tasks}
    progress = load_json(args.progress) if args.progress.exists() else {}
    processed_case_ids = set(map(str, progress.get("processed_case_ids", [])))
    processed_task_ids = set(map(str, progress.get("processed_task_ids", [])))

    cases = manifest.get("annot_18000_cases", [])
    if isinstance(cases, dict):
        cases = list(cases.values())
    if not cases:
        cases = cases_from_manifest_rows(manifest)
    archive_index, archives = build_archive_index(args.input_dir)
    eligible_cases = []
    for case in cases:
        if case.get("source_dataset") != "manifest_8k_5model_stratified":
            continue
        if case.get("case_id") in processed_case_ids:
            continue
        members = archive_index.get(case.get("case_id"), {})
        if len(members) != 5:
            continue
        mapping = package_mapping(case, members)
        if mapping is None:
            continue
        task_ids = [str(value) for value in case.get("task_ids", {}).values()]
        if not any(task_id in task_by_id and task_id not in processed_task_ids for task_id in task_ids):
            continue
        eligible_cases.append((case, mapping))
    eligible_cases.sort(key=lambda item: item[0].get("case_index", 0))
    if not eligible_cases:
        raise RuntimeError("No unprocessed complete cases found in the first batch")

    # Keep a small allowance for the two root JSON files and ZIP metadata.
    max_payload = args.max_bytes - 20_000_000
    selected_cases = []
    selected_members = []
    selected_image_bytes = 0
    source_to_package = {}
    seen_member_keys = set()
    for case, mapping in eligible_cases:
        case_bytes = sum(info["size"] for info in mapping.values())
        if selected_cases and selected_image_bytes + case_bytes > max_payload:
            break
        if not selected_cases and case_bytes > max_payload:
            raise RuntimeError("A single case exceeds the package size budget")
        selected_cases.append(case)
        selected_image_bytes += case_bytes
        for source_path, info in mapping.items():
            source_to_package.setdefault(
                source_path, f"images/{archive_root(info['member'])}/{Path(info['member']).name}"
            )
            member_key = (str(info["archive"]), info["member"])
            if member_key not in seen_member_keys:
                seen_member_keys.add(member_key)
                selected_members.append((info, source_to_package[source_path]))

    selected_case_ids = {case["case_id"] for case in selected_cases}
    selected_task_ids = {
        str(task_id)
        for case in selected_cases
        for task_id in case.get("task_ids", {}).values()
        if str(task_id) in task_by_id and str(task_id) not in processed_task_ids
    }
    selected_tasks = [
        {
            "id": task["id"],
            "criterion": task["criterion"],
            "images": [
                {"src_rel_path": source_to_package[source]}
                for source in task.get("images", [])
            ],
        }
        for task in tasks
        if task["id"] in selected_task_ids
    ]
    tasks_data = json_bytes({"version": 1, "tasks": selected_tasks})
    manifest_data = json_bytes({
        "version": 1,
        "rows": manifest_rows(selected_cases, source_to_package),
    })

    temporary_zip = args.output_zip.with_suffix(args.output_zip.suffix + ".partial")
    temporary_zip.parent.mkdir(parents=True, exist_ok=True)
    archive_handles = {}
    try:
        for archive_path in archives:
            archive_handles[archive_path] = tarfile.open(archive_path, mode="r:*")
        with zipfile.ZipFile(temporary_zip, mode="w", compression=zipfile.ZIP_STORED, allowZip64=True) as output:
            for index, (info, package_name) in enumerate(selected_members, start=1):
                member = archive_handles[info["archive"]].extractfile(info["member"])
                if member is None:
                    raise RuntimeError(f"Cannot read {info['member']}")
                with output.open(package_name, mode="w", force_zip64=True) as target:
                    shutil.copyfileobj(member, target, length=1024 * 1024)
                if index % 250 == 0 or index == len(selected_members):
                    print(
                        f"images={index}/{len(selected_members)} cases={len(selected_cases)} "
                        f"tasks={len(selected_tasks)} image_bytes={selected_image_bytes}",
                        flush=True,
                    )
            output.writestr("tasks.json", tasks_data)
            output.writestr("manifest.json", manifest_data)
        actual_size = temporary_zip.stat().st_size
        if actual_size > args.max_bytes:
            temporary_zip.unlink()
            raise RuntimeError(f"Generated ZIP exceeds limit: {actual_size} > {args.max_bytes}")
        temporary_zip.replace(args.output_zip)
    finally:
        for handle in archive_handles.values():
            handle.close()

    package_record = {
        "output_zip": str(args.output_zip),
        "status": "complete",
        "case_count": len(selected_cases),
        "task_count": len(selected_tasks),
        "image_count": len(source_to_package),
        "image_bytes": selected_image_bytes,
        "output_zip_bytes": args.output_zip.stat().st_size,
    }
    packages = list(progress.get("packages", []))
    if not packages:
        old = legacy_package(progress)
        if old:
            packages.append(old)
    packages.append(package_record)
    all_case_ids = processed_case_ids | selected_case_ids
    all_task_ids = processed_task_ids | selected_task_ids
    total_eligible = sum(
        1 for case in cases
        if case.get("source_dataset") == "manifest_8k_5model_stratified"
        and case.get("case_id") in archive_index
        and len(archive_index[case.get("case_id")]) == 5
    )
    progress.update({
        "version": 2,
        "status": "complete" if len(all_case_ids) >= total_eligible else "partial",
        "source_manifest": str(args.manifest),
        "source_tasks": str(args.tasks),
        "source_archives": [archive.name for archive in archives],
        "max_bytes": args.max_bytes,
        "processed_case_ids": sorted(all_case_ids),
        "processed_task_ids": sorted(all_task_ids),
        "processed_case_count": len(all_case_ids),
        "processed_task_count": len(all_task_ids),
        "remaining_eligible_case_count": max(0, total_eligible - len(all_case_ids)),
        "packages": packages,
        "last_package": package_record,
    })
    write_json_atomic(args.progress, progress)
    print(
        f"COMPLETE cases={len(selected_cases)} tasks={len(selected_tasks)} "
        f"images={len(source_to_package)} zip_bytes={args.output_zip.stat().st_size} "
        f"cumulative_cases={len(all_case_ids)} cumulative_tasks={len(all_task_ids)}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
