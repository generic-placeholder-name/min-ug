import { createHash } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { constants as zlibConstants, createGzip, type Gzip } from "node:zlib";

import { sha256File, sha256Text, writeJsonAtomic } from "../../lib/files.js";
import type {
  CanonicalizationBatchResult,
  CanonicalizationInput
} from "./canonicalize-batch.js";
import { readCandidateUrls } from "./candidates.js";
import { removeSafePath, type StorageGuard } from "./storage.js";
import type {
  CandidateFile,
  RejectionSample,
  StagingManifest,
  StagingShard
} from "./types.js";
import { CanonicalizationWorkerPool } from "./worker-pool.js";

interface ShardSink {
  readonly index: number;
  readonly path: string;
  readonly gzip: Gzip;
  readonly output: WriteStream;
  records: number;
}

class StagingShardWriter {
  private readonly sinks = new Map<number, ShardSink>();

  constructor (
    readonly directory: string,
    readonly shardCount: number
  ) {}

  private sink (index: number): ShardSink {
    const existing = this.sinks.get(index);
    if (existing !== undefined) return existing;
    const path = resolve(this.directory, `shard-${String(index).padStart(4, "0")}.jsonl.gz`);
    const output = createWriteStream(path, { flags: "wx" });
    const gzip = createGzip({ level: 1 });
    gzip.pipe(output);
    const sink = { index, path, gzip, output, records: 0 };
    this.sinks.set(index, sink);
    return sink;
  }

  async write (url: string, hostname: string): Promise<void> {
    const prefix = sha256Text(hostname).slice(0, 8);
    const sink = this.sink(Number.parseInt(prefix, 16) % this.shardCount);
    if (!sink.gzip.write(`${JSON.stringify({ url, hostname })}\n`)) {
      await once(sink.gzip, "drain");
    }
    sink.records += 1;
  }

  async flush (): Promise<void> {
    await Promise.all([...this.sinks.values()].map(async sink => {
      await new Promise<void>(resolveFlush => {
        sink.gzip.flush(zlibConstants.Z_SYNC_FLUSH, resolveFlush);
      });
    }));
  }

  async close (): Promise<StagingShard[]> {
    await Promise.all([...this.sinks.values()].map(async sink => {
      sink.gzip.end();
      await once(sink.output, "close");
    }));
    const shards: StagingShard[] = [];
    for (const sink of [...this.sinks.values()].sort((left, right) => left.index - right.index)) {
      const metadata = await stat(sink.path);
      shards.push({
        index: sink.index,
        path: basename(sink.path),
        records: sink.records,
        bytes: metadata.size,
        sha256: await sha256File(sink.path)
      });
    }
    return shards;
  }

  abort (): void {
    for (const sink of this.sinks.values()) {
      sink.gzip.destroy();
      sink.output.destroy();
    }
  }
}

