from __future__ import annotations

import argparse
import json
import subprocess
import threading
import time
from pathlib import Path


def upload_range(args, index: int, start: int, length: int, progress: dict, lock: threading.Lock):
    start_mib = start // (1024 * 1024)
    count_mib = length // (1024 * 1024)
    remainder = length % (1024 * 1024)
    commands = []
    if count_mib:
        commands.append(
            f"dd of='{args.remote_tmp}' bs=1048576 seek={start_mib} "
            f"count={count_mib} conv=notrunc status=none"
        )
    if remainder:
        commands.append(
            f"dd of='{args.remote_tmp}' bs=1 seek={start + count_mib * 1048576} "
            f"count={remainder} conv=notrunc status=none"
        )
    remote_cmd = "; ".join(commands)
    command = [
        "ssh", "-T", "-o", "BatchMode=yes", "-o", "Compression=no",
        f"{args.user}@{args.host}", remote_cmd,
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    sent = 0
    try:
        with args.local.open("rb") as source:
            source.seek(start)
            remaining = length
            while remaining:
                chunk = source.read(min(args.buffer, remaining))
                if not chunk:
                    raise RuntimeError(f"local EOF in worker {index}")
                process.stdin.write(chunk)
                sent += len(chunk)
                remaining -= len(chunk)
                with lock:
                    progress["bytes_sent"] += len(chunk)
    finally:
        if process.stdin:
            process.stdin.close()
    stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
    code = process.wait()
    if code != 0:
        raise RuntimeError(f"worker {index} failed with exit={code}: {stderr[-1000:]}")
    with lock:
        progress["completed_workers"] += 1
    print(f"WORKER_DONE {index + 1}/{args.workers} bytes={sent}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", type=Path, required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--remote-tmp", required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--buffer", type=int, default=4 * 1024 * 1024)
    args = parser.parse_args()

    size = args.local.stat().st_size
    unit = 1024 * 1024
    if size <= 0:
        raise RuntimeError("local file is empty")

    # Equal MiB-aligned ranges keep all remote writes independent.
    total_mib = size // unit
    base = total_mib // args.workers
    ranges = []
    for index in range(args.workers):
        start_mib = index * base
        if index + 1 < args.workers:
            end = (index + 1) * base * unit
        else:
            end = size
        ranges.append((start_mib * unit, end - start_mib * unit))

    progress = {
        "status": "running", "local": str(args.local), "remote_tmp": args.remote_tmp,
        "total_bytes": size, "bytes_sent": 0, "completed_workers": 0,
        "workers": args.workers, "started_at": time.time(),
    }
    lock = threading.Lock()
    errors = []

    def run(index, start, length):
        try:
            upload_range(args, index, start, length, progress, lock)
        except Exception as error:
            errors.append(f"worker {index}: {error}")

    threads = [threading.Thread(target=run, args=(i, start, length), daemon=True) for i, (start, length) in enumerate(ranges)]
    for thread in threads:
        thread.start()
    last_report = time.monotonic()
    while any(thread.is_alive() for thread in threads):
        for thread in threads:
            thread.join(timeout=0.2)
        now = time.monotonic()
        if now - last_report >= 10:
            elapsed = max(time.time() - progress["started_at"], 0.001)
            speed = progress["bytes_sent"] / elapsed
            eta = max(size - progress["bytes_sent"], 0) / speed if speed else 0
            print(
                f"PROGRESS bytes={progress['bytes_sent']}/{size} "
                f"percent={progress['bytes_sent'] * 100 / size:.2f} "
                f"speed={speed / 1_000_000:.2f}MB/s eta={eta / 60:.1f}min "
                f"workers_done={progress['completed_workers']}/{args.workers}",
                flush=True,
            )
            progress["last_speed_bytes_per_second"] = speed
            progress["last_eta_seconds"] = eta
            args.progress.write_text(json.dumps(progress, ensure_ascii=False, indent=2), encoding="utf-8")
            last_report = now
    for thread in threads:
        thread.join()
    if errors:
        progress["status"] = "failed"
        progress["errors"] = errors
        args.progress.write_text(json.dumps(progress, ensure_ascii=False, indent=2), encoding="utf-8")
        raise RuntimeError("; ".join(errors))
    progress.update({"status": "complete", "completed_at": time.time()})
    args.progress.write_text(json.dumps(progress, ensure_ascii=False, indent=2), encoding="utf-8")
    print("COMPLETE", json.dumps(progress, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
