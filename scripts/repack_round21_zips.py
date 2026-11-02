#!/usr/bin/env python3
import argparse
import csv
import json
import os
import posixpath
import shutil
import sys
import tempfile
import zipfile
from collections import defaultdict
from pathlib import Path


SOURCE_ZIPS = [
    "V030_images_20G_1.zip",
    "V030_images_remaining_20G_001.zip",
    "V030_images_remaining_20G_002.zip",
    "V030_images_remaining_20G_003_1.zip",
    "V030_images_remaining_20G_003_2.zip",
    "V030_images_remaining_20G_004.zip",
]

ZIP_BY_ROOT = {
    "V030_images_20G_1": "V030_images_20G_1.zip",
    "V030_images_remaining_20G_001": "V030_images_remaining_20G_001.zip",
    "V030_images_remaining_20G_002": "V030_images_remaining_20G_002.zip",
    "V030_images_remaining_20G_003_1": "V030_images_remaining_20G_003_1.zip",
    "V030_images_remaining_20G_003_1-0daf9b6b": "V030_images_remaining_20G_003_1.zip",
    "V030_images_remaining_20G_003_2": "V030_images_remaining_20G_003_2.zip",
    "V030_images_remaining_20G_004": "V030_images_remaining_20G_004.zip",
}

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}


def image_ref_name(ref):
    if isinstance(ref, str):
        value = ref
    elif isinstance(ref, dict):
        value = (
            ref.get("src_rel_path")
            or ref.get("path")
            or ref.get("image_path")
            or ref.get("filename")
            or ref.get("url")
        )
    else:
        value = None
    if not value or not isinstance(value, str):
        raise ValueError(f"bad image ref: {ref!r}")
    clean = value.replace("\\", "/")
    parts = [p for p in clean.split("/") if p]
    if len(parts) >= 3 and parts[0] == "files":
        root = parts[1]
        name = parts[-1]
    else:
        root = None
        name = parts[-1]
    return root, name


def manifest_image_name(row):
    for key in ("dest_rel_path", "src_rel_path", "image_filename", "image_path", "filename", "path"):
        value = row.get(key)
        if isinstance(value, str) and value:
            return posixpath.basename(value.replace("\\", "/"))
    return None


def read_json_from_zip(zip_path, member):
    with zipfile.ZipFile(zip_path) as zf:
        return json.loads(zf.read(member))


