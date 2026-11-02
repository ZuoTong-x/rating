from __future__ import annotations

import argparse
import json
import subprocess
import threading
import time
from pathlib import Path


def worker(args, index, start, length, progress, lock, errors):
    remote_part = f"{args.remote_prefix}.{index}"
    command = [
        "ssh", "-T", "-o", "BatchMode=yes", "-o", "Compression=no",
        f"{args.user}@{args.host}",
        f"dd of='{remote_part}' bs=1048576 status=none",
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        with args.local.open("rb") as source:
            source.seek(start)
            remaining = length
            while remaining:
                chunk = source.read(min(args.buffer, remaining))
                if not chunk:
                    raise RuntimeError(f"unexpected local EOF worker={index}")
                process.stdin.write(chunk)
                remaining -= len(chunk)
                with lock:
                    progress["sent"] += len(chunk)
        process.stdin.close()
        stderr = process.stderr.read().decode("utf-8", errors="replace")
        code = process.wait()
        if code:
            raise RuntimeError(f"remote dd exit={code}: {stderr[-500:]}")
        with lock:
            progress["completed_parts"] += 1
        print(f"PART_DONE {index + 1}/{args.workers} bytes={length}", flush=True)
    except Exception as error:
        try:
            process.kill()
        except Exception:
            pass
        errors.append(f"part {index}: {error}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", type=Path, required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--remote-prefix", required=True)
    parser.add_argument("--remote-final", required=True)
    parser.add_argument("--progress", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--buffer", type=int, default=4 * 1024 * 1024)
    args = parser.parse_args()
    size = args.local.stat().st_size
    block = size // args.workers
    ranges = []
    for index in range(args.workers):
        start = index * block
        end = (index + 1) * block if index + 1 < args.workers else size
        ranges.append((start, end - start))
    progress = {"status":"running","total":size,"sent":0,"completed_parts":0,"workers":args.workers,"started_at":time.time()}
    lock = threading.Lock(); errors=[]
    threads=[threading.Thread(target=worker,args=(args,i,s,l,progress,lock,errors),daemon=True) for i,(s,l) in enumerate(ranges)]
    for thread in threads: thread.start()
    last=0
    while any(thread.is_alive() for thread in threads):
        time.sleep(10)
        elapsed=max(time.time()-progress["started_at"],0.001)
        speed=progress["sent"]/elapsed; eta=(size-progress["sent"])/speed if speed else 0
        print(f"PROGRESS bytes={progress['sent']}/{size} percent={progress['sent']*100/size:.2f} speed={speed/1_000_000:.2f}MB/s eta={eta/60:.1f}min parts={progress['completed_parts']}/{args.workers}",flush=True)
        progress.update(speed=speed,eta=eta)
        args.progress.write_text(json.dumps(progress,ensure_ascii=False,indent=2),encoding="utf-8")
    for thread in threads: thread.join()
    if errors:
        progress.update(status="failed", errors=errors)
        args.progress.write_text(
            json.dumps(progress, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        raise RuntimeError("; ".join(errors))
    if progress["completed_parts"] != args.workers: raise RuntimeError("not all parts completed")
    merge = f"cat {args.remote_prefix}.* > '{args.remote_final}.partial' && mv '{args.remote_final}.partial' '{args.remote_final}' && sha256sum '{args.remote_final}'"
    result=subprocess.run(["ssh","-T","-o","BatchMode=yes",f"{args.user}@{args.host}",merge],capture_output=True,text=True)
    if result.returncode: raise RuntimeError(result.stderr[-1000:])
    progress.update(status="complete",remote_sha256=result.stdout.strip(),completed_at=time.time())
    args.progress.write_text(json.dumps(progress,ensure_ascii=False,indent=2),encoding="utf-8")
    print("COMPLETE",json.dumps(progress,ensure_ascii=False),flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
