from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
import sys
import time
import zipfile
import zlib
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path


MAX_ZIP_BYTES = 21_206_401_024
MAX_JSON_BYTES = 67_108_863
MAX_ENTRIES = 48_999
ZIP64_END_BYTES = 98
IMAGE_DATA_DESCRIPTOR_BYTES = 0
COPY_BUFFER = 16 * 1024 * 1024


@dataclass(frozen=True)
class SourceRecord:
    kind: str
    path: str
    internal: str | None
    size: int
    crc: int | None
    date_time: tuple[int, int, int, int, int, int]
    offset: int | None = None
    compressed_size: int | None = None
    compress_type: int | None = None
    flag_bits: int = 0


class UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        a = self.find(a)
        b = self.find(b)
        if a == b:
            return
        if self.rank[a] < self.rank[b]:
            a, b = b, a
        self.parent[b] = a
        if self.rank[a] == self.rank[b]:
            self.rank[a] += 1


def read_json(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def json_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def nested_json_block_bytes(value) -> int:
    """Bytes for one item nested four spaces inside a top-level JSON array."""
    raw = json.dumps(value, ensure_ascii=False, indent=2)
    nested = "\n".join("    " + line for line in raw.splitlines())
    return len(nested.encode("utf-8"))


def json_array_document_size(kind: str, item_bytes: int, count: int) -> int:
    if kind == "tasks":
        prefix = '{\n  "version": 1,\n  "tasks": [\n'
    elif kind == "rows":
        prefix = '{\n  "rows": [\n'
    else:
        raise ValueError(kind)
    suffix = "\n  ]\n}\n"
    return len(prefix.encode("utf-8")) + item_bytes + max(0, count - 1) * 2 + len(suffix.encode("utf-8"))


def candidate_source_names(src: str) -> list[str]:
    out = [src]
    prefix = "cci_images_20261029/"
    if src.startswith(prefix):
        out.append(src[len(prefix):])
    else:
        out.append(prefix + src)
    return list(dict.fromkeys(out))


def zip_name_bytes(name: str) -> int:
    return len(name.encode("utf-8"))


def _zip_datetime(mod_time: int, mod_date: int) -> tuple[int, int, int, int, int, int]:
    return (
        ((mod_date >> 9) & 0x7F) + 1980,
        (mod_date >> 5) & 0x0F,
        mod_date & 0x1F,
        (mod_time >> 11) & 0x1F,
        (mod_time >> 5) & 0x3F,
        (mod_time & 0x1F) * 2,
    )


def _zip_central_bounds(path: Path) -> tuple[int, int, int]:
    """Return (central directory offset, size, entry count) without ZipInfo objects."""
    size = path.stat().st_size
    tail_size = min(size, 0x10000 + 128)
    with path.open("rb") as f:
        f.seek(size - tail_size)
        tail = f.read(tail_size)
    eocd_pos = tail.rfind(b"PK\x05\x06")
    if eocd_pos < 0:
        raise RuntimeError(f"ZIP end record not found: {path}")
    _, disk, cd_disk, entries_disk, entries, cd_size, cd_offset, comment_len = struct.unpack_from(
        "<4s4H2LH", tail, eocd_pos
    )
    if entries != 0xFFFF and cd_size != 0xFFFFFFFF and cd_offset != 0xFFFFFFFF:
        return cd_offset, cd_size, entries
    loc_pos = tail.rfind(b"PK\x06\x07", 0, eocd_pos)
    if loc_pos < 0:
        raise RuntimeError(f"ZIP64 locator not found: {path}")
    _, _, zip64_offset, _ = struct.unpack_from("<4sLQL", tail, loc_pos)
    with path.open("rb") as f:
        f.seek(zip64_offset)
        header = f.read(56)
    sig, record_size, ver_made, ver_needed, disk_no, cd_disk_no, entries_disk64, entries64, cd_size64, cd_offset64 = struct.unpack(
        "<4sQ2H2L4Q", header
    )
    if sig != b"PK\x06\x06":
        raise RuntimeError(f"invalid ZIP64 end record: {path}")
    return cd_offset64, cd_size64, entries64


def _iter_needed_zip_entries(path: Path, variants: dict[str, str]):
    """Yield only manifest-referenced central-directory entries.

    This avoids materializing millions of ZipInfo objects from the large legacy
    archive. Images in the source archives are stored or deflated; the local
    header offset is retained for streaming the selected entry later.
    """
    central_offset, central_size, entry_count = _zip_central_bounds(path)
    with path.open("rb") as f:
        f.seek(central_offset)
        for _ in range(entry_count):
            header = f.read(46)
            if len(header) != 46:
                raise RuntimeError(f"truncated central directory: {path}")
            fields = struct.unpack("<4s6H3L5H2L", header)
            (
                sig,
                version_made,
                version_needed,
                flag_bits,
                compress_type,
                mod_time,
                mod_date,
                crc,
                compressed_size,
                file_size,
                name_len,
                extra_len,
                comment_len,
                disk_start,
                internal_attr,
                external_attr,
                local_offset,
            ) = fields
            if sig != b"PK\x01\x02":
                raise RuntimeError(f"invalid central directory entry: {path}")
            raw_name = f.read(name_len)
            raw_extra = f.read(extra_len)
            f.seek(comment_len, os.SEEK_CUR)
            # ZIP64 central-directory extra field replaces 32-bit sentinel
            # values for entries whose local data is past the 4 GiB boundary.
            if 0xFFFFFFFF in (compressed_size, file_size, local_offset) or disk_start == 0xFFFF:
                pos = 0
                while pos + 4 <= len(raw_extra):
                    header_id, data_size = struct.unpack_from("<HH", raw_extra, pos)
                    pos += 4
                    data_end = pos + data_size
                    if data_end > len(raw_extra):
                        break
                    if header_id == 0x0001:
                        if file_size == 0xFFFFFFFF:
                            file_size = struct.unpack_from("<Q", raw_extra, pos)[0]
                            pos += 8
                        if compressed_size == 0xFFFFFFFF:
                            compressed_size = struct.unpack_from("<Q", raw_extra, pos)[0]
                            pos += 8
                        if local_offset == 0xFFFFFFFF:
                            local_offset = struct.unpack_from("<Q", raw_extra, pos)[0]
                            pos += 8
                        if disk_start == 0xFFFF:
                            disk_start = struct.unpack_from("<L", raw_extra, pos)[0]
                        break
                    pos = data_end
            encoding = "utf-8" if flag_bits & 0x800 else "cp437"
            name = raw_name.decode(encoding)
            src = variants.get(name)
            if src is None:
                continue
            yield src, SourceRecord(
                "zip",
                str(path),
                name,
                file_size,
                crc,
                _zip_datetime(mod_time, mod_date),
                offset=local_offset,
                compressed_size=compressed_size,
                compress_type=compress_type,
                flag_bits=flag_bits,
            )


def json_entry_size(name: str, payload_size: int) -> int:
    n = zip_name_bytes(name)
    return 30 + n + payload_size + 46 + n


def image_entry_size(name: str, payload_size: int) -> int:
    n = zip_name_bytes(name)
    return 30 + n + payload_size + IMAGE_DATA_DESCRIPTOR_BYTES + 46 + n


def build_source_index(
    group_dir: Path,
    manifest_rows: list[dict],
    source_reference: dict,
    source_root: Path,
) -> dict[str, SourceRecord]:
    wanted = {row["src_rel_path"] for row in manifest_rows}
    variants: dict[str, str] = {}
    for src in wanted:
        for name in candidate_source_names(src):
            variants.setdefault(name, src)

    found: dict[str, SourceRecord] = {}
    for item in source_reference.get("zip_files", []):
        if item.get("status_at_document_export") not in (None, "complete"):
            raise RuntimeError(
                f"source archive is not complete: {item.get('relative_zip_path')}"
            )
        zp = source_root / item["relative_zip_path"]
        if not zp.is_file():
            raise FileNotFoundError(f"source ZIP not found: {zp}")
        print(f"[index] {zp}", flush=True)
        for src, rec in _iter_needed_zip_entries(zp, variants):
            # Prefer the first exact archive match. Duplicate references are
            # expected in the source set, but their bytes must agree.
            old = found.get(src)
            if old is None:
                found[src] = rec
            elif old.size != rec.size or old.crc != rec.crc:
                raise RuntimeError(f"conflicting source copies for {src}")

    loose_dirs = source_reference.get("loose_original_directories", {})
    for rel_dir in loose_dirs:
        root = source_root / rel_dir
        if not root.exists():
            raise FileNotFoundError(f"loose source directory not found: {root}")
        prefix = rel_dir.replace("\\", "/")
        # Enumerate each loose directory once. Checking 90k individual paths
        # on a removable drive is much slower than one directory walk.
        for dirpath, _, filenames in os.walk(root):
            for filename in filenames:
                fp = Path(dirpath) / filename
                src = (prefix.rstrip("/") + "/" + fp.relative_to(root).as_posix())
                if src not in wanted or src in found:
                    continue
                st = fp.stat()
                found[src] = SourceRecord(
                    "file",
                    str(fp),
                    None,
                    st.st_size,
                    None,
                    (1980, 1, 1, 0, 0, 0),
                )

    missing = sorted(wanted - found.keys())
    if missing:
        raise RuntimeError(f"missing {len(missing)} images; first: {missing[:5]}")
    return found


def make_components(tasks: list[dict]) -> list[dict]:
    uf = UnionFind(len(tasks))
    owner: dict[str, int] = {}
    for i, task in enumerate(tasks):
        for image in task["images"]:
            src = image["src_rel_path"]
            if src in owner:
                uf.union(i, owner[src])
            else:
                owner[src] = i
    grouped: dict[int, list[int]] = defaultdict(list)
    for i in range(len(tasks)):
        grouped[uf.find(i)].append(i)

    components = []
    for indices in grouped.values():
        indices.sort()
        images = []
        seen = set()
        for i in indices:
            for image in tasks[i]["images"]:
                src = image["src_rel_path"]
                if src not in seen:
                    seen.add(src)
                    images.append(src)
        components.append(
            {
                "task_indices": indices,
                "images": images,
                "first_task": indices[0],
            }
        )
    components.sort(key=lambda c: c["first_task"])
    return components


def package_payload(
    task_indices: list[int],
    image_names: list[str],
    tasks: list[dict],
    manifest_by_src: dict[str, dict],
    source_index: dict[str, SourceRecord],
) -> tuple[dict, dict, bytes, bytes, int]:
    selected_tasks = {"version": 1, "tasks": [tasks[i] for i in task_indices]}
    selected_rows = [manifest_by_src[src] for src in image_names]
    selected_manifest = {"rows": selected_rows}
    task_data = json_bytes(selected_tasks)
    manifest_data = json_bytes(selected_manifest)
    size = json_entry_size("tasks.json", len(task_data))
    size += json_entry_size("manifest.json", len(manifest_data))
    for src in image_names:
        row = manifest_by_src[src]
        rec = source_index[src]
        size += image_entry_size(row["dest_rel_path"], rec.size)
    size += ZIP64_END_BYTES
    return selected_tasks, selected_manifest, task_data, manifest_data, size


def form_packages(
    tasks: list[dict],
    manifest_rows: list[dict],
    source_index: dict[str, SourceRecord],
    zip_limit: int = MAX_ZIP_BYTES,
) -> list[dict]:
    manifest_by_src = {row["src_rel_path"]: row for row in manifest_rows}
    if len(manifest_by_src) != len(manifest_rows):
        raise RuntimeError("manifest contains duplicate src_rel_path values")
    for task in tasks:
        for image in task["images"]:
            if image["src_rel_path"] not in manifest_by_src:
                raise RuntimeError(
                    f"task image absent from manifest: {image['src_rel_path']}"
                )

    components = make_components(tasks)
    task_block_sizes = [nested_json_block_bytes(task) for task in tasks]
    manifest_block_sizes = {
        src: nested_json_block_bytes(row) for src, row in manifest_by_src.items()
    }
    for component in components:
        component["task_json_item_bytes"] = sum(task_block_sizes[i] for i in component["task_indices"])
        component["manifest_json_item_bytes"] = sum(manifest_block_sizes[src] for src in component["images"])
        component["image_zip_bytes"] = sum(
            image_entry_size(manifest_by_src[src]["dest_rel_path"], source_index[src].size)
            for src in component["images"]
        )
    packages: list[dict] = []
    current_tasks: list[int] = []
    current_images: list[str] = []
    current_image_set: set[str] = set()
    current_task_json_item_bytes = 0
    current_manifest_json_item_bytes = 0
    current_image_zip_bytes = 0

    def add_component(component: dict, tasks_out: list[int], images_out: list[str], image_set: set[str]):
        tasks_out.extend(component["task_indices"])
        for src in component["images"]:
            if src not in image_set:
                image_set.add(src)
                images_out.append(src)

    def finalize(tasks_out: list[int], images_out: list[str]):
        selected_tasks, selected_manifest, task_data, manifest_data, size = package_payload(
            tasks_out, images_out, tasks, manifest_by_src, source_index
        )
        if len(task_data) > MAX_JSON_BYTES or len(manifest_data) > MAX_JSON_BYTES:
            raise RuntimeError("JSON limit exceeded")
        if len(images_out) + 2 > MAX_ENTRIES:
            raise RuntimeError("entry limit exceeded")
        packages.append(
            {
                "task_indices": list(tasks_out),
                "image_sources": list(images_out),
                "task_count": len(tasks_out),
                "image_count": len(images_out),
                "entry_count": len(images_out) + 2,
                "tasks_json_bytes": len(task_data),
                "manifest_json_bytes": len(manifest_data),
                "estimated_zip_bytes": size,
                "selected_tasks": selected_tasks,
                "selected_manifest": selected_manifest,
                "tasks_data": task_data,
                "manifest_data": manifest_data,
            }
        )

    for component in components:
        trial_tasks = list(current_tasks)
        trial_images = list(current_images)
        trial_set = set(current_image_set)
        add_component(component, trial_tasks, trial_images, trial_set)
        trial_task_item_bytes = current_task_json_item_bytes + component["task_json_item_bytes"]
        trial_manifest_item_bytes = current_manifest_json_item_bytes + component["manifest_json_item_bytes"]
        trial_image_zip_bytes = current_image_zip_bytes + component["image_zip_bytes"]
        trial_task_json_bytes = json_array_document_size("tasks", trial_task_item_bytes, len(trial_tasks))
        trial_manifest_json_bytes = json_array_document_size("rows", trial_manifest_item_bytes, len(trial_images))
        trial_size = (
            json_entry_size("tasks.json", trial_task_json_bytes)
            + json_entry_size("manifest.json", trial_manifest_json_bytes)
            + trial_image_zip_bytes
            + ZIP64_END_BYTES
        )
        trial_ok = (
            trial_size <= zip_limit
            and trial_task_json_bytes <= MAX_JSON_BYTES
            and trial_manifest_json_bytes <= MAX_JSON_BYTES
            and len(trial_images) + 2 <= MAX_ENTRIES
        )
        if current_tasks and not trial_ok:
            finalize(current_tasks, current_images)
            current_tasks = []
            current_images = []
            current_image_set = set()
            current_task_json_item_bytes = 0
            current_manifest_json_item_bytes = 0
            current_image_zip_bytes = 0
            trial_tasks = list(component["task_indices"])
            trial_images = list(component["images"])
            trial_set = set(trial_images)
            trial_task_item_bytes = component["task_json_item_bytes"]
            trial_manifest_item_bytes = component["manifest_json_item_bytes"]
            trial_image_zip_bytes = component["image_zip_bytes"]
            trial_task_json_bytes = json_array_document_size("tasks", trial_task_item_bytes, len(trial_tasks))
            trial_manifest_json_bytes = json_array_document_size("rows", trial_manifest_item_bytes, len(trial_images))
            trial_size = (
                json_entry_size("tasks.json", trial_task_json_bytes)
                + json_entry_size("manifest.json", trial_manifest_json_bytes)
                + trial_image_zip_bytes
                + ZIP64_END_BYTES
            )
            if not (
                trial_size <= zip_limit
                and trial_task_json_bytes <= MAX_JSON_BYTES
                and trial_manifest_json_bytes <= MAX_JSON_BYTES
                and len(trial_images) + 2 <= MAX_ENTRIES
            ):
                raise RuntimeError("one connected component exceeds package limits")
        current_tasks, current_images, current_image_set = trial_tasks, trial_images, trial_set
        current_task_json_item_bytes = trial_task_item_bytes
        current_manifest_json_item_bytes = trial_manifest_item_bytes
        current_image_zip_bytes = trial_image_zip_bytes
    if current_tasks:
        finalize(current_tasks, current_images)
    return packages


def write_json_progress(path: Path, value: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def source_index_cache_path(output_root: Path, group_name: str) -> Path:
    return output_root / f".{group_name}_source_index.json"


def load_source_index_cache(path: Path) -> dict[str, SourceRecord] | None:
    if not path.exists():
        return None
    try:
        raw = read_json(path)
        result = {}
        for src, value in raw.items():
            result[src] = SourceRecord(
                value["kind"],
                value["path"],
                value.get("internal"),
                value["size"],
                value.get("crc"),
                tuple(value.get("date_time", (1980, 1, 1, 0, 0, 0))),
                value.get("offset"),
                value.get("compressed_size"),
                value.get("compress_type"),
                value.get("flag_bits", 0),
            )
        return result
    except Exception as exc:
        print(f"[cache] ignoring invalid source index {path}: {exc}", flush=True)
        return None


def save_source_index_cache(path: Path, source_index: dict[str, SourceRecord]) -> None:
    value = {
        src: {
            "kind": rec.kind,
            "path": rec.path,
            "internal": rec.internal,
            "size": rec.size,
            "crc": rec.crc,
            "date_time": list(rec.date_time),
            "offset": rec.offset,
            "compressed_size": rec.compressed_size,
            "compress_type": rec.compress_type,
            "flag_bits": rec.flag_bits,
        }
        for src, rec in source_index.items()
    }
    write_json_progress(path, value)


def copy_image(out_zip: zipfile.ZipFile, out_name: str, record: SourceRecord, cache: dict[str, zipfile.ZipFile]) -> None:
    zi = zipfile.ZipInfo(out_name, date_time=record.date_time)
    zi.compress_type = zipfile.ZIP_STORED
    zi.create_system = 0
    zi.external_attr = 0o644 << 16
    with out_zip.open(zi, "w") as dst:
        if record.kind == "file":
            with open(record.path, "rb") as src:
                shutil.copyfileobj(src, dst, COPY_BUFFER)
        else:
            f = cache.get(record.path)
            if f is None:
                f = open(record.path, "rb")
                cache[record.path] = f
            f.seek(record.offset)
            local = f.read(30)
            if len(local) != 30 or local[:4] != b"PK\x03\x04":
                raise RuntimeError(f"invalid local header for {record.path}:{record.internal}")
            name_len, extra_len = struct.unpack_from("<HH", local, 26)
            f.seek(name_len + extra_len, os.SEEK_CUR)
            compressed_size = record.compressed_size or 0
            if record.compress_type == zipfile.ZIP_STORED:
                remaining = compressed_size
                while remaining:
                    chunk = f.read(min(COPY_BUFFER, remaining))
                    if not chunk:
                        raise RuntimeError(f"truncated image entry: {record.path}:{record.internal}")
                    dst.write(chunk)
                    remaining -= len(chunk)
            elif record.compress_type == zipfile.ZIP_DEFLATED:
                decompressor = zlib.decompressobj(-15)
                remaining = compressed_size
                while remaining:
                    chunk = f.read(min(COPY_BUFFER, remaining))
                    if not chunk:
                        raise RuntimeError(f"truncated compressed entry: {record.path}:{record.internal}")
                    remaining -= len(chunk)
                    data = decompressor.decompress(chunk)
                    if data:
                        dst.write(data)
                tail = decompressor.flush()
                if tail:
                    dst.write(tail)
            else:
                raise RuntimeError(f"unsupported source compression {record.compress_type}: {record.path}:{record.internal}")


def validate_package(path: Path, expected: dict) -> dict:
    with zipfile.ZipFile(path, "r") as zf:
        infos = zf.infolist()
        names = {i.filename for i in infos}
        if len(infos) != expected["entry_count"]:
            raise RuntimeError(f"{path.name}: entry count mismatch")
        if "tasks.json" not in names or "manifest.json" not in names:
            raise RuntimeError(f"{path.name}: missing JSON files")
        tasks_doc = json.loads(zf.read("tasks.json"))
        manifest_doc = json.loads(zf.read("manifest.json"))
        if not isinstance(tasks_doc.get("tasks"), list) or not isinstance(manifest_doc.get("rows"), list):
            raise RuntimeError(f"{path.name}: invalid JSON shape")
        if len(tasks_doc["tasks"]) != expected["task_count"] or len(manifest_doc["rows"]) != expected["image_count"]:
            raise RuntimeError(f"{path.name}: JSON count mismatch")
        missing = [row["dest_rel_path"] for row in manifest_doc["rows"] if row["dest_rel_path"] not in names]
        if missing:
            raise RuntimeError(f"{path.name}: missing image entries: {missing[:3]}")
        task_refs = {im["src_rel_path"] for task in tasks_doc["tasks"] for im in task["images"]}
        manifest_refs = {row["src_rel_path"] for row in manifest_doc["rows"]}
        if not task_refs.issubset(manifest_refs):
            raise RuntimeError(f"{path.name}: task references absent from manifest")
        actual = path.stat().st_size
        if actual > MAX_ZIP_BYTES:
            raise RuntimeError(f"{path.name}: ZIP exceeds limit: {actual}")
        return {"bytes": actual, "entries": len(infos), "tasks": len(tasks_doc["tasks"]), "images": len(manifest_doc["rows"])}


def process_group(group_name: str, group_plan: dict, plan_path: Path, source_root: Path, output_root: Path, dry_run: bool, max_packages: int | None, zip_limit: int) -> None:
    group_dir = Path(group_plan["source_directory"])
    if not group_dir.is_absolute():
        group_dir = source_root / group_dir
    # The plan was made from the drive root. Resolve a stale relative E:\ prefix
    # without changing the plan file itself.
    group_dir = source_root / Path("new_saturation_tasks_20261030") / Path(group_name)
    tasks = read_json(group_dir / "tasks.json")["tasks"]
    manifest_rows = read_json(group_dir / "manifest.json")["rows"]
    cache_path = source_index_cache_path(output_root, group_name)
    source_index = load_source_index_cache(cache_path)
    if source_index is None:
        source_index = build_source_index(group_dir, manifest_rows, group_plan["source_reference"], source_root)
        save_source_index_cache(cache_path, source_index)
        print(f"[cache] saved {cache_path.name}", flush=True)
    else:
        print(f"[cache] loaded {cache_path.name}", flush=True)
    packages = form_packages(tasks, manifest_rows, source_index, zip_limit=zip_limit)
    print(f"[plan] {group_name}: components={len(make_components(tasks))} packages={len(packages)}", flush=True)
    for i, p in enumerate(packages, 1):
        print(
            f"[plan] {group_name} part {i:02d}: tasks={p['task_count']} images={p['image_count']} "
            f"entries={p['entry_count']} est={p['estimated_zip_bytes']:,}",
            flush=True,
        )
    if dry_run:
        return

    output_dir = output_root / group_name
    output_dir.mkdir(parents=True, exist_ok=True)
    progress_path = output_root / "packing_progress.json"
    already = {}
    if progress_path.exists():
        try:
            already = read_json(progress_path).get("groups", {}).get(group_name, {})
        except Exception:
            already = {}
    limit = len(packages) if max_packages is None else min(max_packages, len(packages))
    for part_no, package in enumerate(packages[:limit], 1):
        final_path = output_dir / f"{group_name}_part_{part_no:02d}.zip"
        partial_path = final_path.with_suffix(".zip.partial")
        if final_path.exists():
            try:
                result = validate_package(final_path, package)
                print(f"[skip] validated {final_path.name}: {result}", flush=True)
                already[str(part_no)] = {"status": "complete", **result}
                continue
            except Exception as exc:
                print(f"[repair] removing invalid {final_path.name}: {exc}", flush=True)
                final_path.unlink()
        if partial_path.exists():
            print(f"[repair] removing incomplete {partial_path.name}", flush=True)
            partial_path.unlink()

        free = shutil.disk_usage(output_root.anchor or str(output_root)).free
        required = package["estimated_zip_bytes"] + 2 * 1024**3
        if free < required:
            print(f"[pause] insufficient space before part {part_no}: free={free:,} required={required:,}", flush=True)
            break
        print(f"[write] {final_path.name}: {package['estimated_zip_bytes']:,} bytes estimated; free={free:,}", flush=True)
        started = time.time()
        cache: dict[str, zipfile.ZipFile] = {}
        try:
            with zipfile.ZipFile(partial_path, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as out_zip:
                out_zip.writestr("tasks.json", package["tasks_data"], compress_type=zipfile.ZIP_STORED)
                out_zip.writestr("manifest.json", package["manifest_data"], compress_type=zipfile.ZIP_STORED)
                for j, src in enumerate(package["image_sources"], 1):
                    row = {"src": src, "dest": next(r["dest_rel_path"] for r in package["selected_manifest"]["rows"] if r["src_rel_path"] == src)}
                    copy_image(out_zip, row["dest"], source_index[src], cache)
                    if j == 1 or j % 250 == 0 or j == package["image_count"]:
                        elapsed = max(time.time() - started, 0.001)
                        print(f"[write] {final_path.name}: {j}/{package['image_count']} images, {j/elapsed:.1f}/s", flush=True)
        finally:
            for zf in cache.values():
                zf.close()
        os.replace(partial_path, final_path)
        result = validate_package(final_path, package)
        print(f"[done] {final_path.name}: {result}, elapsed={time.time()-started:.1f}s", flush=True)
        already[str(part_no)] = {"status": "complete", **result}
        state = {"updated_at": time.time(), "groups": {group_name: already}}
        write_json_progress(progress_path, state)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", default=r"D:\images\saturation_packages_20261030\packing_plan.json")
    parser.add_argument("--source-root", default="E:\\")
    parser.add_argument("--output-root", default=r"D:\images\saturation_packages_20261030")
    parser.add_argument("--group", choices=["new_model_pairs", "part_a_original_pairs"])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-packages", type=int)
    parser.add_argument("--size-margin", type=int, default=0, help="reserve this many bytes below the ZIP limit")
    args = parser.parse_args()
    plan_path = Path(args.plan)
    plan_value = read_json(plan_path)
    if isinstance(plan_value, list):
        plan = {item["group"]: item for item in plan_value}
    else:
        plan = plan_value
    source_root = Path(args.source_root)
    output_root = Path(args.output_root)
    groups = [args.group] if args.group else ["new_model_pairs", "part_a_original_pairs"]
    zip_limit = MAX_ZIP_BYTES - args.size_margin
    if zip_limit <= 0:
        raise SystemExit("--size-margin is too large")
    for group in groups:
        process_group(group, plan[group], plan_path, source_root, output_root, args.dry_run, args.max_packages, zip_limit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
