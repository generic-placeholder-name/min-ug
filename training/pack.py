from __future__ import annotations

import json
import mmap
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Literal

SplitName = Literal[
    "train",
    "seen-validation",
    "seen-test",
    "unseen-validation",
    "unseen-test",
]

SPLIT_VALUES: dict[SplitName, int] = {
    "train": 0,
    "seen-validation": 1,
    "seen-test": 2,
    "unseen-validation": 3,
    "unseen-test": 4,
}


@dataclass(frozen=True)
class PackRecord:
    url: bytes
    split: int


class PackShard:
    def __init__(self, directory: Path, metadata: dict[str, Any]) -> None:
        self.directory = directory
        self.metadata = metadata
        self.records = int(metadata["records"])
        files = metadata["files"]
        self._handles = {
            name: (directory / files[name]["path"]).open("rb")
            for name in ("bytes", "offsets", "splits")
        }
        self._maps = {
            name: mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
            for name, handle in self._handles.items()
        }

    def close(self) -> None:
        for mapped in self._maps.values():
            mapped.close()
        for handle in self._handles.values():
            handle.close()

    def __enter__(self) -> PackShard:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def record(self, index: int) -> PackRecord:
        if index < 0 or index >= self.records:
            raise IndexError(index)
        start = struct.unpack_from("<I", self._maps["offsets"], index * 4)[0]
        end = struct.unpack_from("<I", self._maps["offsets"], (index + 1) * 4)[0]
        return PackRecord(
            url=bytes(self._maps["bytes"][start:end]),
            split=self._maps["splits"][index],
        )


class PackCorpus:
    def __init__(self, manifest_path: str | Path) -> None:
        self.manifest_path = Path(manifest_path).resolve()
        with self.manifest_path.open("r", encoding="utf-8") as stream:
            self.manifest: dict[str, Any] = json.load(stream)
        if self.manifest.get("schemaVersion") != 2:
            raise ValueError("unsupported training-pack manifest")
        if self.manifest.get("format") != "utf8-url-split-v2":
            raise ValueError("unsupported training-pack format")
        self.directory = self.manifest_path.parent
        self.shards: list[dict[str, Any]] = list(self.manifest["shards"])

    def open_shard(self, index: int) -> PackShard:
        return PackShard(self.directory, self.shards[index])


def selected(record: PackRecord, split: SplitName) -> bool:
    try:
        return record.split == SPLIT_VALUES[split]
    except KeyError as error:
        raise ValueError(f"unknown split: {split}") from error


def iter_selected(corpus: PackCorpus, split: SplitName) -> Iterator[PackRecord]:
    for shard_index in range(len(corpus.shards)):
        with corpus.open_shard(shard_index) as shard:
            for record_index in range(shard.records):
                record = shard.record(record_index)
                if selected(record, split):
                    yield record
