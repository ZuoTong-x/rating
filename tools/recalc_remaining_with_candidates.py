#!/usr/bin/env python3
"""Recalculate unresolved tasks using existing imported packs and extra candidate archives."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path


def load_tasks(path: Path) -> list[dict]:
    document = json.loads(path.read_text(encoding="utf-8"))
    tasks = document.get("tasks") if isinstance(document, dict) else document
    if not isinstance(tasks, list):
        raise RuntimeError(f"Invalid tasks document: {path}")
    return tasks


def task_ids_from_archive(path: Path) -> set[str]:
    with zipfile.ZipFile(path) as archive:
        document = json.loads(archive.read("tasks.json"))
    tasks = document.get("tasks") if isinstance(document, dict) else document
    return {str(task.get("id", "")) for task in tasks if isinstance(task, dict)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--imported", type=Path, nargs="+", required=True)
    parser.add_argument("--archives", type=Path, nargs="+", required=True)
    parser.add_argument("--builder", type=Path, required=True)
    parser.add_argument("--placeholder", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    args = parser.parse_args()

    args.work.mkdir(parents=True, exist_ok=True)
    remaining_path = args.work / "remaining_tasks.json"
    source_dir = args.work / "combined_source_archives"
    if source_dir.exists():
        shutil.rmtree(source_dir)
    source_dir.mkdir()

    imported_ids: set[str] = set()
    for archive in args.imported:
        imported_ids.update(task_ids_from_archive(archive))

    tasks = load_tasks(args.tasks)
    remaining = [task for task in tasks if str(task.get("id", "")) not in imported_ids]
    remaining_path.write_text(
        json.dumps({"version": 1, "tasks": remaining}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    for index, archive in enumerate(args.archives):
        link = source_dir / f"{index:03d}_{archive.name}"
        os.symlink(archive, link)

    command = [
        "python3",
        str(args.builder),
        "--tasks",
        str(remaining_path),
        "--processed",
        str(source_dir),
        "--placeholder",
        str(args.placeholder),
        "--output",
        str(args.work / "recalc_output"),
    ]
    result = subprocess.run(command, check=False)
    if result.returncode:
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
