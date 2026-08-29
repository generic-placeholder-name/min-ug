from __future__ import annotations

import hashlib
import math
import random
from collections import defaultdict
from typing import Any, Iterator

import torch
from torch.utils.data import DataLoader, IterableDataset, get_worker_info

from .pack import PackCorpus, PackRecord, SplitName, selected


def _seed(base: str, epoch: int, worker_id: int) -> int:
    digest = hashlib.sha256(f"{base}\0{epoch}\0{worker_id}".encode()).digest()
    return int.from_bytes(digest[:8], "little")


def _bucket(url: bytes) -> int:
    return max(0, min(15, math.ceil(math.log2(max(1, len(url))))))


def collate_records(records: list[PackRecord]) -> dict[str, torch.Tensor]:
    records.sort(key=lambda record: len(record.url))
    lengths = torch.tensor([len(record.url) for record in records], dtype=torch.int32)
    width = int(lengths.max()) if records else 0
    urls = torch.zeros((len(records), width), dtype=torch.uint8)
    for index, record in enumerate(records):
        source = torch.frombuffer(bytearray(record.url), dtype=torch.uint8)
        urls[index, : len(record.url)].copy_(source)
    return {
        "urls": urls,
        "lengths": lengths,
    }


class UrlPackBatchDataset(IterableDataset[dict[str, torch.Tensor]]):
    def __init__(
        self,
        manifest: str,
        split: SplitName,
        batch_size: int,
        seed: str = "min-ug-loader-v1",
        epoch: int = 0,
        shuffle_block_size: int = 65536,
    ) -> None:
        super().__init__()
        self.manifest = manifest
        self.split = split
        self.batch_size = batch_size
        self.seed = seed
        self.epoch = epoch
        self.shuffle_block_size = shuffle_block_size

    def __iter__(self) -> Iterator[dict[str, torch.Tensor]]:
        worker = get_worker_info()
        worker_id = 0 if worker is None else worker.id
        worker_count = 1 if worker is None else worker.num_workers
        rng = random.Random(_seed(self.seed, self.epoch, worker_id))
        corpus = PackCorpus(self.manifest)
        shard_indices = list(range(len(corpus.shards)))
        rng.shuffle(shard_indices)
        shard_indices = shard_indices[worker_id::worker_count]
        buckets: dict[int, list[PackRecord]] = defaultdict(list)

        for shard_index in shard_indices:
            with corpus.open_shard(shard_index) as shard:
                block_starts = list(range(0, shard.records, self.shuffle_block_size))
                rng.shuffle(block_starts)
                for start in block_starts:
                    indices = list(range(start, min(start + self.shuffle_block_size, shard.records)))
                    rng.shuffle(indices)
                    for index in indices:
                        record = shard.record(index)
                        if not selected(record, self.split):
                            continue
                        bucket = buckets[_bucket(record.url)]
                        bucket.append(record)
                        if len(bucket) >= self.batch_size:
                            yield collate_records(bucket)
                            buckets[_bucket(record.url)] = []

        for bucket in buckets.values():
            if bucket:
                yield collate_records(bucket)


def create_loader(
    manifest: str,
    split: SplitName,
    batch_size: int,
    workers: int,
    prefetch_factor: int,
    pin_memory: bool,
    seed: str,
) -> DataLoader[dict[str, torch.Tensor]]:
    dataset = UrlPackBatchDataset(manifest, split, batch_size, seed)
    options: dict[str, Any] = {
        "batch_size": None,
        "num_workers": workers,
        "pin_memory": pin_memory,
        "persistent_workers": workers > 0,
    }
    if workers > 0:
        options["prefetch_factor"] = prefetch_factor
    return DataLoader(dataset, **options)
