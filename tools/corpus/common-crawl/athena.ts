import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";

import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand
} from "@aws-sdk/client-athena";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client
} from "@aws-sdk/client-s3";

import { sha256File, writeJsonAtomic } from "../../lib/files.js";
import type { CandidateFile } from "../core/types.js";
import { candidateBucketWidth, candidateUnloadSql, addPartitionSql, createTableSql, eligibleCountSql } from "./query.js";
import type {
  AcquisitionManifest,
  AcquisitionRound,
  CommonCrawlSourceManifest
} from "./types.js";

interface S3Location {
  readonly bucket: string;
  readonly prefix: string;
}

export function isAthenaUnloadDataObject (
  key: string | undefined,
  size: number | undefined
): key is string {
  // UNLOAD owns an otherwise-empty prefix, and Athena currently gives its Parquet data
  // objects no filename extension. Size excludes directory markers and success sentinels.
  return key !== undefined && !key.endsWith("/") && (size ?? 0) > 0;
}

function parseS3Location (uri: string): S3Location {
  const match = /^s3:\/\/([^/]+)\/(.*)$/u.exec(uri);
  if (!match) throw new Error(`Expected an S3 URI with a prefix, received ${JSON.stringify(uri)}`);
  return { bucket: match[1]!, prefix: match[2]!.replace(/^\/+|\/+$/gu, "") };
}

function joinS3 (base: string, ...parts: readonly string[]): string {
  return `${base.replace(/\/+$/u, "")}/${parts.map(part => part.replace(/^\/+|\/+$/gu, "")).join("/")}/`;
}

