from __future__ import annotations

import argparse
import json
import platform
import statistics
import time
from pathlib import Path
from typing import Sequence

import torch

from .loader import create_loader
from .pack import SplitName


def percentile(values: Sequence[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def peak_rss_bytes() -> int | None:
    try:
        import resource

        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(rss if platform.system() == "Darwin" else rss * 1024)
    except (ImportError, AttributeError):
        return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark the min.ug memory-mapped URL loader")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--split", default="train", choices=(
        "train", "seen-validation", "seen-test", "unseen-validation", "unseen-test"
    ))
    parser.add_argument("--batch-size", type=int, default=2048)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--prefetch-factor", type=int, default=2)
    parser.add_argument("--batches", type=int, default=200)
    parser.add_argument("--warmup-batches", type=int, default=10)
    parser.add_argument("--seed", default="min-ug-loader-v1")
    parser.add_argument("--device", default="auto")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.batch_size <= 0 or args.workers < 0 or args.batches <= 0:
        raise ValueError("batch size and batches must be positive; workers must be non-negative")
    device_name = (
        "cuda" if args.device == "auto" and torch.cuda.is_available()
        else "cpu" if args.device == "auto"
        else args.device
    )
    device = torch.device(device_name)
    loader = create_loader(
        str(Path(args.manifest).resolve()),
        args.split,
        args.batch_size,
        args.workers,
        args.prefetch_factor,
        device.type == "cuda",
        args.seed,
    )
    iterator = iter(loader)
    wait_ms: list[float] = []
    transfer_ms: list[float] = []
    measured_urls = 0
    measured_bytes = 0
    measured_started: float | None = None

    for batch_index in range(args.warmup_batches + args.batches):
        wait_started = time.perf_counter()
        try:
            batch = next(iterator)
        except StopIteration:
            break
        waited = (time.perf_counter() - wait_started) * 1000
        transfer_started = time.perf_counter()
        urls = batch["urls"].to(device, non_blocking=True)
        lengths = batch["lengths"].to(device, non_blocking=True)
        # Consume the batch so asynchronous transfers cannot make loader timing look better.
        _ = urls.float().sum() + lengths.float().sum()
        if device.type == "cuda":
            torch.cuda.synchronize(device)
        transferred = (time.perf_counter() - transfer_started) * 1000
        if batch_index >= args.warmup_batches:
            if measured_started is None:
                measured_started = wait_started
            wait_ms.append(waited)
            transfer_ms.append(transferred)
            measured_urls += int(lengths.shape[0])
            measured_bytes += int(lengths.sum().item())

    measured_elapsed = max(
        1e-9,
        0.0 if measured_started is None else time.perf_counter() - measured_started,
    )
    total_wait = sum(wait_ms)
    total_transfer = sum(transfer_ms)
    report = {
        "schemaVersion": 1,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "manifest": str(Path(args.manifest).resolve()),
        "split": args.split,
        "configuration": {
            "batchSize": args.batch_size,
            "workers": args.workers,
            "prefetchFactor": args.prefetch_factor,
            "warmupBatches": args.warmup_batches,
            "requestedBatches": args.batches,
            "seed": args.seed,
        },
        "runtime": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "device": str(device),
            "deviceName": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
        },
        "measurements": {
            "batches": len(wait_ms),
            "urls": measured_urls,
            "urlBytes": measured_bytes,
            "elapsedSeconds": measured_elapsed,
            "urlsPerSecond": measured_urls / measured_elapsed,
            "bytesPerSecond": measured_bytes / measured_elapsed,
            "dataWaitMilliseconds": {
                "mean": statistics.fmean(wait_ms) if wait_ms else None,
                "p50": percentile(wait_ms, 0.5),
                "p95": percentile(wait_ms, 0.95),
            },
            "hostToDeviceMilliseconds": {
                "mean": statistics.fmean(transfer_ms) if transfer_ms else None,
                "p50": percentile(transfer_ms, 0.5),
                "p95": percentile(transfer_ms, 0.95),
            },
            "dataWaitFraction": total_wait / max(1e-9, total_wait + total_transfer),
            "peakRssBytes": peak_rss_bytes(),
        },
    }
    report_path = Path(args.report).resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
