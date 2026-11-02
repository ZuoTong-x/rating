from __future__ import annotations

import argparse
import copy
import json
import re
import shutil
import sys
import tarfile
import time
import zipfile
from collections import defaultdict
from pathlib import Path

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
CRITERIA = {
    "overall", "creativity", "mood", "composition", "color", "lighting",
    "realism", "detail", "promptAlignment", "textCorrectness",
    "anatomyNormality", "informationClarity", "designQuality", "typography",
}
SPECIAL_MARKER = "third_level_leaf_1500prompt"
TARGET_BYTES = 3_350_000_000
LIMIT_BYTES = 3_500_000_000


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def dump(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def clean(value: object) -> str:
    return str(value or "").replace("\\", "/").strip()


def model_key(value: object) -> str:
    key = re.sub(r"[^a-z0-9]+", "", str(value or "").lower())
    aliases = {
        "flux2dev": "flux2", "zimage": "zimage", "flux2": "flux2",
        "flux1": "flux1", "qwenimage2512": "qwenimage2512",
        "qwenimage30": "qwenimage30", "gemini31flash": "gemini31flash",
        "glmimage": "glmimage", "gptimage2": "gptimage2",
        "hidreamo1": "hidreamo1", "hunyuanimage3": "hunyuanimage3",
        "ideogram4": "ideogram4", "midjourney": "midjourney",
        "sd35large": "sd35large", "seedream5pro": "seedream5pro",
        "u1fast": "u1fast", "u15": "u15", "u1": "u1",
        "wan27image": "wan27image",
    }
    return aliases.get(key, key)


def case_id(name: str) -> str | None:
    m = re.match(r"^(.+?)-(\d+)(?:-(.+))?$", Path(name).stem)
    if not m:
        return None
    return f"{m.group(1)}:{m.group(2)}" + (f":{m.group(3)}" if m.group(3) else "")


def is_image(name: str) -> bool:
    return Path(name).suffix.lower() in IMAGE_SUFFIXES


def row_catalog(row: dict) -> dict:
    return row.get("catalog_row") or {}


def row_source(row: dict) -> str:
    return str(row_catalog(row).get("source_task_set") or row.get("source") or "")


def row_case(row: dict) -> str:
    return str(row_catalog(row).get("source_case_id") or row.get("case_id") or "")


def row_model(row: dict) -> str:
    c = row_catalog(row)
    return model_key(c.get("model_name") or c.get("model_id") or row.get("model"))


def task_ref(item: object) -> str:
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        return clean(item.get("src_rel_path") or item.get("originalPath") or item.get("path") or item.get("filename"))
    return ""


def archive_records(root: Path) -> tuple[list[dict], list[dict]]:
    paths = sorted(
        p for p in root.rglob("*")
        if p.is_file() and (p.suffix.lower() == ".tar" or p.name == "v030_12000_images.zip")
    )
    records, summaries = [], []
    for archive_no, path in enumerate(paths):
        label = f"a{archive_no:03d}_{re.sub(r'[^A-Za-z0-9._-]+', '_', path.stem)}"
        current = []
        if path.suffix.lower() == ".tar":
            with tarfile.open(path, "r:*") as container:
                for member_no, member in enumerate(container):
                    if not member.isfile() or not is_image(member.name):
                        continue
                    parts = Path(member.name).parts
                    current.append({
                        "archive": str(path), "member": member.name, "size": int(member.size),
                        "case_id": case_id(Path(member.name).name),
                        "model": model_key(parts[0] if parts else path.stem), "zip": False,
                        "dest": f"{label}__{member_no:06d}{Path(member.name).suffix.lower()}",
                    })
        else:
            with zipfile.ZipFile(path) as container:
                for member_no, member in enumerate(container.infolist()):
                    if member.is_dir() or not is_image(member.filename):
                        continue
                    current.append({
                        "archive": str(path), "member": member.filename, "size": int(member.file_size),
                        "case_id": None, "model": "mixed30", "zip": True,
                        "dest": f"{label}__{member_no:06d}{Path(member.filename).suffix.lower()}",
                    })
        records.extend(current)
        summaries.append({"archive": str(path), "images": len(current), "bytes": sum(r["size"] for r in current)})
    return records, summaries


def build_plan(root: Path, tasks_path: Path, manifest_path: Path) -> dict:
    task_doc, manifest_doc = load(tasks_path), load(manifest_path)
    tasks, rows = task_doc.get("tasks", []), manifest_doc.get("rows", [])
    records, summaries = archive_records(root)
    by_case_model = defaultdict(list)
    by_name = defaultdict(list)
    special_by_model = defaultdict(list)
    for index, record in enumerate(records):
        by_name[Path(record["member"]).name.lower()].append(index)
        if record["case_id"]:
            by_case_model[(record["case_id"], record["model"])].append(index)
        rel = Path(record["archive"]).relative_to(root).parts
        if record["zip"] is False and len(rel) == 2:
            special_by_model[record["model"]].append(index)

    row_record = {}
    special_rows = defaultdict(list)
    for row_index, row in enumerate(rows):
        c = row_catalog(row)
        if row_source(row) == "annot_18000_9metrics" and SPECIAL_MARKER in clean(c.get("task_image_path")):
            special_rows[row_model(row)].append(row_index)
        elif row_source(row) == "mixed30_93000":
            candidates = by_name.get(Path(clean(row.get("src_rel_path"))).name.lower(), [])
            if not candidates:
                raise RuntimeError(f"manifest row {row_index} has no archive image")
            row_record[row_index] = candidates[0]
        else:
            candidates = by_case_model.get((row_case(row), row_model(row)), [])
            if len(candidates) != 1:
                raise RuntimeError(f"manifest row {row_index} mapping={len(candidates)} key={row_case(row)}/{row_model(row)}")
            row_record[row_index] = candidates[0]
    for model, row_indices in special_rows.items():
        row_indices.sort(key=lambda i: (rows[i].get("flat_index", i), i))
        record_indices = special_by_model.get(model, [])
        if len(row_indices) != len(record_indices):
            raise RuntimeError(f"special mapping mismatch {model}: rows={len(row_indices)} records={len(record_indices)}")
        for row_index, record_index in zip(row_indices, record_indices):
            row_record[row_index] = record_index
    if len(row_record) != len(rows):
        raise RuntimeError(f"unmapped manifest rows={len(rows)-len(row_record)}")

    row_by_task_id = defaultdict(list)
    for row_index, row in enumerate(rows):
        for task_id in (row_catalog(row).get("task_ids") or {}).values():
            row_by_task_id[str(task_id)].append(row_index)
    row_names = defaultdict(list)
    for row_index, row in enumerate(rows):
        for value in [row.get("src_abs_path"), row.get("src_rel_path"), row_catalog(row).get("task_image_path"), row_catalog(row).get("image_path")]:
            if clean(value):
                row_names[Path(clean(value)).name.lower()].append(row_index)

    task_rows = []
    missing = []
    duplicate = []
    for task_index, task in enumerate(tasks):
        if task.get("criterion") not in CRITERIA or not isinstance(task.get("images"), list) or not 1 <= len(task["images"]) <= 5:
            raise RuntimeError(f"invalid task {task_index}")
        indexes = []
        for item_no, item in enumerate(task["images"]):
            ref = task_ref(item)
            candidates = row_by_task_id.get(str(task.get("id")), [])
            if len(candidates) == len(task["images"]):
                row_index = candidates[item_no]
            else:
                candidates = row_names.get(Path(ref).name.lower(), [])
                if not candidates:
                    missing.append((task_index, item_no, ref))
                    continue
                row_index = candidates[0]
            indexes.append(row_index)
        if len(indexes) != len(task["images"]) or len({row_record[i] for i in indexes}) != len(indexes):
            duplicate.append(task_index)
        task_rows.append(indexes)
    if missing:
        raise RuntimeError(f"missing task refs={len(missing)} sample={missing[:3]}")
    if duplicate:
        raise RuntimeError(f"duplicate images in tasks={len(duplicate)} sample={duplicate[:3]}")

    # Keep each task intact. A shared image may be copied into more than one
    # package when the task graph would otherwise create an oversized component.
    package_tasks = defaultdict(list)
    package_records = defaultdict(set)
    package_sizes = []
    task_package = {}
    record_package = {}
    for task_index, indexes in enumerate(task_rows):
        component_records = {row_record[i] for i in indexes}
        size = sum(records[i]["size"] for i in component_records)
        if size > TARGET_BYTES:
            raise RuntimeError(f"task component exceeds target={size}")
        package = len(package_sizes) - 1
        if package < 0 or package_sizes[package] + size > TARGET_BYTES:
            package_sizes.append(0); package += 1
        package_sizes[package] += size
        package_records[package].update(component_records)
        package_tasks[package].append(task_index)
        task_package[task_index] = package
        for i in component_records: record_package.setdefault(i, package)
    for record_index, record in enumerate(records):
        if record_index in record_package:
            continue
        package = len(package_sizes) - 1
        if package < 0 or package_sizes[package] + record["size"] > TARGET_BYTES:
            package_sizes.append(0); package += 1
        package_sizes[package] += record["size"]
        package_records[package].add(record_index); record_package[record_index] = package

    plan = {
        "version": 1, "status": "planned", "root": str(root),
        "tasks_path": str(tasks_path), "manifest_path": str(manifest_path),
        "tasks": tasks, "rows": rows, "records": records, "summaries": summaries,
        "row_record": {str(k): v for k, v in row_record.items()},
        "task_rows": task_rows, "task_package": {str(k): v for k, v in task_package.items()},
        "record_package": {str(k): v for k, v in record_package.items()},
        "package_tasks": {str(k): v for k, v in package_tasks.items()},
        "package_records": {str(k): sorted(v) for k, v in package_records.items()},
        "package_sizes": package_sizes,
    }
    print(json.dumps({"archives": len(summaries), "archive_images": len(records), "manifest_rows": len(rows), "tasks": len(tasks), "packages": len(package_sizes), "package_sizes": package_sizes}, ensure_ascii=False, indent=2), flush=True)
    return plan


def write_package(plan: dict, package_index: int, output: Path) -> None:
    records = plan["records"]
    row_record = {int(k): v for k, v in plan["row_record"].items()}
    record_ids = set(plan["package_records"][str(package_index)])
    destinations = {i: records[i]["dest"] for i in record_ids}
    rows_by_record = {}
    for row_index, record_index in row_record.items():
        if record_index in record_ids:
            rows_by_record.setdefault(record_index, plan["rows"][row_index])
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_suffix(output.suffix + ".partial")
    if partial.exists():
        raise RuntimeError(f"partial output exists: {partial}")
    archive_groups = defaultdict(list)
    for record_index in sorted(record_ids):
        archive_groups[records[record_index]["archive"]].append(record_index)
    processed = 0
    with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as target:
        for archive_path, ids in archive_groups.items():
            by_member = {records[i]["member"]: i for i in ids}
            if Path(archive_path).suffix.lower() == ".tar":
                container = tarfile.open(archive_path, "r:*")
                iterator = ((m.name, m) for m in container if m.isfile() and is_image(m.name))
            else:
                container = zipfile.ZipFile(archive_path)
                iterator = ((m.filename, m) for m in container.infolist() if not m.is_dir() and is_image(m.filename))
            try:
                for member_name, member in iterator:
                    record_index = by_member.get(member_name)
                    if record_index is None:
                        continue
                    source = container.extractfile(member) if isinstance(container, tarfile.TarFile) else container.open(member)
                    if source is None: raise RuntimeError(f"cannot read {archive_path}:{member_name}")
                    try:
                        with source, target.open(destinations[record_index], "w", force_zip64=True) as sink:
                            shutil.copyfileobj(source, sink, length=1024 * 1024)
                    finally:
                        source.close()
                    processed += 1
                    if processed % 250 == 0:
                        print(f"PACKAGE {package_index+1} images={processed}/{len(record_ids)}", flush=True)
            finally:
                container.close()
        task_ids = set(plan["package_tasks"].get(str(package_index), []))
        task_rows = plan["task_rows"]
        tasks_out = []
        for task_index in sorted(task_ids):
            task = plan["tasks"][task_index]
            tasks_out.append({"id": str(task["id"]), "criterion": task["criterion"], "images": [{"src_rel_path": destinations[row_record[i]]} for i in task_rows[task_index]]})
        manifest_out = []
        for record_index in sorted(record_ids):
            row = copy.deepcopy(rows_by_record.get(record_index, {"source": "unreferenced_archive_image"}))
            row.update({"src_rel_path": destinations[record_index], "dest_rel_path": destinations[record_index], "image_filename": destinations[record_index], "image_path": destinations[record_index]})
            manifest_out.append(row)
        target.writestr("tasks.json", json.dumps({"version": 1, "tasks": tasks_out}, ensure_ascii=False, indent=2).encode("utf-8"))
        target.writestr("manifest.json", json.dumps({"version": 1, "rows": manifest_out}, ensure_ascii=False, indent=2).encode("utf-8"))
    size = partial.stat().st_size
    if size > LIMIT_BYTES:
        partial.unlink(); raise RuntimeError(f"package over limit: {size}")
    partial.replace(output)
    print(f"PACKAGE_DONE {output.name} bytes={size} images={processed} tasks={len(tasks_out)}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--delete-source", action="store_true")
    args = parser.parse_args()
    plan = build_plan(args.root, args.tasks, args.manifest)
    if args.dry_run:
        dump(args.plan, plan); return 0
    if not args.delete_source:
        print("Refusing to modify source without --delete-source", file=sys.stderr); return 2
    progress = load(args.progress) if args.progress.exists() else {"version": 1, "completed_packages": [], "deleted_archives": []}
    for package_index in range(len(plan["package_sizes"])):
        output = args.output_dir / f"package_{package_index+1:03d}.zip"
        if package_index not in progress.get("completed_packages", []):
            write_package(plan, package_index, output)
            progress.setdefault("completed_packages", []).append(package_index)
            dump(args.progress, progress)
    dump(args.progress, {**progress, "status": "complete", "completed_at": time.time()})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
