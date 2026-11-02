from __future__ import annotations

import json
import tarfile
import zipfile
from collections import Counter
from pathlib import Path


root = Path(r"D:/v030_data")
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
rows = manifest["rows"]
for source in ["mixed30_93000", "annot_18000_9metrics"]:
    selected = [
        row
        for row in rows
        if (row.get("catalog_row") or {}).get("source_task_set") == source
    ]
    print("SOURCE", source, "ROWS", len(selected))
    print("MODEL", Counter(
        (row.get("catalog_row") or {}).get("model_name")
        or (row.get("catalog_row") or {}).get("model_id")
        or ""
        for row in selected
    ))
    print("ARCHIVE", Counter(row.get("archive_source") for row in selected))
    for row in selected[:3]:
        print("ROW", json.dumps(row, ensure_ascii=False)[:1800])

for path in sorted(root.rglob("*.tar")):
    if path.name not in {"flux_2_dev.tar", "qwen-image-2512.tar", "u1_5.tar", "z_image.tar"}:
        continue
    names = []
    with tarfile.open(path, "r:*") as archive:
        for member in archive:
            if member.isfile() and Path(member.name).suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
                names.append(member.name)
    print("TAR", path.name, "COUNT", len(names), "FIRST", names[:8], "LAST", names[-3:])

zip_path = root / "真正的第四批" / "v030_12000_images.zip"
with zipfile.ZipFile(zip_path) as archive:
    names = [
        item.filename
        for item in archive.infolist()
        if not item.is_dir() and Path(item.filename).suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    ]
print("MIXED_ZIP", len(names), "FIRST", names[:8], "LAST", names[-3:])
