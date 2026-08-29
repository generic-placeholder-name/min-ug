import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { once } from "node:events";
import { basename, resolve } from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";

import { sha256File, writeJsonAtomic } from "../../lib/files.js";
import { isCorpusSplit } from "./splits.js";
import { removeSafePath } from "./storage.js";
import {
  CorpusSplit,
  type CorpusManifest,
  type FileMetadata,
  type TrainingPackManifest,
  type TrainingPackShard
} from "./types.js";

function sqlString (value: string): string {
  return `'${value.replaceAll("'", "''").replaceAll("\\", "/")}'`;
}

async function writeBuffer (stream: WriteStream, buffer: Uint8Array): Promise<void> {
  if (!stream.write(buffer)) await once(stream, "drain");
}

async function closeStream (stream: WriteStream): Promise<void> {
  stream.end();
  await once(stream, "close");
}

interface OpenPackShard {
  readonly index: number;
  readonly baseName: string;
  readonly streams: {
    readonly bytes: WriteStream;
    readonly offsets: WriteStream;
    readonly splits: WriteStream;
  };
  records: number;
  urlBytes: number;
}

class PackWriter {
  private current: OpenPackShard | undefined;
  private nextIndex = 0;
  readonly shards: TrainingPackShard[] = [];

  constructor (
    readonly directory: string,
    readonly targetShardBytes: number
  ) {
    if (targetShardBytes <= 0 || targetShardBytes >= 0xffffffff) {
      throw new Error("Pack target shard size must be between 1 byte and 4 GiB");
    }
  }

  private async open (): Promise<OpenPackShard> {
    const index = this.nextIndex++;
    const baseName = `part-${String(index).padStart(4, "0")}`;
    const streams = {
      bytes: createWriteStream(resolve(this.directory, `${baseName}.bytes`), { flags: "wx" }),
      offsets: createWriteStream(resolve(this.directory, `${baseName}.offsets`), { flags: "wx" }),
      splits: createWriteStream(resolve(this.directory, `${baseName}.splits`), { flags: "wx" })
    };
    const shard = { index, baseName, streams, records: 0, urlBytes: 0 };
    await writeBuffer(streams.offsets, Buffer.alloc(4));
    this.current = shard;
    return shard;
  }

  private async metadata (path: string): Promise<FileMetadata> {
    const file = await stat(path);
    return { path: basename(path), bytes: file.size, sha256: await sha256File(path) };
  }

  private async closeCurrent (): Promise<void> {
    const shard = this.current;
    if (shard === undefined) return;
    await Promise.all(Object.values(shard.streams).map(closeStream));
    this.shards.push({
      index: shard.index,
      records: shard.records,
      urlBytes: shard.urlBytes,
      files: {
        bytes: await this.metadata(resolve(this.directory, `${shard.baseName}.bytes`)),
        offsets: await this.metadata(resolve(this.directory, `${shard.baseName}.offsets`)),
        splits: await this.metadata(resolve(this.directory, `${shard.baseName}.splits`))
      }
    });
    this.current = undefined;
  }

  async append (url: string, split: number): Promise<void> {
    const encoded = Buffer.from(url, "utf8");
    if (encoded.length >= 0xffffffff) throw new Error("One URL exceeds the pack offset range");
    if (!isCorpusSplit(split)) throw new Error(`Invalid corpus split ${split}`);
    let shard = this.current ?? await this.open();
    if (shard.records > 0 && shard.urlBytes + encoded.length > this.targetShardBytes) {
      await this.closeCurrent();
      shard = await this.open();
    }
    await writeBuffer(shard.streams.bytes, encoded);
    shard.urlBytes += encoded.length;
    const offset = Buffer.allocUnsafe(4);
    offset.writeUInt32LE(shard.urlBytes);
    await writeBuffer(shard.streams.offsets, offset);
    await writeBuffer(shard.streams.splits, Uint8Array.of(split));
    shard.records += 1;
  }

  async close (): Promise<readonly TrainingPackShard[]> {
    await this.closeCurrent();
    return this.shards;
  }

  abort (): void {
    if (this.current === undefined) return;
    for (const stream of Object.values(this.current.streams)) stream.destroy();
    this.current = undefined;
  }
}

async function readJson<T> (path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export interface BuildTrainingPackOptions {
  readonly corpusDirectory: string;
  readonly corpusManifestPath: string;
  readonly outputDirectory: string;
  readonly targetShardBytes: number;
  readonly threads: number;
  readonly force?: boolean;
}

export async function buildTrainingPack (
  options: BuildTrainingPackOptions
): Promise<TrainingPackManifest> {
  const corpus = await readJson<CorpusManifest>(options.corpusManifestPath);
  const corpusManifestSha256 = await sha256File(options.corpusManifestPath);
  const manifestPath = resolve(options.outputDirectory, "manifest.json");
  if (!options.force) {
    try {
      const existing = await readJson<TrainingPackManifest>(manifestPath);
      if (existing.corpusManifestSha256 === corpusManifestSha256) {
        let valid = true;
        for (const shard of existing.shards) {
          for (const file of Object.values(shard.files)) {
            const path = resolve(options.outputDirectory, file.path);
            if ((await stat(path)).size !== file.bytes || await sha256File(path) !== file.sha256) {
              valid = false;
            }
          }
        }
        if (valid) return existing;
      }
    } catch {
      // Rebuild an incomplete or stale pack below.
    }
  }

  const parent = resolve(options.outputDirectory, "..");
  const temporaryDirectory = `${options.outputDirectory}.tmp`;
  await removeSafePath(parent, temporaryDirectory);
  await removeSafePath(parent, options.outputDirectory);
  await mkdir(temporaryDirectory, { recursive: true });
  const writer = new PackWriter(temporaryDirectory, options.targetShardBytes);
  const instance = await DuckDBInstance.create(":memory:", { threads: String(options.threads) });
  const connection = await instance.connect();
  try {
    for (const shard of corpus.shards) {
      const parquetPath = resolve(options.corpusDirectory, shard.path);
      const result = await connection.stream(`
        SELECT url, split
        FROM read_parquet(${sqlString(parquetPath)})
        ORDER BY url
      `);
      for await (const rows of result.yieldRows()) {
        for (const row of rows) await writer.append(String(row[0]), Number(row[1]));
      }
    }
    const shards = await writer.close();
    const manifest: TrainingPackManifest = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      format: "utf8-url-split-v2",
      byteOrder: "little-endian",
      splitEncoding: {
        train: CorpusSplit.Train,
        seenHostValidation: CorpusSplit.SeenHostValidation,
        seenHostTest: CorpusSplit.SeenHostTest,
        unseenHostValidation: CorpusSplit.UnseenHostValidation,
        unseenHostTest: CorpusSplit.UnseenHostTest
      },
      corpusManifestSha256,
      counts: {
        records: shards.reduce((total, shard) => total + shard.records, 0),
        urlBytes: shards.reduce((total, shard) => total + shard.urlBytes, 0)
      },
      shards
    };
    await writeJsonAtomic(resolve(temporaryDirectory, "manifest.json"), manifest);
    connection.closeSync();
    instance.closeSync();
    await rename(temporaryDirectory, options.outputDirectory);
    return manifest;
  } catch (error) {
    writer.abort();
    await removeSafePath(parent, temporaryDirectory);
    throw error;
  } finally {
    try { connection.closeSync(); } catch {}
    try { instance.closeSync(); } catch {}
  }
}
