from __future__ import annotations

import argparse
import json
import math
import random
import statistics
import time
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import torch
from torch import nn

from .byte_models import (
    ByteGRU,
    ByteGRULocal,
    ByteLSTM,
    ByteMLP,
    ByteSLSTM,
    ByteTokenBatch,
    ByteTransformer,
    ByteUnigram,
    HashedByteNGram,
    parameter_sizes,
    sequence_bits,
    tokenize_urls,
)
from .loader import create_loader
from .pack import SplitName


@dataclass
class Metrics:
    urls: int = 0
    tokens: int = 0
    excludedUrls: int = 0
    totalBits: float = 0.0
    seconds: float = 0.0
    perUrlBits: list[float] | None = None

    def report(self) -> dict[str, float | int | None]:
        values = self.perUrlBits or []
        return {
            "urls": self.urls,
            "tokens": self.tokens,
            "excludedUrls": self.excludedUrls,
            "coverage": self.urls / max(1, self.urls + self.excludedUrls),
            "meanBitsPerUrl": self.totalBits / max(1, self.urls),
            "medianBitsPerUrl": statistics.median(values) if values else None,
            "bitsPerToken": self.totalBits / max(1, self.tokens),
            "urlsPerSecond": self.urls / max(1e-9, self.seconds),
            "tokensPerSecond": self.tokens / max(1e-9, self.seconds),
        }


def batches(
    manifest: str,
    split: SplitName,
    *,
    batch_size: int,
    workers: int,
    prefetch_factor: int,
    seed: str,
) -> Iterable[dict[str, torch.Tensor]]:
    return create_loader(
        manifest,
        split,
        batch_size,
        workers,
        prefetch_factor,
        pin_memory=torch.cuda.is_available(),
        seed=seed,
    )


def prepare(
    raw: dict[str, torch.Tensor],
    *,
    device: torch.device,
    maximum_length: int,
    remaining_urls: int,
) -> tuple[ByteTokenBatch | None, int]:
    take = min(remaining_urls, int(raw["urls"].shape[0]))
    urls = raw["urls"][:take].to(device, non_blocking=True)
    lengths = raw["lengths"][:take].to(device, non_blocking=True)
    return tokenize_urls(urls, lengths, maximum_length=maximum_length)


def fit_count_model(
    model: ByteUnigram | HashedByteNGram,
    manifest: str,
    *,
    maximum_urls: int,
    maximum_length: int,
    batch_size: int,
    workers: int,
    prefetch_factor: int,
    seed: str,
    device: torch.device,
) -> dict[str, float | int]:
    started = time.perf_counter()
    urls = 0
    tokens = 0
    excluded = 0
    for raw in batches(
        manifest,
        "train",
        batch_size=batch_size,
        workers=workers,
        prefetch_factor=prefetch_factor,
        seed=seed,
    ):
        remaining = maximum_urls - urls - excluded
        if remaining <= 0:
            break
        batch, rejected = prepare(
            raw,
            device=device,
            maximum_length=maximum_length,
            remaining_urls=remaining,
        )
        excluded += rejected
        if batch is None:
            continue
        model.update(batch)
        urls += batch.urls
        tokens += batch.tokens
    if device.type == "cuda":
        torch.cuda.synchronize(device)
    seconds = time.perf_counter() - started
    return {
        "urls": urls,
        "tokens": tokens,
        "excludedUrls": excluded,
        "seconds": seconds,
        "tokensPerSecond": tokens / max(1e-9, seconds),
    }


@torch.inference_mode()
def evaluate_count_model(
    model: ByteUnigram | HashedByteNGram,
    manifest: str,
    split: SplitName,
    **options: object,
) -> dict[str, float | int | None]:
    return evaluate_bits(lambda batch: model.bits(batch), manifest, split, **options)


