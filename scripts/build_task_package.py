from __future__ import annotations

import argparse
import copy
import io
import json
import os
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


def write_progress(path: Path, data: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
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
                root = archive_root(member.name)
                index[case_id][root] = {
                    "archive": archive_path,
                    "member": member.name,
                    "size": member.size,
                }
    return index, archives


def package_mapping(case: dict, members: dict[str, dict]):
    by_model = {}
    for image in case.get("images", []):
        root = model_archive_root(image.get("model", ""))
        if root in members:
            by_model[image["image_path"]] = members[root]
    if len(by_model) != len(case.get("images", [])):
        remaining_paths = [
            image["image_path"]
            for image in case.get("images", [])
            if image["image_path"] not in by_model
        ]
        remaining_members = [info for root, info in sorted(members.items()) if info not in by_model.values()]
        if len(remaining_paths) != len(remaining_members):
            return None
        by_model.update(zip(remaining_paths, remaining_members))
    return by_model


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
            row = {
                "src_abs_path": image.get("source_image_path"),
                "src_rel_path": package,
                "dest_rel_path": package,
                "image_filename": Path(package).name,
                "image_path": package,
                "prompt": case.get("prompt"),
                "category": case.get("category"),
                "category_zh": case.get("category_zh"),
                "case_id": case.get("case_id"),
                "source_dataset": case.get("source_dataset"),
                "model": image.get("model"),
            }
            if index == matched_index and case.get("label") is not None:
                row["label"] = case["label"]
            rows.append({key: value for key, value in row.items() if value is not None})
    return rows


def transformed_task(task: dict, source_to_package: dict[str, str]) -> dict:
    result = copy.deepcopy(task)
    sources = list(result.get("images", []))
    result["source_images"] = sources
    result["images"] = [source_to_package[source] for source in sources]
    return result


def json_bytes(value: dict) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--output-zip", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--max-bytes", type=int, default=3_500_000_000)
    args = parser.parse_args()

    if args.output_zip.exists():
        raise RuntimeError(f"Refusing to overwrite existing output: {args.output_zip}")

    manifest = load_json(args.manifest)
    tasks_doc = load_json(args.tasks)
    task_by_id = {task["id"]: task for task in tasks_doc["tasks"]}
    archive_index, archives = build_archive_index(args.input_dir)

    first_cases = [
        case
        for case in manifest["cases"]
        if case.get("source_dataset") == "manifest_8k_5model_stratified"
        and case["case_id"] in archive_index
        and len(archive_index[case["case_id"]]) == 5
    ]
    first_cases.sort(key=lambda case: case.get("case_index", 0))
    if not first_cases:
        raise RuntimeError("No complete first-batch cases found")

    progress = {
        "version": 1,
        "status": "running",
        "output_zip": str(args.output_zip),
        "source_manifest": str(args.manifest),
        "source_tasks": str(args.tasks),
        "source_archives": [archive.name for archive in archives],
        "max_bytes": args.max_bytes,
        "processed_case_ids": [],
        "processed_task_ids": [],
        "selected_image_count": 0,
        "selected_image_bytes": 0,
    }
    if args.progress.exists():
        previous = load_json(args.progress)
        if previous.get("status") == "complete":
            raise RuntimeError("Progress record is already complete; refusing a second run")

    max_payload = args.max_bytes - 200_000_000
    selected_cases = []
    selected_members = []
    selected_image_bytes = 0
    source_to_package = {}
    source_member_pairs = []

    for case in first_cases:
        members = archive_index[case["case_id"]]
        mapping = package_mapping(case, members)
        if mapping is None:
            continue
        case_bytes = sum(info["size"] for info in mapping.values())
        if selected_cases and selected_image_bytes + case_bytes > max_payload:
            break
        if not selected_cases and case_bytes > max_payload:
            raise RuntimeError("A single case exceeds the package size budget")

        selected_cases.append(case)
        selected_image_bytes += case_bytes
        for source_path, info in mapping.items():
            root = archive_root(info["member"])
            package_name = f"images/{root}/{Path(info['member']).name}"
            source_to_package[source_path] = package_name
            source_member_pairs.append((info, package_name))

    selected_case_ids = {case["case_id"] for case in selected_cases}
    selected_task_ids = {
        task_id
        for case in selected_cases
        for task_id in case.get("task_ids", {}).values()
        if task_id in task_by_id
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
        for task in tasks_doc["tasks"]
        if task["id"] in selected_task_ids
    ]
    tasks_data = json_bytes({"version": 1, "tasks": selected_tasks})
    manifest_data = json_bytes({
        "version": 1,
        "rows": manifest_rows(selected_cases, source_to_package),
    })

    temporary_zip = args.output_zip.with_suffix(args.output_zip.suffix + ".partial")
    temporary_zip.parent.mkdir(parents=True, exist_ok=True)
    if temporary_zip.exists():
        raise RuntimeError(f"Refusing to overwrite existing partial output: {temporary_zip}")

    archive_handles = {}
    try:
        for archive_path in archives:
            archive_handles[archive_path] = tarfile.open(archive_path, mode="r:*")
        with zipfile.ZipFile(temporary_zip, mode="w", compression=zipfile.ZIP_STORED, allowZip64=True) as output:
            total_images = len(source_member_pairs)
            for index, (info, package_name) in enumerate(source_member_pairs, start=1):
                member = archive_handles[info["archive"]].extractfile(info["member"])
                if member is None:
                    raise RuntimeError(f"Cannot read {info['member']}")
                with output.open(package_name, mode="w", force_zip64=True) as target:
                    shutil.copyfileobj(member, target, length=1024 * 1024)
                if index % 250 == 0 or index == total_images:
                    print(
                        f"images={index}/{total_images} "
                        f"bytes={selected_image_bytes / 1_000_000_000:.3f}GB",
                        flush=True,
                    )
            output.writestr("tasks.json", tasks_data)
            output.writestr("manifest.json", manifest_data)

        actual_size = temporary_zip.stat().st_size
        if actual_size > args.max_bytes:
            temporary_zip.unlink()
            raise RuntimeError(
                f"Generated ZIP exceeds limit: {actual_size} > {args.max_bytes} bytes"
            )
        temporary_zip.replace(args.output_zip)
    finally:
        for handle in archive_handles.values():
            handle.close()

    progress.update(
        {
            "status": "complete",
            "processed_case_ids": [case["case_id"] for case in selected_cases],
            "processed_task_ids": [task["id"] for task in selected_tasks],
            "selected_case_count": len(selected_cases),
            "selected_task_count": len(selected_tasks),
            "selected_image_count": len(source_to_package),
            "selected_image_bytes": selected_image_bytes,
            "output_zip_bytes": args.output_zip.stat().st_size,
        }
    )
    write_progress(args.progress, progress)
    print(
        f"COMPLETE cases={len(selected_cases)} tasks={len(selected_tasks)} "
        f"images={len(source_to_package)} zip_bytes={args.output_zip.stat().st_size}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
