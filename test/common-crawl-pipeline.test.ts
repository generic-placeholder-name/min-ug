import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createGzip } from "node:zlib";

import { DuckDBInstance } from "@duckdb/node-api";

import { sha256File } from "../tools/lib/files.js";
import { buildTrainingPack } from "../tools/corpus/core/pack.js";
import { materializeCorpus } from "../tools/corpus/core/materialize.js";
import { stageCandidates } from "../tools/corpus/core/stage.js";
import { verifyCorpus, verifyTrainingPack } from "../tools/corpus/core/verify.js";
import type { CandidateFile } from "../tools/corpus/core/types.js";

async function writeLargeStagingShard (path: string, records: number): Promise<void> {
  const output = createWriteStream(path, { flags: "wx" });
  const gzip = createGzip({ level: 1 });
  gzip.pipe(output);
  for (let index = 0; index < records; index += 1) {
    const suffix = String(index).padStart(6, "0");
    if (!gzip.write(`${JSON.stringify({
      url: `https://h${suffix}.example/u`,
      hostname: `h${suffix}.example`
    })}\n`)) await once(gzip, "drain");
  }
  gzip.end();
  await once(output, "close");
}

function sqlString (value: string): string {
  return `'${value.replaceAll("'", "''").replaceAll("\\", "/")}'`;
}

test("sampled candidates become an exact, deduplicated, split corpus and lean pack", async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), "minug-common-crawl-"));
  t.after(async () => await rm(temporary, { recursive: true, force: true }));
  const candidatePath = resolve(temporary, "candidates.jsonl");
  const rawUrls = [
    "https://one.example/a?fbclid=first",
    "https://one.example/a?fbclid=second",
    "https://one.example/b",
    "https://two.example/a",
    "https://two.example/b",
    "https://three.example/a",
    "https://four.example/a",
    "https://five.example/a",
    "https://six.example/a",
    "https://seven.example/a",
    "mailto:test@example.com"
  ];
  await writeFile(candidatePath, rawUrls.map(url => JSON.stringify({ url })).join("\n") + "\n");
  const metadata = await stat(candidatePath);
  const candidate: CandidateFile = {
    path: candidatePath,
    format: "jsonl",
    bytes: metadata.size,
    sha256: await sha256File(candidatePath)
  };
  const work = resolve(temporary, "work");
  const staging = resolve(work, "staging");
  const corpusDirectory = resolve(temporary, "corpus");
  const packDirectory = resolve(temporary, "pack");
  const stagingManifestPath = resolve(work, "staging.manifest.json");
  const corpusManifestPath = resolve(corpusDirectory, "manifest.json");
  const packManifestPath = resolve(packDirectory, "manifest.json");

  const staged = await stageCandidates({
    candidates: [candidate],
    sourceManifestSha256: "a".repeat(64),
    outputDirectory: staging,
    manifestPath: stagingManifestPath,
    workDirectory: work,
    seed: "sample-seed",
    requestedUrls: 7,
    shardCount: 4,
    threads: 1,
    canonicalizerWorkers: 0,
    batchSize: 2
  });
  assert.equal(staged.counts.candidates, rawUrls.length);
  assert.equal(staged.counts.accepted, rawUrls.length - 1);
  assert.equal(staged.counts.rejected, 1);

  const manifest = await materializeCorpus({
    stagingDirectory: staging,
    stagingManifestPath,
    outputDirectory: corpusDirectory,
    manifestPath: corpusManifestPath,
    workDirectory: work,
    corpusId: "cc-test",
    sourceManifestSha256: "a".repeat(64),
    crawl: "CC-MAIN-2026-30",
    samplingProfile: "balanced-v1",
    requestedUrls: 7,
    hostBalancedFraction: 0.8,
    maximumUrlsPerHost: 2,
    candidateMultiplier: 2,
    seed: "sample-seed",
    validationFraction: 0.1,
    testFraction: 0.1,
    threads: 1,
    memoryLimit: "512MB",
    maximumTemporaryDirectorySize: "1GB"
  });
  assert.equal(manifest.counts.acceptedBeforeDedupe, 10);
  assert.equal(manifest.counts.uniqueBeforeSelection, 9);
  assert.equal(manifest.counts.finalUrls, 7);
  assert.equal(
    (Object.values(manifest.splits) as number[]).reduce((sum, count) => sum + count, 0),
    7
  );
  await verifyCorpus(corpusDirectory, corpusManifestPath);

  const instance = await DuckDBInstance.create();
  const connection = await instance.connect();
  try {
    const rows = (await connection.runAndReadAll(`
      SELECT url, split
      FROM read_parquet(${sqlString(resolve(corpusDirectory, "part-0000.parquet"))})
      ORDER BY url
    `)).getRows();
    assert.equal(rows.length, 7);
    assert(rows.every(row => Number(row[1]) >= 0 && Number(row[1]) <= 4));
    assert.equal(new Set(rows.map(row => String(row[0]))).size, 7);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }

  const pack = await buildTrainingPack({
    corpusDirectory,
    corpusManifestPath,
    outputDirectory: packDirectory,
    targetShardBytes: 32,
    threads: 1
  });
  assert.equal(pack.schemaVersion, 2);
  assert.equal(pack.counts.records, 7);
  assert(pack.shards.length >= 2);
  assert(pack.shards.every(shard => !("weights" in shard.files) && !("partitions" in shard.files)));
  await verifyTrainingPack(packDirectory, packManifestPath, corpusManifestPath);

  const repeated = await materializeCorpus({
    stagingDirectory: staging,
    stagingManifestPath,
    outputDirectory: corpusDirectory,
    manifestPath: corpusManifestPath,
    workDirectory: work,
    corpusId: "cc-test",
    sourceManifestSha256: "a".repeat(64),
    crawl: "CC-MAIN-2026-30",
    samplingProfile: "balanced-v1",
    requestedUrls: 7,
    hostBalancedFraction: 0.8,
    maximumUrlsPerHost: 2,
    candidateMultiplier: 2,
    seed: "sample-seed",
    validationFraction: 0.1,
    testFraction: 0.1,
    threads: 1,
    memoryLimit: "512MB",
    maximumTemporaryDirectorySize: "1GB"
  });
  assert.deepEqual(repeated.shards, manifest.shards);
  assert.equal(JSON.parse(await readFile(corpusManifestPath, "utf8")).counts.finalUrls, 7);
});