def load_db_image_map(path):
    if not path:
        return {}
    mapping = {}
    with open(path, "r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            storage = (row.get("storagepath") or "").replace("\\", "/").strip("/")
            zip_name = f"{row.get('subject_name')}.zip"
            original = row.get("originalpath") or row.get("filename")
            if not storage or not original:
                continue
            mapping[storage] = {
                "zip": zip_name,
                "name": posixpath.basename(original.replace("\\", "/")),
            }
    return mapping


def load_zip_indexes(source_dir):
    indexes = {}
    for zip_name in SOURCE_ZIPS:
        zip_path = source_dir / zip_name
        if not zip_path.exists():
            raise FileNotFoundError(zip_path)
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
            if "manifest.json" not in names or "tasks.json" not in names:
                raise RuntimeError(f"{zip_name}: missing root manifest.json/tasks.json")
            image_members = {
                posixpath.basename(n.replace("\\", "/")): n
                for n in names
                if posixpath.splitext(n.lower())[1] in IMAGE_EXTS and not n.endswith("/")
            }
            manifest = json.loads(zf.read("manifest.json"))
        rows = manifest.get("rows") if isinstance(manifest, dict) else None
        if not isinstance(rows, list):
            raise RuntimeError(f"{zip_name}: manifest.json must contain rows array")
        rows_by_name = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            name = manifest_image_name(row)
            if name:
                rows_by_name[name] = row
        indexes[zip_name] = {
            "image_members": image_members,
            "rows_by_name": rows_by_name,
            "manifest_version": manifest.get("version", 1),
            "original_rows": len(rows),
        }
    return indexes


def split_tasks(tasks_path, indexes, db_image_map):
    with open(tasks_path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    tasks = payload.get("tasks")
    if not isinstance(tasks, list):
        raise RuntimeError("tasks.json must contain tasks array")

    grouped_tasks = defaultdict(list)
    grouped_images = defaultdict(set)
    errors = []
    seen_task_ids = set()

    for idx, task in enumerate(tasks, 1):
        if not isinstance(task, dict):
            errors.append(f"task #{idx}: not object")
            continue
        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id:
            errors.append(f"task #{idx}: bad id")
        elif task_id in seen_task_ids:
            errors.append(f"task {task_id}: duplicate id")
        else:
            seen_task_ids.add(task_id)

        images = task.get("images")
        if not isinstance(images, list) or not images:
            errors.append(f"task {task_id or idx}: bad images")
            continue

        roots = set()
        names = []
        normalized_images = []
        for ref in images:
            try:
                root, name = image_ref_name(ref)
            except ValueError as exc:
                errors.append(f"task {task_id or idx}: {exc}")
                continue
            storage_key = f"{root}/{name}" if root else name
            mapped = db_image_map.get(storage_key)
            if mapped:
                roots.add(mapped["zip"][:-4])
                names.append(mapped["name"])
                normalized_images.append({"src_rel_path": mapped["name"]})
            else:
                if root:
                    roots.add(root)
                names.append(name)
                normalized_images.append({"src_rel_path": name})

        if len(roots) != 1:
            errors.append(f"task {task_id or idx}: images span roots {sorted(roots)}")
            continue
        root = next(iter(roots))
        zip_name = ZIP_BY_ROOT.get(root)
        if not zip_name:
            errors.append(f"task {task_id or idx}: unknown root {root}")
            continue

        missing = [name for name in names if name not in indexes[zip_name]["image_members"]]
        missing_manifest = [name for name in names if name not in indexes[zip_name]["rows_by_name"]]
        if missing:
            errors.append(f"task {task_id or idx}: images missing from {zip_name}: {missing[:3]}")
            continue
        if missing_manifest:
            errors.append(f"task {task_id or idx}: manifest rows missing from {zip_name}: {missing_manifest[:3]}")
            continue

        normalized_task = dict(task)
        normalized_task["images"] = normalized_images
        grouped_tasks[zip_name].append(normalized_task)
        grouped_images[zip_name].update(names)

    if errors:
        preview = "\n".join(errors[:30])
        raise RuntimeError(f"validation errors: {len(errors)}\n{preview}")
    return payload.get("version", 1), grouped_tasks, grouped_images


def write_split_json(out_dir, task_version, grouped_tasks, grouped_images, indexes):
    out_dir.mkdir(parents=True, exist_ok=True)
    stats = []
    for zip_name in SOURCE_ZIPS:
        stem = zip_name[:-4]
        tasks = grouped_tasks.get(zip_name, [])
        images = grouped_images.get(zip_name, set())
        rows_by_name = indexes[zip_name]["rows_by_name"]
        rows = [rows_by_name[name] for name in sorted(images)]
        pkg_dir = out_dir / stem
        pkg_dir.mkdir(parents=True, exist_ok=True)
        tasks_file = pkg_dir / "tasks.json"
        manifest_file = pkg_dir / "manifest.json"
        with open(tasks_file, "w", encoding="utf-8") as f:
            json.dump({"version": task_version, "tasks": tasks}, f, ensure_ascii=False, separators=(",", ":"))
        with open(manifest_file, "w", encoding="utf-8") as f:
            json.dump({"version": indexes[zip_name]["manifest_version"], "rows": rows}, f, ensure_ascii=False, separators=(",", ":"))
        stats.append({
            "zip": zip_name,
            "tasks": len(tasks),
            "images": len(images),
            "tasks_bytes": tasks_file.stat().st_size,
            "manifest_bytes": manifest_file.stat().st_size,
            "original_manifest_rows": indexes[zip_name]["original_rows"],
        })
    return stats


def rewrite_zip_json(zip_path, json_dir):
    tmp_path = zip_path.with_suffix(zip_path.suffix + ".tmp")
    with zipfile.ZipFile(zip_path, "r") as src, zipfile.ZipFile(tmp_path, "w", allowZip64=True) as dst:
        for info in src.infolist():
            if info.filename in {"tasks.json", "manifest.json"}:
                continue
            dst.writestr(info, src.read(info.filename))
        for member in ("tasks.json", "manifest.json"):
            src_file = json_dir / member
            info = zipfile.ZipInfo(member)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            with open(src_file, "rb") as f:
                dst.writestr(info, f.read())
    os.replace(tmp_path, zip_path)


def repack(source_dir, out_dir, split_dir, suffix):
    built = []
    for zip_name in SOURCE_ZIPS:
        source_zip = source_dir / zip_name
        target_zip = out_dir / f"{zip_name[:-4]}_{suffix}.zip"
        print(f"[copy] {zip_name} -> {target_zip.name}", flush=True)
        shutil.copy2(source_zip, target_zip)
        print(f"[replace-json] {target_zip.name}", flush=True)
        rewrite_zip_json(target_zip, split_dir / zip_name[:-4])
        built.append(target_zip)
    return built


def validate_built(zip_paths, split_dir, suffix):
    for zip_path in zip_paths:
        stem = zip_path.name
        if stem.endswith(".zip"):
            stem = stem[:-4]
        suffix_text = f"_{suffix}"
        if stem.endswith(suffix_text):
            source_stem = stem[: -len(suffix_text)]
        else:
            source_stem = stem
        expected_dir = split_dir / source_stem
        with zipfile.ZipFile(zip_path) as zf:
            bad = zf.testzip()
            if bad:
                raise RuntimeError(f"{zip_path.name}: corrupt member {bad}")
            tasks = json.loads(zf.read("tasks.json"))
            manifest = json.loads(zf.read("manifest.json"))
            if tasks != json.loads((expected_dir / "tasks.json").read_text(encoding="utf-8")):
                raise RuntimeError(f"{zip_path.name}: tasks.json mismatch")
            if manifest != json.loads((expected_dir / "manifest.json").read_text(encoding="utf-8")):
                raise RuntimeError(f"{zip_path.name}: manifest.json mismatch")
            print(f"[ok] {zip_path.name}: tasks={len(tasks['tasks'])} manifest_rows={len(manifest['rows'])} size={zip_path.stat().st_size}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", required=True)
    parser.add_argument("--source-dir", default="/data/sunwenxiu/rating/inbox/processed")
    parser.add_argument("--out-dir", default="/data/sunwenxiu/rating/inbox/round21")
    parser.add_argument("--split-dir", default="/tmp/round21_split_json")
    parser.add_argument("--db-image-map")
    parser.add_argument("--suffix", default="round21")
    parser.add_argument("--plan-only", action="store_true")
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()

    source_dir = Path(args.source_dir)
    out_dir = Path(args.out_dir)
    split_dir = Path(args.split_dir)
    indexes = load_zip_indexes(source_dir)
    db_image_map = load_db_image_map(args.db_image_map)
    task_version, grouped_tasks, grouped_images = split_tasks(args.tasks, indexes, db_image_map)
    stats = write_split_json(split_dir, task_version, grouped_tasks, grouped_images, indexes)
    print(json.dumps(stats, ensure_ascii=False, indent=2), flush=True)
    if args.plan_only:
        return
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.validate_only:
        built = [out_dir / f"{zip_name[:-4]}_{args.suffix}.zip" for zip_name in SOURCE_ZIPS]
        validate_built(built, split_dir, args.suffix)
        return
    built = repack(source_dir, out_dir, split_dir, args.suffix)
    validate_built(built, split_dir, args.suffix)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