@torch.inference_mode()
def evaluate_bits(
    calculate: Callable[[ByteTokenBatch], torch.Tensor],
    manifest: str,
    split: SplitName,
    *,
    maximum_urls: int,
    maximum_length: int,
    batch_size: int,
    workers: int,
    prefetch_factor: int,
    seed: str,
    device: torch.device,
) -> dict[str, float | int | None]:
    metrics = Metrics(perUrlBits=[])
    started = time.perf_counter()
    for raw in batches(
        manifest,
        split,
        batch_size=batch_size,
        workers=workers,
        prefetch_factor=prefetch_factor,
        seed=seed,
    ):
        remaining = maximum_urls - metrics.urls - metrics.excludedUrls
        if remaining <= 0:
            break
        batch, rejected = prepare(
            raw,
            device=device,
            maximum_length=maximum_length,
            remaining_urls=remaining,
        )
        metrics.excludedUrls += rejected
        if batch is None:
            continue
        bits = calculate(batch)
        metrics.urls += batch.urls
        metrics.tokens += batch.tokens
        metrics.totalBits += float(bits.sum().item())
        assert metrics.perUrlBits is not None
        metrics.perUrlBits.extend(float(value) for value in bits.cpu().tolist())
    if device.type == "cuda":
        torch.cuda.synchronize(device)
    metrics.seconds = time.perf_counter() - started
    return metrics.report()


def train_neural_model(
    model: nn.Module,
    manifest: str,
    *,
    maximum_urls: int,
    maximum_length: int,
    batch_size: int,
    workers: int,
    prefetch_factor: int,
    seed: str,
    device: torch.device,
    learning_rate: float,
) -> dict[str, float | int]:
    model.train()
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate, weight_decay=1e-4)
    urls = 0
    tokens = 0
    excluded = 0
    total_loss = 0.0
    started = time.perf_counter()
    use_amp = device.type == "cuda"
    autocast = (
        lambda: torch.autocast(device_type="cuda", dtype=torch.bfloat16)
        if use_amp
        else nullcontext()
    )
    for raw in batches(
        manifest,
        "train",
        batch_size=batch_size,
        workers=workers,
        prefetch_factor=prefetch_factor,
        seed=seed,
    ):
        remaining = maximum_urls - urls - excluded
        if remaining <= 0:
            break
        batch, rejected = prepare(
            raw,
            device=device,
            maximum_length=maximum_length,
            remaining_urls=remaining,
        )
        excluded += rejected
        if batch is None:
            continue
        optimizer.zero_grad(set_to_none=True)
        with autocast():
            logits = model(batch.inputs, batch.valid)
            loss = torch.nn.functional.cross_entropy(
                logits.transpose(1, 2),
                batch.targets,
                ignore_index=-100,
            )
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        urls += batch.urls
        tokens += batch.tokens
        total_loss += float(loss.detach().item()) * batch.tokens
    if device.type == "cuda":
        torch.cuda.synchronize(device)
    seconds = time.perf_counter() - started
    return {
        "urls": urls,
        "tokens": tokens,
        "excludedUrls": excluded,
        "seconds": seconds,
        "tokensPerSecond": tokens / max(1e-9, seconds),
        "trainingBitsPerToken": total_loss / max(1, tokens) / math.log(2),
    }


