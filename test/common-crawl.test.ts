import assert from "node:assert/strict";
import test from "node:test";

import { CanonicalizationWorkerPool } from "../tools/corpus/core/worker-pool.js";
import { assignHostSplits, type SplitRecord } from "../tools/corpus/core/splits.js";
import { CorpusSplit } from "../tools/corpus/core/types.js";
import { isAthenaUnloadDataObject } from "../tools/corpus/common-crawl/athena.js";
import { candidateBucketWidth, candidateUnloadSql, eligibleCountSql } from "../tools/corpus/common-crawl/query.js";
import type { CommonCrawlSourceManifest } from "../tools/corpus/common-crawl/types.js";

const source: CommonCrawlSourceManifest = {
  schemaVersion: 1,
  id: "cc-test",
  crawl: "CC-MAIN-2026-30",
  description: "test",
  index: {
    database: "ccindex",
    table: "ccindex",
    location: "s3://commoncrawl/cc-index/table/cc-main/warc/"
  },
  sampling: {
    profile: "balanced-v1",
    seed: "cc-test-seed",
    candidateMultiplier: 2,
    hostBalancedFraction: 0.8,
    maximumUrlsPerHost: 16,
    hashBuckets: 1_000_000,
    protocols: ["http", "https"],
    statuses: [200],
    mimeTypes: ["text/html", "application/pdf"]
  }
};

test("Common Crawl queries pin the crawl, filters, and deterministic bucket range", () => {
  const count = eligibleCountSql(source);
  assert.match(count, /CC-MAIN-2026-30/u);
  assert.match(count, /fetch_status IN \(200\)/u);
  assert.match(count, /content_mime_detected/u);
  const unload = candidateUnloadSql(source, 12, 34, "s3://example/output/");
  assert.match(unload, /xxhash64/u);
  assert.match(unload, />= 12/u);
  assert.match(unload, /< 34/u);
  assert.match(unload, /format = 'PARQUET'/u);
  assert.equal(candidateBucketWidth(source, 10_000, 1_000_000), 20_000);
});

test("Athena UNLOAD discovery accepts extensionless Parquet objects", () => {
  assert.equal(isAthenaUnloadDataObject("export/part.parquet", 10), true);
  assert.equal(isAthenaUnloadDataObject("export/athena-generated-uuid", 10), true);
  assert.equal(isAthenaUnloadDataObject("export/", 10), false);
  assert.equal(isAthenaUnloadDataObject("export/_SUCCESS", 0), false);
  assert.equal(isAthenaUnloadDataObject(undefined, 10), false);
});

test("five-way splits are deterministic and leakage-safe", () => {
  const options = { seed: "partition-test", validationFraction: 0.1, testFraction: 0.1 };
  for (let hostIndex = 0; hostIndex < 200; hostIndex += 1) {
    const hostname = `host-${hostIndex}.example`;
    const records: SplitRecord[] = Array.from(
      { length: hostIndex % 11 + 1 },
      (_, index) => ({ url: `https://${hostname}/${index}` })
    );
    const first = records.map(record => ({ ...record }));
    const second = records.map(record => ({ ...record }));
    assignHostSplits(hostname, first, options);
    assignHostSplits(hostname, second, options);
    assert.deepEqual(first, second);
    const values = new Set(first.map(record => record.split));
    if (values.has(CorpusSplit.UnseenHostValidation)) {
      assert.deepEqual(values, new Set([CorpusSplit.UnseenHostValidation]));
    } else if (values.has(CorpusSplit.UnseenHostTest)) {
      assert.deepEqual(values, new Set([CorpusSplit.UnseenHostTest]));
    } else {
      assert(values.has(CorpusSplit.Train));
      assert([...values].every(split =>
        split === CorpusSplit.Train ||
        split === CorpusSplit.SeenHostValidation ||
        split === CorpusSplit.SeenHostTest
      ));
    }
  }
});

test("canonicalization worker executes Clean without source-specific fields", async () => {
  const pool = new CanonicalizationWorkerPool(1);
  try {
    const result = await pool.run([{
      ordinal: 1,
      url: "https://example.com/path?fbclid=tracking"
    }]);
    assert.deepEqual(result.accepted[0], {
      ordinal: 1,
      url: "https://example.com/path",
      hostname: "example.com"
    });
  } finally {
    await pool.close();
  }
});
