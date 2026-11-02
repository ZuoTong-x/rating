from __future__ import annotations

import argparse
import io
import json
import re
import sys
import tarfile
from datetime import date
from pathlib import Path

from PIL import Image


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}
CASE_FILE_RE = re.compile(r"^(?P<prefix>.+?)-(?P<number>\d+)(?:-(?P<suffix>.+))?$")


def case_id_from_filename(name: str) -> str | None:
    match = CASE_FILE_RE.match(Path(name).stem)
    if not match:
        return None
    case_id = f"{match.group('prefix')}:{match.group('number')}"
    if match.group("suffix"):
        case_id += f":{match.group('suffix')}"
    return case_id


def load_sources(manifest_path: Path, tasks_path: Path):
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    with tasks_path.open("r", encoding="utf-8") as handle:
        tasks_doc = json.load(handle)

    cases = {case["case_id"]: case for case in manifest["cases"]}
    tasks = {task["id"]: task for task in tasks_doc["tasks"]}
    return cases, tasks


def encode_webp(data: bytes, quality: int) -> bytes:
    with Image.open(io.BytesIO(data)) as image:
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        output = io.BytesIO()
        image.save(output, format="WEBP", quality=quality, method=4)
        return output.getvalue()


def image_count(archive_path: Path) -> int:
    count = 0
    with tarfile.open(archive_path, mode="r:*") as archive:
        for member in archive:
            if member.isfile() and Path(member.name).suffix.lower() in IMAGE_SUFFIXES:
                count += 1
    return count


def convert_archive(
    archive_path: Path,
    output_dir: Path,
    stamp: str,
    cases: dict,
    tasks: dict,
    quality: int,
) -> tuple[Path, int, int]:
    count = image_count(archive_path)
    output_path = output_dir / f"{archive_path.stem}_{stamp}_{count}.tar"
    if output_path.exists():
        return output_path, count, -1

    temporary_path = output_dir / f".{archive_path.stem}_{stamp}_{count}.tar.partial"
    if temporary_path.exists():
        temporary_path.unlink()

    records = []
    unmatched = 0
    root = None
    with tarfile.open(archive_path, mode="r:*") as source, tarfile.open(
        temporary_path, mode="w"
    ) as target:
        for member in source:
            if root is None:
                root = member.name.split("/", 1)[0]

            if not member.isfile() or Path(member.name).suffix.lower() not in IMAGE_SUFFIXES:
                target.addfile(member, source.extractfile(member) if member.size else None)
                continue

            payload = source.extractfile(member)
            if payload is None:
                raise RuntimeError(f"Cannot read archive member: {member.name}")
            webp_data = encode_webp(payload.read(), quality)
            webp_name = str(Path(member.name).with_suffix(".webp")).replace("\\", "/")
            webp_info = tarfile.TarInfo(webp_name)
            webp_info.size = len(webp_data)
            webp_info.mode = member.mode
            webp_info.mtime = member.mtime
            target.addfile(webp_info, io.BytesIO(webp_data))

            case_id = case_id_from_filename(Path(member.name).name)
            case = cases.get(case_id) if case_id else None
            if case is None:
                unmatched += 1
                records.append(
                    {
                        "archive_filename": member.name,
                        "webp_filename": webp_name,
                        "case_id": case_id,
                        "case": None,
                        "tasks": [],
                    }
                )
                continue

            case_tasks = [
                tasks[task_id]
                for task_id in case.get("task_ids", {}).values()
                if task_id in tasks
            ]
            records.append(
                {
                    "archive_filename": member.name,
                    "webp_filename": webp_name,
                    "case_id": case_id,
                    "case": case,
                    "tasks": case_tasks,
                }
            )

        metadata_name = f"{root}/metadata.json" if root else "metadata.json"
        metadata = {
            "schema_version": 1,
            "source_archive": archive_path.name,
            "source_manifest": "manifest.json",
            "source_tasks": "tasks.json",
            "conversion": {"format": "webp", "quality": quality},
            "image_count": count,
            "matched_count": count - unmatched,
            "unmatched_count": unmatched,
            "records": records,
        }
        metadata_bytes = json.dumps(
            metadata, ensure_ascii=False, indent=2, separators=(",", ": ")
        ).encode("utf-8")
        metadata_info = tarfile.TarInfo(metadata_name)
        metadata_info.size = len(metadata_bytes)
        metadata_info.mode = 0o644
        target.addfile(metadata_info, io.BytesIO(metadata_bytes))

    temporary_path.replace(output_path)
    return output_path, count, unmatched


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--quality", type=int, default=90)
    parser.add_argument(
        "--archive-name",
        action="append",
        help="Process only the named archive; may be supplied more than once.",
    )
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    cases, tasks = load_sources(args.manifest, args.tasks)
    stamp = date.today().strftime("%Y%m%d")
    if args.archive_name:
        archives = [args.input_dir / name for name in args.archive_name]
    else:
        archives = sorted(args.input_dir.glob("*.tar"))
    if not archives:
        print("No .tar archives found", file=sys.stderr)
        return 1

    print(f"archives={len(archives)} cases={len(cases)} tasks={len(tasks)}", flush=True)
    for index, archive_path in enumerate(archives, start=1):
        output_path, count, result = convert_archive(
            archive_path, args.output_dir, stamp, cases, tasks, args.quality
        )
        if result == -1:
            print(f"[{index}/{len(archives)}] SKIP {output_path.name}", flush=True)
        else:
            print(
                f"[{index}/{len(archives)}] DONE {output_path.name} "
                f"images={count} unmatched={result}",
                flush=True,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
