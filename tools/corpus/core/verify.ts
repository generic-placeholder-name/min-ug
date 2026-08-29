import { open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";

import { sha256File } from "../../lib/files.js";
import { emptySplitCounts, incrementSplitCount, isCorpusSplit } from "./splits.js";
import {
  CorpusSplit,
  type CorpusManifest,
  type TrainingPackManifest
} from "./types.js";

function sqlString (value: string): string {
  return `'${value.replaceAll("'", "''").replaceAll("\\", "/")}'`;
}

async function readJson<T> (path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function verifyCorpus (
  corpusDirectory: string,
  manifestPath: string,
  threads = 1
): Promise<CorpusManifest> {
  const manifest = await readJson<CorpusManifest>(manifestPath);
  if (manifest.schemaVersion !== 2 || manifest.format !== "canonical-url-split-v1") {
    throw new Error("Unsupported corpus manifest format");
  }
  const instance = await DuckDBInstance.create(":memory:", { threads: String(threads) });
  const connection = await instance.connect();
  const hosts = new Map<string, number>();
  const observedSplits = emptySplitCounts();
  let records = 0;
  try {
    for (const shard of manifest.shards) {
      const path = resolve(corpusDirectory, shard.path);
      const metadata = await stat(path);
      if (metadata.size !== shard.bytes || await sha256File(path) !== shard.sha256) {
        throw new Error(`Parquet shard ${shard.path} does not match its manifest`);
      }
      const description = await connection.runAndReadAll(
        `DESCRIBE SELECT * FROM read_parquet(${sqlString(path)})`
      );
      const described = description.getRows().map(row => [String(row[0]), String(row[1])]);
      const expected = [["url", "VARCHAR"], ["split", "UTINYINT"]];
      if (JSON.stringify(described) !== JSON.stringify(expected)) {
        throw new Error(`Parquet shard ${shard.path} has an unexpected schema`);
      }
      const summary = await connection.runAndReadAll(`
        SELECT
          count(*)::UBIGINT,
          count(DISTINCT url)::UBIGINT,
          count_if(url IS NULL OR url = '' OR split > ${CorpusSplit.UnseenHostTest})
        FROM read_parquet(${sqlString(path)})
      `);
      const summaryRow = summary.getRows()[0]!;
      const shardRecords = Number(summaryRow[0]);
      const distinctUrls = Number(summaryRow[1]);
      const invalidRows = Number(summaryRow[2]);
      if (shardRecords !== shard.records) {
        throw new Error(
          `Parquet shard ${shard.path} declares ${shard.records} rows but contains ${shardRecords}`
        );
      }
      if (distinctUrls !== shardRecords) {
        throw new Error(
          `Parquet shard ${shard.path} contains ${shardRecords - distinctUrls} duplicate URL rows`
        );
      }
      if (invalidRows !== 0) {
        throw new Error(`Parquet shard ${shard.path} contains ${invalidRows} invalid rows`);
      }

      const result = await connection.stream(
        `SELECT url, split FROM read_parquet(${sqlString(path)})`
      );
      for await (const rows of result.yieldRows()) {
        for (const row of rows) {
          const url = String(row[0]);
          const split = Number(row[1]);
          if (!isCorpusSplit(split)) throw new Error(`Invalid split ${split}`);
          incrementSplitCount(observedSplits, split);
          const hostname = new URL(url).hostname.toLowerCase();
          hosts.set(hostname, (hosts.get(hostname) ?? 0) | (1 << split));
        }
      }
      records += shardRecords;
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  for (const [hostname, mask] of hosts) {
    const unseenValidation = 1 << CorpusSplit.UnseenHostValidation;
    const unseenTest = 1 << CorpusSplit.UnseenHostTest;
    if ((mask & unseenValidation) !== 0 && mask !== unseenValidation) {
      throw new Error(`Unseen-validation hostname ${hostname} crosses splits`);
    }
    if ((mask & unseenTest) !== 0 && mask !== unseenTest) {
      throw new Error(`Unseen-test hostname ${hostname} crosses splits`);
    }
    const seenEvaluation = (1 << CorpusSplit.SeenHostValidation) | (1 << CorpusSplit.SeenHostTest);
    if ((mask & seenEvaluation) !== 0 && (mask & (1 << CorpusSplit.Train)) === 0) {
      throw new Error(`Seen-host evaluation hostname ${hostname} has no training URL`);
    }
  }
  if (records !== manifest.counts.finalUrls || records !== manifest.sampling.requestedUrls) {
    throw new Error(`Corpus expected ${manifest.sampling.requestedUrls} rows; verified ${records}`);
  }
  if (hosts.size !== manifest.counts.distinctHosts) {
    throw new Error(`Corpus expected ${manifest.counts.distinctHosts} hosts; verified ${hosts.size}`);
  }
  if (JSON.stringify(observedSplits) !== JSON.stringify(manifest.splits)) {
    throw new Error("Corpus split counts do not match its manifest");
  }
  return manifest;
}

async function verifyOffsets (path: string, records: number, urlBytes: number): Promise<void> {
  const handle = await open(path, "r");
  try {
    const expectedBytes = (records + 1) * 4;
    if ((await handle.stat()).size !== expectedBytes) throw new Error("Pack offsets have wrong size");
    const chunk = Buffer.allocUnsafe(4 * 16384);
    let position = 0;
    let previous = 0;
    while (position < expectedBytes) {
      const length = Math.min(chunk.length, expectedBytes - position);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead !== length) throw new Error("Pack offsets ended early");
      for (let offset = 0; offset < bytesRead; offset += 4) {
        const value = chunk.readUInt32LE(offset);
        if (value < previous) throw new Error("Pack offsets are not monotonic");
        previous = value;
      }
      position += bytesRead;
    }
    if (previous !== urlBytes) throw new Error("Final pack offset does not equal URL byte length");
  } finally {
    await handle.close();
  }
}

async function verifySplits (path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    const size = (await handle.stat()).size;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead === 0) throw new Error("Pack splits ended early");
      for (let index = 0; index < bytesRead; index += 1) {
        if (!isCorpusSplit(buffer[index]!)) throw new Error("Pack contains an invalid split value");
      }
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

export async function verifyTrainingPack (
  packDirectory: string,
  manifestPath: string,
  corpusManifestPath?: string
): Promise<TrainingPackManifest> {
  const manifest = await readJson<TrainingPackManifest>(manifestPath);
  if (manifest.schemaVersion !== 2 || manifest.format !== "utf8-url-split-v2") {
    throw new Error("Unsupported training-pack format");
  }
  if (corpusManifestPath && await sha256File(corpusManifestPath) !== manifest.corpusManifestSha256) {
    throw new Error("Training pack was built from a different corpus manifest");
  }
  let records = 0;
  let urlBytes = 0;
  for (const shard of manifest.shards) {
    for (const file of Object.values(shard.files)) {
      const path = resolve(packDirectory, file.path);
      if ((await stat(path)).size !== file.bytes || await sha256File(path) !== file.sha256) {
        throw new Error(`Pack file ${file.path} does not match its manifest`);
      }
    }
    if (shard.files.bytes.bytes !== shard.urlBytes) throw new Error("Pack byte count is inconsistent");
    if (shard.files.splits.bytes !== shard.records) throw new Error("Pack splits have wrong size");
    await verifyOffsets(resolve(packDirectory, shard.files.offsets.path), shard.records, shard.urlBytes);
    await verifySplits(resolve(packDirectory, shard.files.splits.path));
    records += shard.records;
    urlBytes += shard.urlBytes;
  }
  if (records !== manifest.counts.records || urlBytes !== manifest.counts.urlBytes) {
    throw new Error("Pack totals do not match its manifest");
  }
  return manifest;
}
