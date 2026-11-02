from __future__ import annotations

import argparse
import json
import os
import shutil
import zipfile
from pathlib import Path


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def json_load(data: bytes):
    return json.loads(data.decode("utf-8"))


def json_bytes(value: dict) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def standard_tasks(document: dict) -> dict:
    tasks = []
    for task in document.get("tasks", []):
        tasks.append(
            {
                "id": str(task["id"]),
                "criterion": str(task["criterion"]),
                "images": [
                    {"src_rel_path": str(image)}
                    for image in task.get("images", [])
                ],
            }
        )
    return {"version": 1, "tasks": tasks}


def standard_manifest(document: dict) -> dict:
    rows = []
    for case in document.get("cases", []):
        images = case.get("images", [])
        label_match = case.get("label_match") or {}
        matched_index = label_match.get("matched_case_image_index")
        for index, image in enumerate(images):
            package_path = str(image["image_path"]).replace("\\", "/")
            source_path = image.get("source_image_path")
            row = {
                "src_abs_path": source_path,
                "src_rel_path": package_path,
                "dest_rel_path": package_path,
                "image_filename": Path(package_path).name,
                "image_path": package_path,
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
    return {"version": 1, "rows": rows}


def rewrite_archive(path: Path) -> dict:
    temporary = path.with_suffix(path.suffix + ".format.partial")
    if temporary.exists():
        raise RuntimeError(f"Temporary output already exists: {temporary}")

    with zipfile.ZipFile(path, "r") as source:
        names = source.namelist()
        tasks = standard_tasks(json_load(source.read("tasks.json")))
        manifest = standard_manifest(json_load(source.read("manifest.json")))
        image_names = {
            name
            for name in names
            if Path(name).suffix.lower() in IMAGE_SUFFIXES
        }
        task_paths = {
            image["src_rel_path"]
            for task in tasks["tasks"]
            for image in task["images"]
        }
        manifest_paths = {row["src_rel_path"] for row in manifest["rows"]}
        if not task_paths <= image_names:
            raise RuntimeError(f"Task references missing images in {path}")
        if manifest_paths != image_names:
            raise RuntimeError(
                f"Manifest/image mismatch in {path}: "
                f"manifest={len(manifest_paths)} images={len(image_names)}"
            )

        with zipfile.ZipFile(
            temporary,
            "w",
            compression=zipfile.ZIP_STORED,
            allowZip64=True,
        ) as target:
            for name in names:
                if name in {"tasks.json", "manifest.json", "jsons.json"}:
                    continue
                target.writestr(name, source.read(name))
            target.writestr("tasks.json", json_bytes(tasks))
            target.writestr("manifest.json", json_bytes(manifest))

    actual_size = temporary.stat().st_size
    if actual_size > 3_500_000_000:
        temporary.unlink()
        raise RuntimeError(f"Repaired archive exceeds 3.5 GB: {actual_size}")
    os.replace(temporary, path)
    return {
        "zip": str(path),
        "bytes": actual_size,
        "task_count": len(tasks["tasks"]),
        "manifest_row_count": len(manifest["rows"]),
        "image_count": len(image_names),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archives", nargs="+", type=Path)
    args = parser.parse_args()
    for archive in args.archives:
        print(json.dumps(rewrite_archive(archive), ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