export async function canonicalizerSourceHash (): Promise<string> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/canonicalize");
  const files: string[] = [];
  async function visit (directory: string): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
    }
  }
  await visit(root);
  const hash = createHash("sha256");
  for (const path of files.sort()) {
    hash.update(path.slice(root.length).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readJson<T> (path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function verifiedExistingManifest (
  path: string,
  directory: string,
  sourceManifestSha256: string,
  canonicalizerSha256: string,
  seed: string,
  requestedUrls: number,
  candidates: readonly CandidateFile[]
): Promise<StagingManifest | null> {
  try {
    const manifest = await readJson<StagingManifest>(path);
    if (
      manifest.schemaVersion !== 2 ||
      manifest.sourceManifestSha256 !== sourceManifestSha256 ||
      manifest.canonicalizerSha256 !== canonicalizerSha256 ||
      manifest.seed !== seed ||
      manifest.requestedUrls !== requestedUrls ||
      JSON.stringify(manifest.candidates) !== JSON.stringify(candidates)
    ) return null;
    for (const shard of manifest.shards) {
      const shardPath = resolve(directory, shard.path);
      if ((await stat(shardPath)).size !== shard.bytes || await sha256File(shardPath) !== shard.sha256) {
        return null;
      }
    }
    return manifest;
  } catch {
    return null;
  }
}

export interface StageCandidatesOptions {
  readonly candidates: readonly CandidateFile[];
  readonly sourceManifestSha256: string;
  readonly outputDirectory: string;
  readonly manifestPath: string;
  readonly workDirectory: string;
  readonly seed: string;
  readonly requestedUrls: number;
  readonly shardCount: number;
  readonly threads?: number;
  readonly canonicalizerWorkers?: number;
  readonly batchSize?: number;
  readonly rejectionSampleSize?: number;
  readonly storageGuard?: StorageGuard;
  readonly force?: boolean;
}

export async function stageCandidates (
  options: StageCandidatesOptions
): Promise<StagingManifest> {
  if (options.candidates.length === 0) throw new Error("At least one candidate file is required");
  for (const candidate of options.candidates) {
    const metadata = await stat(candidate.path);
    if (metadata.size !== candidate.bytes || await sha256File(candidate.path) !== candidate.sha256) {
      throw new Error(`Candidate file ${candidate.path} does not match its manifest`);
    }
  }
  const canonicalizerSha256 = await canonicalizerSourceHash();
  if (!options.force) {
    const existing = await verifiedExistingManifest(
      options.manifestPath,
      options.outputDirectory,
      options.sourceManifestSha256,
      canonicalizerSha256,
      options.seed,
      options.requestedUrls,
      options.candidates
    );
    if (existing !== null) return existing;
  }

  const temporaryDirectory = `${options.outputDirectory}.tmp`;
  await removeSafePath(options.workDirectory, temporaryDirectory);
  await removeSafePath(options.workDirectory, options.outputDirectory);
  await mkdir(temporaryDirectory, { recursive: true });
  const workerCount = options.canonicalizerWorkers ?? Math.max(1, cpus().length - 2);
  const pool = new CanonicalizationWorkerPool(workerCount);
  const writer = new StagingShardWriter(temporaryDirectory, options.shardCount);
  const batchSize = options.batchSize ?? 4096;
  const pending: Array<Promise<CanonicalizationBatchResult>> = [];
  const rejectionCounts: Record<string, number> = {};
  const rejectionSample: RejectionSample[] = [];
  const sampleLimit = options.rejectionSampleSize ?? 100;
  let candidates = 0;
  let accepted = 0;
  let rejected = 0;
  let batch: CanonicalizationInput[] = [];

  const commit = async (promise: Promise<CanonicalizationBatchResult>): Promise<void> => {
    const result = await promise;
    for (const record of result.accepted) {
      await writer.write(record.url, record.hostname);
      accepted += 1;
    }
    for (const failed of result.rejected) {
      rejected += 1;
      rejectionCounts[failed.code] = (rejectionCounts[failed.code] ?? 0) + 1;
      if (rejectionSample.length < sampleLimit) rejectionSample.push(failed);
    }
    if (accepted > 0 && accepted % 1_000_000 < batchSize) {
      await writer.flush();
      await options.storageGuard?.assertWithinBudget("staging Common Crawl candidates");
    }
  };

  const submit = async (): Promise<void> => {
    if (batch.length === 0) return;
    pending.push(pool.run(batch));
    batch = [];
    if (pending.length >= pool.capacity) await commit(pending.shift()!);
  };

  try {
    for await (const url of readCandidateUrls(options.candidates, options.threads ?? 1)) {
      candidates += 1;
      batch.push({ ordinal: candidates, url });
      if (batch.length >= batchSize) await submit();
    }
    await submit();
    while (pending.length > 0) await commit(pending.shift()!);
    const shards = await writer.close();
    await pool.close();
    await rename(temporaryDirectory, options.outputDirectory);
    const manifest: StagingManifest = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      sourceManifestSha256: options.sourceManifestSha256,
      canonicalizerSha256,
      seed: options.seed,
      requestedUrls: options.requestedUrls,
      shardCount: options.shardCount,
      candidates: options.candidates,
      counts: { candidates, accepted, rejected },
      rejectionCounts,
      rejectionSample,
      shards
    };
    await writeJsonAtomic(options.manifestPath, manifest);
    return manifest;
  } catch (error) {
    writer.abort();
    await pool.close();
    throw error;
  }
}