@torch.inference_mode()
def evaluate_neural_model(
    model: nn.Module,
    manifest: str,
    split: SplitName,
    **options: object,
) -> dict[str, float | int | None]:
    model.eval()
    device = options["device"]
    assert isinstance(device, torch.device)
    use_amp = device.type == "cuda"

    def calculate(batch: ByteTokenBatch) -> torch.Tensor:
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16) if use_amp else nullcontext():
            logits = model(batch.inputs, batch.valid)
            return sequence_bits(logits.float(), batch)

    return evaluate_bits(calculate, manifest, split, **options)


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare causal canonical-URL symbol models")
    parser.add_argument(
        "--manifest",
        default="data/training/cc-main-2026-30-balanced-v1/pack/manifest.json",
    )
    parser.add_argument("--report", default="reports/byte-model-pilot.json")
    parser.add_argument("--checkpoint-directory", default="data/training/model-pilot")
    parser.add_argument(
        "--models",
        default=(
            "unigram,ngram4,mlp,gru,gru-l,gru-local,lstm,"
            "transformer-s,transformer-m,transformer-l"
        ),
    )
    parser.add_argument("--train-urls", type=int, default=500_000)
    parser.add_argument("--validation-urls", type=int, default=50_000)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--prefetch-factor", type=int, default=2)
    parser.add_argument("--maximum-length", type=int, default=512)
    parser.add_argument("--learning-rate", type=float, default=2e-3)
    parser.add_argument("--seed", default="min-ug-byte-model-pilot-v1")
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    if args.device == "auto":
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    else:
        device = torch.device(args.device)
    random.seed(args.seed)
    torch.manual_seed(int.from_bytes(args.seed.encode()[:8].ljust(8, b"\0"), "little"))
    if device.type == "cuda":
        torch.cuda.manual_seed_all(torch.initial_seed())

    common = {
        "maximum_urls": args.validation_urls,
        "maximum_length": args.maximum_length,
        "batch_size": args.batch_size,
        "workers": args.workers,
        "prefetch_factor": args.prefetch_factor,
        "seed": args.seed,
        "device": device,
    }
    training = {**common, "maximum_urls": args.train_urls}
    requested = [name.strip() for name in args.models.split(",") if name.strip()]
    results: dict[str, object] = {}
    checkpoint_directory = Path(args.checkpoint_directory)
    checkpoint_directory.mkdir(parents=True, exist_ok=True)

    for name in requested:
        print(f"model: {name}", flush=True)
        if name == "unigram":
            count_model: ByteUnigram | HashedByteNGram = ByteUnigram(device=device)
            fit = fit_count_model(count_model, args.manifest, **training)
            size = {"artifactBytes": count_model.artifact_bytes()}
            evaluator = lambda split: evaluate_count_model(
                count_model, args.manifest, split, **common
            )
        elif name == "ngram4":
            count_model = HashedByteNGram(device=device)
            fit = fit_count_model(count_model, args.manifest, **training)
            size = {"workingSetBytes": count_model.working_set_bytes()}
            evaluator = lambda split: evaluate_count_model(
                count_model, args.manifest, split, **common
            )
        else:
            if name == "mlp":
                neural_model: nn.Module = ByteMLP(context=8, embedding=16, hidden=96)
            elif name == "gru":
                neural_model = ByteGRU(embedding=48, hidden=128, layers=1)
            elif name == "gru-l":
                neural_model = ByteGRU(embedding=96, hidden=256, layers=1)
            elif name == "gru-local":
                neural_model = ByteGRULocal(
                    context=8,
                    embedding=64,
                    hidden=192,
                    local_hidden=192,
                )
            elif name == "lstm":
                neural_model = ByteLSTM(embedding=72, hidden=216, layers=1)
            elif name == "slstm":
                neural_model = ByteSLSTM(embedding=72, hidden=216)
            elif name == "transformer-s":
                neural_model = ByteTransformer(
                    dimension=48,
                    heads=4,
                    layers=2,
                    feedforward=96,
                    maximum_length=args.maximum_length,
                )
            elif name == "transformer-m":
                neural_model = ByteTransformer(
                    dimension=64,
                    heads=4,
                    layers=2,
                    feedforward=128,
                    maximum_length=args.maximum_length,
                )
            elif name == "transformer-l":
                neural_model = ByteTransformer(
                    dimension=96,
                    heads=6,
                    layers=3,
                    feedforward=192,
                    maximum_length=args.maximum_length,
                )
            else:
                raise ValueError(f"unknown model {name!r}")
            neural_model.to(device)
            fit = train_neural_model(
                neural_model,
                args.manifest,
                learning_rate=args.learning_rate,
                **training,
            )
            size = parameter_sizes(neural_model)
            torch.save(neural_model.state_dict(), checkpoint_directory / f"{name}.pt")
            evaluator = lambda split: evaluate_neural_model(
                neural_model, args.manifest, split, **common
            )

        seen = evaluator("seen-validation")
        unseen = evaluator("unseen-validation")
        results[name] = {
            "fit": fit,
            "size": size,
            "seenHostValidation": seen,
            "unseenHostValidation": unseen,
            "balancedMeanBitsPerUrl": (
                float(seen["meanBitsPerUrl"]) + float(unseen["meanBitsPerUrl"])
            ) / 2,
        }
        print(json.dumps(results[name], indent=2), flush=True)
        if device.type == "cuda":
            torch.cuda.empty_cache()

    report = {
        "schemaVersion": 1,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "manifest": str(Path(args.manifest).resolve()),
        "configuration": {
            "models": requested,
            "trainUrls": args.train_urls,
            "validationUrlsPerSplit": args.validation_urls,
            "batchSize": args.batch_size,
            "workers": args.workers,
            "maximumLength": args.maximum_length,
            "learningRate": args.learning_rate,
            "seed": args.seed,
        },
        "runtime": {
            "python": __import__("platform").python_version(),
            "torch": torch.__version__,
            "device": str(device),
            "deviceName": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
        },
        "models": results,
    }
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {report_path}")


if __name__ == "__main__":
    main()
