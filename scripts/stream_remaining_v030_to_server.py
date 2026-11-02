from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import zipfile
from pathlib import Path

from run_remaining_v030_queue import build_bins, load_json, task_ref


class CountingWriter:
    def __init__(self, stream):
        self.stream = stream
        self.position = 0

    def write(self, data):
        written = self.stream.write(data)
        self.position += written
        return written

    def flush(self):
        return self.stream.flush()

    def tell(self):
        return self.position

    def seekable(self):
        return False


def write_progress(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--done-tasks", type=Path, required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--package-index", type=int, required=True)
    parser.add_argument("--ssh-host", required=True)
    parser.add_argument("--remote-path", required=True)
    args = parser.parse_args()

    tasks_doc = load_json(args.tasks)
    manifest_doc = load_json(args.manifest)
    done_doc = load_json(args.done_tasks)
    excluded = {str(task["id"]) for task in done_doc["tasks"]}
    tasks = tasks_doc["tasks"]
    rows = manifest_doc["rows"]

    with zipfile.ZipFile(args.source) as source_zip:
        infos = {info.filename: info for info in source_zip.infolist()}
    sizes = {
        name: info.file_size
        for name, info in infos.items()
        if Path(name).suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
    }
    remaining, bins = build_bins(tasks, excluded, sizes)
    if not 1 <= args.package_index <= len(bins):
        raise ValueError(f"package index must be between 1 and {len(bins)}")
    bucket = bins[args.package_index - 1]
    selected_names = sorted(bucket["images"])
    rows_by_name = {
        str(row.get("image_filename") or row.get("src_rel_path") or ""): row
        for row in rows
    }
    selected_rows = [rows_by_name[name] for name in selected_names]
    selected_tasks = bucket["tasks"]
    package_tasks = {key: value for key, value in tasks_doc.items() if key != "tasks"}
    package_tasks["tasks"] = selected_tasks
    package_manifest = {key: value for key, value in manifest_doc.items() if key != "rows"}
    package_manifest["rows"] = selected_rows

    remote_partial = f"{args.remote_path}.partial"
    remote_command = [
        "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
        args.ssh_host, f"cat > '{remote_partial}'",
    ]
    progress = {
        "status": "streaming",
        "package_index": args.package_index,
        "package_count": len(bins),
        "tasks": len(selected_tasks),
        "images": len(selected_names),
        "planned_bytes": bucket["bytes"],
        "remote_path": args.remote_path,
        "started_at": time.time(),
        "written_images": 0,
    }
    write_progress(args.progress, progress)
    ssh = subprocess.Popen(remote_command, stdin=subprocess.PIPE)
    try:
        assert ssh.stdin is not None
        with zipfile.ZipFile(CountingWriter(ssh.stdin), "w", compression=zipfile.ZIP_STORED, allowZip64=True) as target:
            target.writestr("tasks.json", json.dumps(package_tasks, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            target.writestr("manifest.json", json.dumps(package_manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            with zipfile.ZipFile(args.source) as source_zip:
                for index, name in enumerate(selected_names, 1):
                    with source_zip.open(name) as source_file, target.open(name, "w", force_zip64=True) as target_file:
                        while chunk := source_file.read(1024 * 1024):
                            target_file.write(chunk)
                    if index % 250 == 0 or index == len(selected_names):
                        progress["written_images"] = index
                        progress["written_bytes"] = sum(sizes[item] for item in selected_names[:index])
                        progress["updated_at"] = time.time()
                        write_progress(args.progress, progress)
                        print(f"PACKAGE {args.package_index} images={index}/{len(selected_names)}", file=sys.stderr, flush=True)
        ssh.stdin.close()
        code = ssh.wait()
        if code != 0:
            raise RuntimeError(f"ssh stream exited with code {code}")
    except Exception:
        if ssh.stdin and not ssh.stdin.closed:
            ssh.stdin.close()
        ssh.kill()
        ssh.wait()
        progress["status"] = "stream_failed"
        write_progress(args.progress, progress)
        raise

    progress.update({"status": "streamed", "written_images": len(selected_names), "updated_at": time.time()})
    write_progress(args.progress, progress)
    print(json.dumps(progress, ensure_ascii=False), file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
