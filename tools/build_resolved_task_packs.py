#!/usr/bin/env python3
"""Build server-valid task ZIPs from resolved images in processed source archives."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import sys
import time
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
PATH_FIELDS = (
    "src_abs_path",
    "src_rel_path",
    "dest_rel_path",
    "filename",
    "path",
    "image_path",
    "original_path",
    "task_image_path",
    "relative_path",
)
PACK_IMAGE_BYTES_LIMIT = 19 * 1024**3
PACK_IMAGE_COUNT_LIMIT = 49_000
JSON_BYTES_LIMIT = 60 * 1024**2
SERVER_JSON_BYTES_LIMIT = 64 * 1024**2
SERVER_ZIP_BYTES_LIMIT = 20 * 1024**3
PLACEHOLDER_NAME = "white_placeholder.jpg"


def placeholder_name(index: int) -> str:
    return PLACEHOLDER_NAME if index == 0 else f"white_placeholder{index}.jpg"


def is_placeholder_key(value: str) -> bool:
    return value == "__placeholder__"


def log(*parts: object) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *parts, flush=True)


def normalized(value: object) -> str:
    return str(value).replace("\\", "/").strip()


def filename(value: object) -> str:
    return os.path.basename(normalized(value))


def model_key(value: object) -> str:
    key = normalized(value).lower().replace("_", "-").replace(".", "")
    key = re.sub(r"[^a-z0-9]+", "-", key).strip("-")
    aliases = {
        "gemini-31-flash-image": "gemini-31-flash",
        "gemini-3-1-flash-image": "gemini-31-flash",
        "gemini-31-flash": "gemini-31-flash",
        "glm-image": "glm-image",
        "hunyuan-image-3": "hunyuan-image-3",
        "qwen-image-2512": "qwen-image-2512",
        "hidream-o1": "hidream-o1",
        "seedream-5-pro": "seedream-5-pro",
        "midjourney": "midjourney",
        "u1": "u1",
        "flux-1": "flux-1",
        "flux1": "flux-1",
        "flux-2": "flux-2",
        "flux2": "flux-2",
        "sd3-5-large": "sd35-large",
        "sd35-large": "sd35-large",
        "qwen-image-30": "qwen-image-30",
        "qwen-image-3-0": "qwen-image-30",
        "wan-27-image": "wan-27-image",
        "wan-2-7-image": "wan-27-image",
    }
    return aliases.get(key, key)


def task_case_model(reference: str) -> tuple[str | None, str]:
    path = normalized(reference)
    stem = Path(path).stem
    match = re.match(r"(.+)-([0-9]+)$", stem)
    case = f"{match.group(1)}:{match.group(2)}" if match else None
    return case, model_key(Path(path).parent.name)


def image_references(task: dict) -> list[str]:
    result: list[str] = []
    images = task.get("images", [])
    if not isinstance(images, list):
        return result
    for value in images:
        if isinstance(value, str):
            result.append(normalized(value))
            continue
        if not isinstance(value, dict):
            continue
        for key in ("src_rel_path", "dest_rel_path", "filename", "path", "url"):
            candidate = value.get(key)
            if isinstance(candidate, str):
                result.append(normalized(candidate))
                break
    return result


def json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def put_first(index: dict, key: object, value: object) -> None:
    if key and key not in index:
        index[key] = value


@dataclass(frozen=True)
class SourceImage:
    key: str
    archive: Path
    entry_name: str
    size: int
    row: dict
    output_name: str


class DisjointSet:
    def __init__(self, count: int) -> None:
        self.parents = list(range(count))
        self.sizes = [1] * count

    def find(self, value: int) -> int:
        while self.parents[value] != value:
            self.parents[value] = self.parents[self.parents[value]]
            value = self.parents[value]
        return value

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        if self.sizes[left_root] < self.sizes[right_root]:
            left_root, right_root = right_root, left_root
        self.parents[right_root] = left_root
        self.sizes[left_root] += self.sizes[right_root]


def catalog_cases(row: dict) -> list[str]:
    catalog = row.get("catalog_row") if isinstance(row.get("catalog_row"), dict) else {}
    return [
        normalized(value)
        for value in (row.get("case_id"), catalog.get("source_case_id"), catalog.get("pid"))
        if isinstance(value, str) and value
    ]


def catalog_models(row: dict) -> list[str]:
    catalog = row.get("catalog_row") if isinstance(row.get("catalog_row"), dict) else {}
    values: set[str] = set()
    for value in (catalog.get("model_id"), catalog.get("model_name")):
        if isinstance(value, str) and value:
            values.add(model_key(value))
    for source in (row, catalog):
        for key in PATH_FIELDS:
            value = source.get(key)
            if not isinstance(value, str):
                continue
            for part in normalized(value).split("/"):
                candidate = model_key(part)
                if any(
                    token in candidate
                    for token in (
                        "qwen",
                        "hunyuan",
                        "gemini",
                        "glm",
                        "hidream",
                        "seedream",
                        "midjourney",
                        "flux",
                        "sd3",
                        "sd35",
                        "u1",
                        "wan",
                    )
                ):
                    values.add(candidate)
    destination = normalized(row.get("dest_rel_path") or row.get("src_rel_path") or "")
    if destination:
        prefix = filename(destination).split("__")[0]
        if re.match(r"a\d{3}_", prefix):
            prefix = prefix[5:]
        values.add(model_key(prefix))
    return [value for value in values if value]


def make_output_name(source_key: str, entry_name: str) -> str:
    suffix = Path(entry_name).suffix.lower() or ".jpg"
    digest = hashlib.sha1(source_key.encode("utf-8")).hexdigest()[:20]
    return f"img_{digest}{suffix}"


def load_source_images(processed_dir: Path) -> tuple[dict[str, SourceImage], dict, dict, dict]:
    images: dict[str, SourceImage] = {}
    path_index: dict[str, str] = {}
    basename_index: dict[str, str] = {}
    case_model_index: dict[tuple[str, str], str] = {}

    archives = sorted(processed_dir.glob("*.zip"), key=lambda path: path.name)
    for archive in archives:
        log("index", archive.name)
        with zipfile.ZipFile(archive) as source_zip:
            entries = {
                entry.filename: entry
                for entry in source_zip.infolist()
                if not entry.is_dir() and Path(entry.filename).suffix.lower() in IMAGE_EXTENSIONS
            }
            if "manifest.json" not in source_zip.namelist():
                continue
            manifest = json.loads(source_zip.read("manifest.json").decode("utf-8"))
            rows = manifest.get("rows") if isinstance(manifest, dict) else manifest
            if not isinstance(rows, list):
                continue

            for row in rows:
                if not isinstance(row, dict):
                    continue
                destination = normalized(
                    row.get("dest_rel_path") or row.get("src_rel_path") or row.get("filename") or ""
                )
                if destination not in entries and filename(destination) in entries:
                    destination = filename(destination)
                if destination not in entries:
                    continue

                source_key = f"{archive.name}:{destination}"
                if source_key not in images:
                    entry = entries[destination]
                    images[source_key] = SourceImage(
                        key=source_key,
                        archive=archive,
                        entry_name=destination,
                        size=entry.file_size,
                        row=row,
                        output_name=make_output_name(source_key, destination),
                    )

                values = [destination, filename(destination)]
                catalog = row.get("catalog_row") if isinstance(row.get("catalog_row"), dict) else {}
                for source in (row, catalog):
                    for field in PATH_FIELDS:
                        value = source.get(field)
                        if not isinstance(value, str) or not value:
                            continue
                        value = normalized(value)
                        values.extend((value, filename(value)))
                        parts = value.split("/")
                        for length in (2, 3, 4, 5):
                            if len(parts) >= length:
                                values.append("/".join(parts[-length:]))

                for value in values:
                    put_first(path_index, value, source_key)
                    put_first(basename_index, filename(value), source_key)
                for case in catalog_cases(row):
                    for model in catalog_models(row):
                        put_first(case_model_index, (case, model), source_key)

    return images, path_index, basename_index, case_model_index


def resolve_reference(
    reference: str,
    path_index: dict[str, str],
    basename_index: dict[str, str],
    case_model_index: dict[tuple[str, str], str],
) -> tuple[str | None, str]:
    reference = normalized(reference)
    name = filename(reference).lower()
    if name == PLACEHOLDER_NAME or "white_placeholder" in name:
        return "__placeholder__", "placeholder"

    value = path_index.get(reference)
    if value:
        return value, "path"
    pieces = reference.split("/")
    for length in (5, 4, 3, 2):
        if len(pieces) < length:
            continue
        value = path_index.get("/".join(pieces[-length:]))
        if value:
            return value, f"suffix{length}"
    case, model = task_case_model(reference)
    if case:
        value = case_model_index.get((case, model))
        if value:
            return value, "case_model"
    value = basename_index.get(filename(reference))
    if value:
        return value, "basename"
    return None, "missing"


def output_manifest_row(image: SourceImage) -> dict:
    row = copy.deepcopy(image.row)
    for target in (row, row.get("catalog_row")):
        if not isinstance(target, dict):
            continue
        target["src_rel_path"] = image.output_name
        target["dest_rel_path"] = image.output_name
        target["image_filename"] = image.output_name
        target["image_path"] = image.output_name
    row["src_rel_path"] = image.output_name
    row["dest_rel_path"] = image.output_name
    row["image_filename"] = image.output_name
    row["image_path"] = image.output_name
    return row


def placeholder_manifest_row(name: str = PLACEHOLDER_NAME) -> dict:
    return {
        "src_rel_path": name,
        "dest_rel_path": name,
        "image_filename": name,
        "image_path": name,
        "source": "provided_white_placeholder",
    }


def build_resolved_tasks(
    tasks: list[dict],
    images: dict[str, SourceImage],
    path_index: dict,
    basename_index: dict,
    case_model_index: dict,
) -> tuple[list[dict], Counter, list[str]]:
    resolved_tasks: list[dict] = []
    match_counts: Counter = Counter()
    missing_examples: list[str] = []

    for raw_task in tasks:
        references = image_references(raw_task)
        if len(references) != 5:
            continue
        image_keys: list[str] = []
        failed = False
        for reference in references:
            source_key, match_kind = resolve_reference(
                reference,
                path_index,
                basename_index,
                case_model_index,
            )
            match_counts[match_kind] += 1
            if not source_key:
                failed = True
                if len(missing_examples) < 20:
                    missing_examples.append(reference)
                break
            image_keys.append(source_key)
        if failed:
            continue
        non_placeholder_keys = [
            source_key
            for source_key in image_keys
            if not is_placeholder_key(source_key)
        ]
        if len(non_placeholder_keys) != len(set(non_placeholder_keys)):
            continue

        output_images = []
        placeholder_index = 0
        for source_key in image_keys:
            if source_key == "__placeholder__":
                output_name = placeholder_name(placeholder_index)
                placeholder_index += 1
            else:
                output_name = images[source_key].output_name
            output_images.append({"src_rel_path": output_name})
        task = {
            "id": str(raw_task.get("id", "")).strip(),
            "criterion": str(raw_task.get("criterion", "")).strip(),
            "images": output_images,
        }
        if not task["id"] or not task["criterion"]:
            continue
        resolved_tasks.append({"task": task, "image_keys": image_keys})
    return resolved_tasks, match_counts, missing_examples


def component_stats(component: list[int], resolved: list[dict], images: dict[str, SourceImage]) -> dict:
    image_keys = {
        source_key
        for index in component
        for source_key in resolved[index]["image_keys"]
        if not is_placeholder_key(source_key)
    }
    task_rows = [resolved[index]["task"] for index in component]
    placeholder_names = {
        item["src_rel_path"]
        for task in task_rows
        for item in task["images"]
        if isinstance(item, dict) and str(item.get("src_rel_path", "")).startswith("white_placeholder")
    }
    manifest_rows = [output_manifest_row(images[key]) for key in sorted(image_keys)]
    task_bytes = sum(len(json_bytes(task)) + 1 for task in task_rows)
    manifest_bytes = sum(len(json_bytes(row)) + 1 for row in manifest_rows)
    return {
        "indexes": component,
        "task_count": len(component),
        "image_keys": image_keys,
        "placeholder_names": placeholder_names,
        "image_count": len(image_keys),
        "image_bytes": sum(images[key].size for key in image_keys),
        "task_bytes": task_bytes,
        "manifest_bytes": manifest_bytes,
    }


def fits(pack: dict, component: dict, placeholder_size: int) -> bool:
    extra_placeholders = component["placeholder_names"] - pack["placeholder_names"]
    extra_placeholder_manifest_bytes = sum(
        len(json_bytes(placeholder_manifest_row(name))) + 1
        for name in extra_placeholders
    )
    return (
        pack["image_bytes"] + component["image_bytes"] + len(extra_placeholders) * placeholder_size
        <= PACK_IMAGE_BYTES_LIMIT
        and pack["image_count"] + component["image_count"] + len(extra_placeholders)
        <= PACK_IMAGE_COUNT_LIMIT
        and pack["task_bytes"] + component["task_bytes"] <= JSON_BYTES_LIMIT
        and pack["manifest_bytes"] + component["manifest_bytes"] + extra_placeholder_manifest_bytes
        <= JSON_BYTES_LIMIT
    )


def build_pack_plan(resolved: list[dict], images: dict[str, SourceImage], placeholder_size: int) -> list[dict]:
    dsu = DisjointSet(len(resolved))
    first_task_for_image: dict[str, int] = {}
    for index, item in enumerate(resolved):
        for source_key in set(item["image_keys"]):
            if source_key == "__placeholder__":
                continue
            previous = first_task_for_image.get(source_key)
            if previous is None:
                first_task_for_image[source_key] = index
            else:
                dsu.union(index, previous)

    components_by_root: dict[int, list[int]] = defaultdict(list)
    for index in range(len(resolved)):
        components_by_root[dsu.find(index)].append(index)
    components = [component_stats(indexes, resolved, images) for indexes in components_by_root.values()]
    components.sort(
        key=lambda component: (
            component["image_bytes"],
            component["task_bytes"],
            component["image_count"],
        ),
        reverse=True,
    )

    oversized = [
        component
        for component in components
        if component["image_bytes"] > PACK_IMAGE_BYTES_LIMIT
        or component["image_count"] > PACK_IMAGE_COUNT_LIMIT
        or component["task_bytes"] > JSON_BYTES_LIMIT
        or component["manifest_bytes"] > JSON_BYTES_LIMIT
    ]
    if oversized:
        largest = oversized[0]
        raise RuntimeError(
            "An indivisible task component exceeds a package limit: "
            f"tasks={largest['task_count']} images={largest['image_count']} "
            f"image_bytes={largest['image_bytes']} task_bytes={largest['task_bytes']} "
            f"manifest_bytes={largest['manifest_bytes']}"
        )

    packs: list[dict] = []
    for component in components:
        for pack in packs:
            if fits(pack, component, placeholder_size):
                pack["components"].append(component)
                pack["image_bytes"] += component["image_bytes"]
                pack["image_count"] += component["image_count"]
                pack["task_bytes"] += component["task_bytes"]
                pack["manifest_bytes"] += component["manifest_bytes"]
                pack["task_count"] += component["task_count"]
                new_placeholders = component["placeholder_names"] - pack["placeholder_names"]
                pack["placeholder_names"].update(new_placeholders)
                pack["image_bytes"] += len(new_placeholders) * placeholder_size
                pack["image_count"] += len(new_placeholders)
                pack["manifest_bytes"] += sum(
                    len(json_bytes(placeholder_manifest_row(name))) + 1
                    for name in new_placeholders
                )
                break
        else:
            placeholder_names = set(component["placeholder_names"])
            packs.append(
                {
                    "components": [component],
                    "image_bytes": component["image_bytes"] + len(placeholder_names) * placeholder_size,
                    "image_count": component["image_count"] + len(placeholder_names),
                    "task_bytes": component["task_bytes"],
                    "manifest_bytes": component["manifest_bytes"] + sum(
                        len(json_bytes(placeholder_manifest_row(name))) + 1
                        for name in placeholder_names
                    ),
                    "task_count": component["task_count"],
                    "placeholder_names": placeholder_names,
                }
            )
    return packs


def zip_writestr(archive: zipfile.ZipFile, name: str, content: bytes, compress: bool) -> None:
    entry = zipfile.ZipInfo(name)
    entry.compress_type = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
    archive.writestr(entry, content)


def write_pack(
    pack: dict,
    number: int,
    output_dir: Path,
    resolved: list[dict],
    images: dict[str, SourceImage],
    placeholder_path: Path,
) -> Path:
    image_keys = {
        source_key
        for component in pack["components"]
        for source_key in component["image_keys"]
    }
    task_rows = [
        resolved[index]["task"]
        for component in pack["components"]
        for index in component["indexes"]
    ]
    manifest_rows = [output_manifest_row(images[key]) for key in sorted(image_keys)]
    manifest_rows.extend(
        placeholder_manifest_row(name)
        for name in sorted(pack["placeholder_names"])
    )

    task_document = {"version": 1, "tasks": task_rows}
    manifest_document = {"version": 1, "rows": manifest_rows}
    task_content = json_bytes(task_document)
    manifest_content = json_bytes(manifest_document)
    if len(task_content) >= SERVER_JSON_BYTES_LIMIT or len(manifest_content) >= SERVER_JSON_BYTES_LIMIT:
        raise RuntimeError(f"Package {number} JSON unexpectedly exceeds the server limit")

    target = output_dir / f"v030_relabel_resolved_{number:03d}.zip"
    temporary = target.with_suffix(".zip.tmp")
    if temporary.exists():
        temporary.unlink()
    if target.exists():
        raise RuntimeError(f"Refusing to overwrite existing output {target}")

    grouped_sources: dict[Path, list[SourceImage]] = defaultdict(list)
    for source_key in image_keys:
        grouped_sources[images[source_key].archive].append(images[source_key])

    log(
        f"write pack {number}: tasks={len(task_rows)} "
        f"images={len(image_keys) + len(pack['placeholder_names'])}"
    )
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as output_zip:
        zip_writestr(output_zip, "tasks.json", task_content, compress=True)
        zip_writestr(output_zip, "manifest.json", manifest_content, compress=True)
        placeholder_content = placeholder_path.read_bytes()
        for name in sorted(pack["placeholder_names"]):
            zip_writestr(output_zip, name, placeholder_content, compress=False)
        for archive_path, selected_images in sorted(grouped_sources.items(), key=lambda item: item[0].name):
            with zipfile.ZipFile(archive_path) as source_zip:
                for image in sorted(selected_images, key=lambda item: item.output_name):
                    info = source_zip.getinfo(image.entry_name)
                    output_entry = zipfile.ZipInfo(image.output_name)
                    output_entry.compress_type = zipfile.ZIP_STORED
                    output_entry.external_attr = info.external_attr
                    with source_zip.open(info) as source_file:
                        output_zip.writestr(output_entry, source_file.read())

    temporary.replace(target)
    return target


def validate_pack(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        bad_entry = archive.testzip()
        if bad_entry:
            raise RuntimeError(f"ZIP CRC validation failed for {path.name}: {bad_entry}")
        names = archive.namelist()
        if names.count("tasks.json") != 1 or names.count("manifest.json") != 1:
            raise RuntimeError(f"{path.name} has invalid root JSON entries")
        task_content = archive.read("tasks.json")
        manifest_content = archive.read("manifest.json")
        if len(task_content) >= SERVER_JSON_BYTES_LIMIT or len(manifest_content) >= SERVER_JSON_BYTES_LIMIT:
            raise RuntimeError(f"{path.name} JSON exceeds 64MiB")
        task_document = json.loads(task_content)
        manifest_document = json.loads(manifest_content)
        if not isinstance(task_document.get("tasks"), list) or not isinstance(manifest_document.get("rows"), list):
            raise RuntimeError(f"{path.name} JSON root format is invalid")
        images = [name for name in names if Path(name).suffix.lower() in IMAGE_EXTENSIONS]
        if len(images) >= 50_000:
            raise RuntimeError(f"{path.name} has too many images: {len(images)}")
        image_set = set(images)
        task_ids: set[str] = set()
        task_groups: set[str] = set()
        for task in task_document["tasks"]:
            task_id = str(task.get("id", ""))
            if not task_id or task_id in task_ids:
                raise RuntimeError(f"{path.name} has an invalid or duplicate task id")
            task_ids.add(task_id)
            references = [item.get("src_rel_path") for item in task.get("images", []) if isinstance(item, dict)]
            if len(references) != 5 or len(set(references)) != 5 or not all(reference in image_set for reference in references):
                raise RuntimeError(f"{path.name} contains a task with missing/duplicate images")
            group = f"{task.get('criterion')}|{'|'.join(sorted(references))}"
            if group in task_groups:
                raise RuntimeError(f"{path.name} contains duplicate task groups")
            task_groups.add(group)
        manifest_paths = {
            str(row.get("src_rel_path", ""))
            for row in manifest_document["rows"]
            if isinstance(row, dict)
        }
        if not image_set.issubset(manifest_paths):
            missing = sorted(image_set - manifest_paths)[:3]
            raise RuntimeError(f"{path.name} manifest misses image rows: {missing}")
    if path.stat().st_size >= SERVER_ZIP_BYTES_LIMIT:
        raise RuntimeError(f"{path.name} exceeds 20GiB")
    return {
        "zip": path.name,
        "zip_bytes": path.stat().st_size,
        "tasks": len(task_document["tasks"]),
        "images": len(images),
        "tasks_json_bytes": len(task_content),
        "manifest_json_bytes": len(manifest_content),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--processed", type=Path, required=True)
    parser.add_argument("--placeholder", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--build", action="store_true")
    args = parser.parse_args()

    if not args.placeholder.is_file():
        raise RuntimeError(f"Placeholder image not found: {args.placeholder}")
    with args.tasks.open("r", encoding="utf-8") as source:
        document = json.load(source)
    tasks = document.get("tasks") if isinstance(document, dict) else document
    if not isinstance(tasks, list):
        raise RuntimeError("tasks.json must contain a tasks array")

    images, path_index, basename_index, case_model_index = load_source_images(args.processed)
    resolved, match_counts, missing_examples = build_resolved_tasks(
        tasks,
        images,
        path_index,
        basename_index,
        case_model_index,
    )
    packs = build_pack_plan(resolved, images, args.placeholder.stat().st_size)
    plan = {
        "source_task_count": len(tasks),
        "resolved_task_count": len(resolved),
        "unresolved_task_count": len(tasks) - len(resolved),
        "match_counts": dict(match_counts),
        "missing_examples": missing_examples,
        "pack_count": len(packs),
        "packs": [
            {
                "number": number,
                "tasks": pack["task_count"],
                "images": pack["image_count"],
                "image_bytes": pack["image_bytes"],
                "task_bytes_estimate": pack["task_bytes"],
                "manifest_bytes_estimate": pack["manifest_bytes"],
                "components": len(pack["components"]),
            }
            for number, pack in enumerate(packs, start=1)
        ],
    }
    print(json.dumps(plan, ensure_ascii=False, indent=2), flush=True)
    if not args.build:
        return

    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "plan.json").write_bytes(json_bytes(plan))
    validations = []
    for number, pack in enumerate(packs, start=1):
        output = write_pack(pack, number, args.output, resolved, images, args.placeholder)
        validation = validate_pack(output)
        validations.append(validation)
        log("validated", json.dumps(validation, ensure_ascii=False))
    (args.output / "validation.json").write_bytes(json_bytes(validations))
    log("completed", f"packs={len(validations)} tasks={sum(item['tasks'] for item in validations)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr, flush=True)
        raise
