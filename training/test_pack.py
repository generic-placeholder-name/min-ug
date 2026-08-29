from __future__ import annotations

import json
import struct
import tempfile
import unittest
from pathlib import Path

from training.pack import PackCorpus, selected


class PackReaderTest(unittest.TestCase):
    def test_reads_offsets_and_splits(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            urls = [b"https://a.example/", b"https://b.example/path"]
            (directory / "part-0000.bytes").write_bytes(b"".join(urls))
            (directory / "part-0000.offsets").write_bytes(
                struct.pack("<III", 0, len(urls[0]), sum(map(len, urls)))
            )
            (directory / "part-0000.splits").write_bytes(bytes([0, 4]))
            manifest = {
                "schemaVersion": 2,
                "format": "utf8-url-split-v2",
                "shards": [{
                    "records": 2,
                    "files": {
                        "bytes": {"path": "part-0000.bytes"},
                        "offsets": {"path": "part-0000.offsets"},
                        "splits": {"path": "part-0000.splits"},
                    },
                }],
            }
            manifest_path = directory / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            corpus = PackCorpus(manifest_path)
            with corpus.open_shard(0) as shard:
                first = shard.record(0)
                second = shard.record(1)
            self.assertEqual(first.url, urls[0])
            self.assertEqual(first.split, 0)
            self.assertTrue(selected(first, "train"))
            self.assertEqual(second.split, 4)
            self.assertTrue(selected(second, "unseen-test"))


if __name__ == "__main__":
    unittest.main()