test("materialization writes every row beyond DuckDB's appender buffer", async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), "minug-common-crawl-appender-"));
  t.after(async () => await rm(temporary, { recursive: true, force: true }));
  const recordCount = 210_000;
  const work = resolve(temporary, "work");
  const staging = resolve(work, "staging");
  const corpusDirectory = resolve(temporary, "corpus");
  const stagingManifestPath = resolve(work, "staging.manifest.json");
  const corpusManifestPath = resolve(corpusDirectory, "manifest.json");
  await mkdir(staging, { recursive: true });
  const shardPath = resolve(staging, "shard-0000.jsonl.gz");
  await writeLargeStagingShard(shardPath, recordCount);
  const shard = await stat(shardPath);
  await writeFile(stagingManifestPath, JSON.stringify({
    schemaVersion: 2,
    createdAt: new Date(0).toISOString(),
    sourceManifestSha256: "a".repeat(64),
    canonicalizerSha256: "b".repeat(64),
    seed: "appender-regression",
    requestedUrls: recordCount,
    shardCount: 1,
    candidates: [],
    counts: { candidates: recordCount, accepted: recordCount, rejected: 0 },
    rejectionCounts: {},
    rejectionSample: [],
    shards: [{
      index: 0,
      path: "shard-0000.jsonl.gz",
      records: recordCount,
      bytes: shard.size,
      sha256: await sha256File(shardPath)
    }]
  }));

  const manifest = await materializeCorpus({
    stagingDirectory: staging,
    stagingManifestPath,
    outputDirectory: corpusDirectory,
    manifestPath: corpusManifestPath,
    workDirectory: work,
    corpusId: "cc-appender-test",
    sourceManifestSha256: "a".repeat(64),
    crawl: "CC-MAIN-2026-30",
    samplingProfile: "balanced-v1",
    requestedUrls: recordCount,
    hostBalancedFraction: 1,
    maximumUrlsPerHost: 1,
    candidateMultiplier: 2,
    seed: "appender-regression",
    validationFraction: 0.1,
    testFraction: 0.1,
    threads: 2,
    memoryLimit: "512MB",
    maximumTemporaryDirectorySize: "1GB"
  });
  assert.equal(manifest.counts.finalUrls, recordCount);
  assert.equal(
    (Object.values(manifest.splits) as number[]).reduce((sum, count) => sum + count, 0),
    recordCount
  );
  await verifyCorpus(corpusDirectory, corpusManifestPath, 2);
});
