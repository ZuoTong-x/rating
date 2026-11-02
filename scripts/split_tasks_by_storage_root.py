from __future__ import annotations

import argparse
import json
import zipfile
from collections import defaultdict
from pathlib import Path

MAX_JSON_BYTES = 64 * 1024 * 1024


def reference(value):
    if isinstance(value, str):
        return value.replace("\\", "/")
    return str(
        value.get("src_rel_path")
        or value.get("originalPath")
        or value.get("filename")
        or ""
    ).replace("\\", "/")


def storage_root(value: str) -> str:
    parts = value.split("/")
    if len(parts) < 4 or parts[0] or parts[1] != "files":
        raise ValueError(f"unsupported image reference: {value}")
    return parts[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    document = json.loads(args.tasks.read_text(encoding="utf-8"))
    tasks = document.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise ValueError("tasks.json must contain a non-empty tasks array")

    groups = defaultdict(list)
    all_ids = []
    for index, task in enumerate(tasks):
        refs = [reference(item) for item in task.get("images", [])]
        roots = {storage_root(item) for item in refs}
        if len(roots) != 1:
            raise ValueError(f"task {index} crosses storage roots: {sorted(roots)}")
        groups[next(iter(roots))].append(task)
        all_ids.append(str(task.get("id", "")))
    if len(all_ids) != len(set(all_ids)):
        raise ValueError("duplicate task ids in source")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    emitted_ids = []
    results = []
    for root, selected in sorted(groups.items()):
        payload = json.dumps(
            {"version": 1, "tasks": selected},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(payload) > MAX_JSON_BYTES:
            raise ValueError(f"{root}: tasks.json exceeds 64MiB")
        output = args.output_dir / f"round2_v2_{root}_tasks.zip"
        if output.exists():
            raise ValueError(f"refusing to overwrite {output}")
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            archive.writestr("tasks.json", payload)
        with zipfile.ZipFile(output) as archive:
            if archive.testzip():
                raise ValueError(f"CRC failure: {output}")
            checked = json.loads(archive.read("tasks.json"))["tasks"]
            if len(checked) != len(selected):
                raise ValueError(f"task count mismatch: {output}")
            for task in checked:
                refs = [reference(item) for item in task.get("images", [])]
                if {storage_root(item) for item in refs} != {root}:
                    raise ValueError(f"reference root mismatch: {output}")
                emitted_ids.append(str(task.get("id", "")))
        results.append({
            "storage_root": root,
            "tasks": len(selected),
            "tasks_json_bytes": len(payload),
            "zip_bytes": output.stat().st_size,
            "path": str(output),
        })
    if sorted(emitted_ids) != sorted(all_ids):
        raise ValueError("split task coverage mismatch")
    print(json.dumps({
        "status": "PASS",
        "source_tasks": len(tasks),
        "split_tasks": len(emitted_ids),
        "unique_task_ids": len(set(emitted_ids)),
        "packages": results,
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
