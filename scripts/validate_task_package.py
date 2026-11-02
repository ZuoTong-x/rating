from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path


for raw_path in sys.argv[1:]:
    path = Path(raw_path)
    with zipfile.ZipFile(path) as archive:
        tasks = json.loads(archive.read("tasks.json"))
        manifest = json.loads(archive.read("manifest.json"))
        names = set(archive.namelist())
        image_names = {
            name
            for name in names
            if Path(name).suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".gif"}
        }
        task_refs = {
            image["src_rel_path"]
            for task in tasks["tasks"]
            for image in task["images"]
        }
        manifest_refs = {row["src_rel_path"] for row in manifest["rows"]}
        print(
            json.dumps(
                {
                    "zip": str(path),
                    "bytes": path.stat().st_size,
                    "entries": len(names),
                    "task_count": len(tasks["tasks"]),
                    "unique_task_ids": len({task["id"] for task in tasks["tasks"]}),
                    "manifest_rows": len(manifest["rows"]),
                    "image_entries": len(image_names),
                    "missing_task_images": len(task_refs - image_names),
                    "missing_manifest_images": len(manifest_refs - image_names),
                    "extra_images": len(image_names - manifest_refs),
                    "tasks_keys": list(tasks),
                    "manifest_keys": list(manifest),
                },
                ensure_ascii=False,
            )
        )
