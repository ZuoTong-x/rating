from __future__ import annotations

import argparse
import hashlib
import json
import math
import multiprocessing as mp
import os
import subprocess
import sys
import time
from pathlib import Path


BLOCK_SIZE = 1024 * 1024
READ_SIZE = 4 * 1024 * 1024


def remote_size(host: str, remote_path: str) -> int:
    result = subprocess.run(
        ["ssh", "-T", host, "stat", "-c", "%s", remote_path],
        check=True,
        capture_output=True,
        text=True,
    )
    return int(result.stdout.strip())


def remote_sha256(host: str, remote_path: str) -> str:
    result = subprocess.run(
        ["ssh", "-T", host, "sha256sum", remote_path],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.split()[0]


def worker(
    worker_id: int,
    host: str,
    remote_path: str,
    output_path: str,
    block_start: int,
    block_count: int,
    expected_bytes: int,
    progress,
    result_queue,
) -> None:
    offset = block_start * BLOCK_SIZE
    command = (
        f"dd if={remote_path} bs={BLOCK_SIZE} skip={block_start} "
        f"count={block_count} iflag=fullblock status=none"
    )
    process = subprocess.Popen(
        ["ssh", "-T", host, command],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    written = 0
    try:
        with open(output_path, "r+b", buffering=0) as target:
            target.seek(offset)
            while True:
                chunk = process.stdout.read(READ_SIZE)
                if not chunk:
                    break
                remaining = expected_bytes - written
                if remaining > 0:
                    usable = chunk[:remaining]
                    target.write(usable)
                    written += len(usable)
                    progress[worker_id] = written
        stderr = process.stderr.read().decode("utf-8", errors="replace")
        return_code = process.wait()
        if return_code != 0:
            raise RuntimeError(f"ssh/dd failed with exit {return_code}: {stderr[-500:]}")
        if written != expected_bytes:
            raise RuntimeError(
                f"short read: expected {expected_bytes}, received {written}"
            )
        result_queue.put({"worker": worker_id, "status": "complete", "bytes": written})
    except Exception as error:
        process.kill()
        process.wait()
        result_queue.put({"worker": worker_id, "status": "error", "error": str(error)})


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(READ_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--remote-path", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--report-seconds", type=int, default=10)
    args = parser.parse_args()

    if args.output.exists():
        raise RuntimeError(f"Refusing to overwrite existing output: {args.output}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    size = remote_size(args.host, args.remote_path)
    free = os.statvfs(args.output.parent).f_bavail * os.statvfs(args.output.parent).f_frsize if hasattr(os, "statvfs") else None
    if free is not None and free < size:
        raise RuntimeError(f"Insufficient free space: {free} < {size}")

    with args.output.open("wb") as handle:
        handle.truncate(size)

    total_blocks = math.ceil(size / BLOCK_SIZE)
    base, extra = divmod(total_blocks, args.workers)
    progress = mp.Array("Q", [0] * args.workers, lock=False)
    result_queue = mp.Queue()
    processes = []
    block_start = 0
    for worker_id in range(args.workers):
        block_count = base + (1 if worker_id < extra else 0)
        offset = block_start * BLOCK_SIZE
        expected = min(size - offset, block_count * BLOCK_SIZE)
        process = mp.Process(
            target=worker,
            args=(
                worker_id,
                args.host,
                args.remote_path,
                str(args.output),
                block_start,
                block_count,
                expected,
                progress,
                result_queue,
            ),
        )
        process.start()
        processes.append(process)
        block_start += block_count

    started = time.monotonic()
    last_time = started
    last_bytes = 0
    errors = []
    while any(process.is_alive() for process in processes):
        time.sleep(args.report_seconds)
        now = time.monotonic()
        current = sum(progress)
        interval = max(now - last_time, 0.001)
        speed = (current - last_bytes) / interval
        remaining = size - current
        eta = remaining / speed if speed > 0 else None
        eta_text = time.strftime("%H:%M:%S", time.gmtime(eta)) if eta is not None else "unknown"
        print(
            f"PROGRESS {current / size * 100:.2f}% "
            f"{current / 1_000_000_000:.2f}/{size / 1_000_000_000:.2f}GB "
            f"speed={speed / 1_000_000:.2f}MB/s ETA={eta_text}",
            flush=True,
        )
        last_time = now
        last_bytes = current
        while not result_queue.empty():
            result = result_queue.get()
            if result.get("status") == "error":
                errors.append(result)

    for process in processes:
        process.join()
    while not result_queue.empty():
        result = result_queue.get()
        if result.get("status") == "error":
            errors.append(result)
    if errors or any(process.exitcode != 0 for process in processes):
        args.output.unlink(missing_ok=True)
        raise RuntimeError(json.dumps(errors, ensure_ascii=False))

    local_hash = sha256_file(args.output)
    print(f"LOCAL_SHA256 {local_hash}", flush=True)
    remote_hash = remote_sha256(args.host, args.remote_path)
    print(f"REMOTE_SHA256 {remote_hash}", flush=True)
    if local_hash != remote_hash:
        args.output.unlink(missing_ok=True)
        raise RuntimeError("SHA-256 mismatch")
    print(
        f"COMPLETE output={args.output} bytes={size} "
        f"workers={args.workers} sha256={local_hash}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    mp.freeze_support()
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
