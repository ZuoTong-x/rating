from __future__ import annotations

import json
from collections import Counter
from pathlib import Path


manifest = json.loads(Path(r"D:/v030_data/manifest.json").read_text(encoding="utf-8"))
rows = manifest["rows"]
annot = [
    row
    for row in rows
    if (row.get("catalog_row") or {}).get("source_task_set")
    == "annot_18000_9metrics"
]
print("rows", len(rows))
print(
    "sources",
    Counter((row.get("catalog_row") or {}).get("source_task_set") for row in rows),
)
print("annot_rows", len(annot))
print("annot_case_nonnull", sum(row.get("case_id") is not None for row in annot))
print("annot_sample", json.dumps(annot[0], ensure_ascii=False)[:4000] if annot else None)
for model in ["FLUX.2", "qwen-image-2512", "U1.5", "z-image"]:
    samples = [
        row
        for row in annot
        if model.lower() in str((row.get("catalog_row") or {}).get("model_name", "")).lower()
        or model.lower() in str((row.get("catalog_row") or {}).get("model_id", "")).lower()
    ]
    print("model", model, "count", len(samples))
    if samples:
        print(json.dumps(samples[0], ensure_ascii=False)[:2500])