async function readJson<T> (path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function delay (milliseconds: number): Promise<void> {
  await new Promise<void>(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

export interface AthenaSamplerOptions {
  readonly source: CommonCrawlSourceManifest;
  readonly sourceManifestSha256: string;
  readonly requestedUrls: number;
  readonly athenaOutput: string;
  readonly localDirectory: string;
  readonly manifestPath: string;
  readonly region: string;
  readonly workgroup?: string;
}

export class AthenaSampler {
  readonly athena: AthenaClient;
  readonly s3: S3Client;

  constructor (readonly options: AthenaSamplerOptions) {
    this.athena = new AthenaClient({ region: options.region });
    this.s3 = new S3Client({ region: options.region });
  }

  private async runQuery (sql: string): Promise<string> {
    const resultLocation = joinS3(this.options.athenaOutput, "query-results");
    const started = await this.athena.send(new StartQueryExecutionCommand({
      QueryString: sql,
      ResultConfiguration: { OutputLocation: resultLocation },
      ...(this.options.workgroup === undefined ? {} : { WorkGroup: this.options.workgroup })
    }));
    const id = started.QueryExecutionId;
    if (id === undefined) throw new Error("Athena did not return a query execution ID");
    for (;;) {
      const response = await this.athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
      const status = response.QueryExecution?.Status;
      if (status?.State === "SUCCEEDED") return id;
      if (status?.State === "FAILED" || status?.State === "CANCELLED") {
        throw new Error(`Athena query ${status.State.toLowerCase()}: ${status.StateChangeReason ?? "unknown reason"}`);
      }
      await delay(2000);
    }
  }

  private async ensureTable (): Promise<void> {
    const database = this.options.source.index.database;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(database)) throw new Error("Unsafe Athena database name");
    await this.runQuery(`CREATE DATABASE IF NOT EXISTS ${database}`);
    await this.runQuery(createTableSql(this.options.source));
    await this.runQuery(addPartitionSql(this.options.source));
  }

  private async eligibleRows (): Promise<number> {
    const queryExecutionId = await this.runQuery(eligibleCountSql(this.options.source));
    const result = await this.athena.send(new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId }));
    const rows = result.ResultSet?.Rows ?? [];
    const value = rows[1]?.Data?.[0]?.VarCharValue;
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error(`Athena returned an invalid eligible-row count: ${JSON.stringify(value)}`);
    }
    return count;
  }

  private async listParquetObjects (uri: string): Promise<{ bucket: string; keys: string[] }> {
    const location = parseS3Location(uri);
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.s3.send(new ListObjectsV2Command({
        Bucket: location.bucket,
        Prefix: location.prefix,
        ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken })
      }));
      for (const object of response.Contents ?? []) {
        if (isAthenaUnloadDataObject(object.Key, object.Size)) keys.push(object.Key);
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    if (keys.length === 0) throw new Error(`Athena UNLOAD produced no Parquet files under ${uri}`);
    return { bucket: location.bucket, keys: keys.sort() };
  }

  private async downloadObject (
    bucket: string,
    key: string,
    roundIndex: number,
    fileIndex: number
  ): Promise<CandidateFile> {
    const response = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (response.Body === undefined) throw new Error(`S3 object s3://${bucket}/${key} has no body`);
    const name = `round-${String(roundIndex).padStart(4, "0")}-${String(fileIndex).padStart(5, "0")}.parquet`;
    const path = resolve(this.options.localDirectory, name);
    const temporary = `${path}.part`;
    await rm(temporary, { force: true });
    const body = response.Body as unknown as Readable;
    await pipeline(body, createWriteStream(temporary, { flags: "wx" }));
    await rename(temporary, path);
    const metadata = await stat(path);
    return {
      path,
      format: "parquet",
      bytes: metadata.size,
      sha256: await sha256File(path),
      remoteUri: `s3://${bucket}/${key}`
    };
  }

  private async exportRound (
    index: number,
    bucketStart: number,
    bucketEnd: number,
    runId: string
  ): Promise<AcquisitionRound> {
    const remotePrefix = joinS3(
      this.options.athenaOutput,
      "exports",
      this.options.source.id,
      runId,
      `round-${String(index).padStart(4, "0")}`
    );
    const queryExecutionId = await this.runQuery(candidateUnloadSql(
      this.options.source,
      bucketStart,
      bucketEnd,
      remotePrefix
    ));
    const objects = await this.listParquetObjects(remotePrefix);
    const files: CandidateFile[] = [];
    for (let fileIndex = 0; fileIndex < objects.keys.length; fileIndex += 1) {
      files.push(await this.downloadObject(objects.bucket, objects.keys[fileIndex]!, index, fileIndex));
    }
    return { index, bucketStart, bucketEnd, remotePrefix, queryExecutionId, files };
  }

  async loadVerified (): Promise<AcquisitionManifest | null> {
    try {
      const manifest = await readJson<AcquisitionManifest>(this.options.manifestPath);
      if (
        manifest.schemaVersion !== 1 ||
        manifest.sourceManifestSha256 !== this.options.sourceManifestSha256 ||
        manifest.requestedUrls !== this.options.requestedUrls ||
        manifest.athenaOutput !== this.options.athenaOutput
      ) return null;
      for (const file of manifest.rounds.flatMap(round => round.files)) {
        if ((await stat(file.path)).size !== file.bytes || await sha256File(file.path) !== file.sha256) {
          return null;
        }
      }
      return manifest;
    } catch {
      return null;
    }
  }

  async acquireInitial (): Promise<AcquisitionManifest> {
    const existing = await this.loadVerified();
    if (existing !== null) return existing;
    await rm(this.options.localDirectory, { recursive: true, force: true });
    await mkdir(this.options.localDirectory, { recursive: true });
    await this.ensureTable();
    const eligibleRows = await this.eligibleRows();
    const width = candidateBucketWidth(this.options.source, this.options.requestedUrls, eligibleRows);
    const runId = randomUUID();
    const round = await this.exportRound(0, 0, Math.min(width, this.options.source.sampling.hashBuckets), runId);
    const manifest: AcquisitionManifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      sourceManifestSha256: this.options.sourceManifestSha256,
      requestedUrls: this.options.requestedUrls,
      eligibleRows,
      athenaOutput: this.options.athenaOutput,
      rounds: [round]
    };
    await writeJsonAtomic(this.options.manifestPath, manifest);
    return manifest;
  }

  async acquireNext (manifest: AcquisitionManifest): Promise<AcquisitionManifest> {
    const previous = manifest.rounds.at(-1);
    if (previous === undefined) throw new Error("Cannot extend an acquisition with no rounds");
    const width = candidateBucketWidth(
      this.options.source,
      this.options.requestedUrls,
      manifest.eligibleRows
    );
    const bucketStart = previous.bucketEnd;
    if (bucketStart >= this.options.source.sampling.hashBuckets) {
      throw new Error("All Common Crawl sampling hash buckets were exhausted");
    }
    const bucketEnd = Math.min(bucketStart + width, this.options.source.sampling.hashBuckets);
    const runId = parseS3Location(previous.remotePrefix).prefix.split("/").at(-2) ?? randomUUID();
    const round = await this.exportRound(manifest.rounds.length, bucketStart, bucketEnd, runId);
    const updated = { ...manifest, rounds: [...manifest.rounds, round] };
    await writeJsonAtomic(this.options.manifestPath, updated);
    return updated;
  }
}

export function acquisitionCandidates (manifest: AcquisitionManifest): CandidateFile[] {
  return manifest.rounds.flatMap(round => round.files);
}
