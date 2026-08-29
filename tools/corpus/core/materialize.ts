import duckdb, { DuckDBInstance } from "@duckdb/node-api";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256File, writeJsonAtomic } from "../../lib/files.js";
import {
  assignHostSplits,
  emptySplitCounts,
  incrementSplitCount,
  type SplitRecord
} from "./splits.js";
import { removeSafePath, type StorageGuard } from "./storage.js";
import type {
  CorpusManifest,
  CorpusShard,
  StagingManifest
} from "./types.js";

function sqlString (value: string): string {
  return `'${value.replaceAll("'", "''").replaceAll("\\", "/")}'`;
}

async function readJson<T> (path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function validShard (directory: string, shard: CorpusShard): Promise<boolean> {
  try {
    const path = resolve(directory, shard.path);
    return (await stat(path)).size === shard.bytes && await sha256File(path) === shard.sha256;
  } catch {
    return false;
  }
}

function hashOrder (seed: string, kind: string, value: string): string {
  return `sha256(${sqlString(`${seed.length}:${seed}${kind.length}:${kind}`)} || ${value})`;
}

export class InsufficientCandidatesError extends Error {
  constructor (
    readonly requested: number,
    readonly available: number
  ) {
    super(`Requested ${requested.toLocaleString()} canonical URLs, but only ${available.toLocaleString()} unique candidates survived`);
    this.name = "InsufficientCandidatesError";
  }
}

export interface MaterializeOptions {
  readonly stagingDirectory: string;
  readonly stagingManifestPath: string;
  readonly outputDirectory: string;
  readonly manifestPath: string;
  readonly workDirectory: string;
  readonly corpusId: string;
  readonly sourceManifestSha256: string;
  readonly crawl: string;
  readonly samplingProfile: string;
  readonly requestedUrls: number;
  readonly hostBalancedFraction: number;
  readonly maximumUrlsPerHost: number;
  readonly candidateMultiplier: number;
  readonly seed: string;
  readonly validationFraction: number;
  readonly testFraction: number;
  readonly threads: number;
  readonly memoryLimit: string;
  readonly maximumTemporaryDirectorySize: string;
  readonly force?: boolean;
  readonly storageGuard?: StorageGuard;
}

export async function materializeCorpus (
  options: MaterializeOptions
): Promise<CorpusManifest> {
  if (!Number.isSafeInteger(options.requestedUrls) || options.requestedUrls <= 0) {
    throw new Error("Requested URL count must be a positive safe integer");
  }
  const staging = await readJson<StagingManifest>(options.stagingManifestPath);
  const stagingManifestSha256 = await sha256File(options.stagingManifestPath);
  if (!options.force) {
    try {
      const existing = await readJson<CorpusManifest>(options.manifestPath);
      if (
        existing.schemaVersion === 2 &&
        existing.stagingManifestSha256 === stagingManifestSha256 &&
        existing.sampling.requestedUrls === options.requestedUrls &&
        existing.seed === options.seed &&
        existing.validationFraction === options.validationFraction &&
        existing.testFraction === options.testFraction &&
        (await Promise.all(existing.shards.map(async shard =>
          await validShard(options.outputDirectory, shard)
        ))).every(Boolean)
      ) return existing;
    } catch {
      // Rebuild an incomplete or incompatible corpus below.
    }
  }
  if (staging.shards.length === 0) throw new InsufficientCandidatesError(options.requestedUrls, 0);
  for (const shard of staging.shards) {
    const path = resolve(options.stagingDirectory, shard.path);
    if ((await stat(path)).size !== shard.bytes || await sha256File(path) !== shard.sha256) {
      throw new Error(`Staging shard ${shard.path} does not match its manifest`);
    }
  }

  await options.storageGuard?.assertWithinBudget("materializing Common Crawl sample");
  const parent = resolve(options.outputDirectory, "..");
  if (options.force) await removeSafePath(parent, options.outputDirectory);
  const temporaryOutputDirectory = `${options.outputDirectory}.tmp`;
  await removeSafePath(parent, temporaryOutputDirectory);
  await mkdir(temporaryOutputDirectory, { recursive: true });
  const databasePath = resolve(options.workDirectory, "materialize.duckdb");
  const tempDirectory = resolve(options.workDirectory, "materialize.tmp");
  await removeSafePath(options.workDirectory, databasePath);
  await removeSafePath(options.workDirectory, tempDirectory);
  await mkdir(tempDirectory, { recursive: true });

  const instance = await DuckDBInstance.create(databasePath, {
    threads: String(options.threads),
    memory_limit: options.memoryLimit,
    temp_directory: tempDirectory,
    max_temp_directory_size: options.maximumTemporaryDirectorySize
  });
  const connection = await instance.connect();
  // DuckDB appender state belongs to its connection. Keeping writes off the connection
  // that owns the active selection stream prevents large streams from being truncated
  // when the appender flushes its internal buffer.
  const appenderConnection = await instance.connect();
  try {
    const stagingPaths = staging.shards.map(shard =>
      sqlString(resolve(options.stagingDirectory, shard.path))
    ).join(", ");
    await connection.run(`
      CREATE TABLE candidates AS
      SELECT DISTINCT url::VARCHAR AS url, hostname::VARCHAR AS hostname
      FROM read_ndjson(
        [${stagingPaths}],
        columns = {url: 'VARCHAR', hostname: 'VARCHAR'}
      )
    `);
    const uniqueResult = await connection.runAndReadAll(
      "SELECT count(*)::UBIGINT, count(DISTINCT hostname)::UBIGINT FROM candidates"
    );
    const uniqueRow = uniqueResult.getRows()[0]!;
    const uniqueBeforeSelection = Number(uniqueRow[0]);
    if (uniqueBeforeSelection < options.requestedUrls) {
      throw new InsufficientCandidatesError(options.requestedUrls, uniqueBeforeSelection);
    }

    const hostTarget = Math.floor(options.requestedUrls * options.hostBalancedFraction);
    await connection.run(`
      CREATE TABLE selected (url VARCHAR NOT NULL, hostname VARCHAR NOT NULL)
    `);
    if (hostTarget > 0) {
      await connection.run(`
        INSERT INTO selected
        WITH ranked AS (
          SELECT
            url,
            hostname,
            row_number() OVER (
              PARTITION BY hostname
              ORDER BY ${hashOrder(options.seed, "sample-url", "url")}, url
            ) AS within_host_rank
          FROM candidates
        )
        SELECT url, hostname
        FROM ranked
        WHERE within_host_rank <= ${options.maximumUrlsPerHost}
        ORDER BY
          within_host_rank,
          ${hashOrder(options.seed, "sample-host", "hostname")},
          ${hashOrder(options.seed, "sample-url", "url")},
          url
        LIMIT ${hostTarget}
      `);
    }
    const selectedResult = await connection.runAndReadAll("SELECT count(*)::UBIGINT FROM selected");
    const selectedForCoverage = Number(selectedResult.getRows()[0]![0]);
    const remaining = options.requestedUrls - selectedForCoverage;
    if (remaining > 0) {
      await connection.run(`
        INSERT INTO selected
        SELECT candidates.url, candidates.hostname
        FROM candidates
        LEFT JOIN selected USING (url)
        WHERE selected.url IS NULL
        ORDER BY ${hashOrder(options.seed, "sample-prevalence", "candidates.url")}, candidates.url
        LIMIT ${remaining}
      `);
    }
    const finalCountResult = await connection.runAndReadAll(
      "SELECT count(*)::UBIGINT, count(DISTINCT hostname)::UBIGINT FROM selected"
    );
    const finalCountRow = finalCountResult.getRows()[0]!;
    const finalUrls = Number(finalCountRow[0]);
    const distinctHosts = Number(finalCountRow[1]);
    if (finalUrls !== options.requestedUrls) {
      throw new InsufficientCandidatesError(options.requestedUrls, finalUrls);
    }

    await connection.run(`
      CREATE TABLE final_rows (
        url VARCHAR NOT NULL,
        split UTINYINT NOT NULL
      )
    `);
    const appender = await appenderConnection.createAppender("final_rows");
    const splits = emptySplitCounts();
    const result = await connection.stream(
      "SELECT hostname, url FROM selected ORDER BY hostname, url"
    );
    let currentHostname: string | undefined;
    let group: SplitRecord[] = [];
    const flushGroup = (): void => {
      if (currentHostname === undefined) return;
      assignHostSplits(currentHostname, group, {
        seed: options.seed,
        validationFraction: options.validationFraction,
        testFraction: options.testFraction
      });
      for (const record of group) {
        const split = record.split!;
        appender.appendVarchar(record.url);
        appender.appendUTinyInt(split);
        appender.endRow();
        incrementSplitCount(splits, split);
      }
      group = [];
    };
    for await (const rows of result.yieldRows()) {
      for (const row of rows) {
        const hostname = String(row[0]);
        if (currentHostname !== undefined && hostname !== currentHostname) flushGroup();
        currentHostname = hostname;
        group.push({ url: String(row[1]) });
      }
    }
    flushGroup();
    appender.flushSync();
    appender.closeSync();

    const writtenResult = await connection.runAndReadAll(
      "SELECT count(*)::UBIGINT FROM final_rows"
    );
    const writtenRows = Number(writtenResult.getRows()[0]![0]);
    const countedSplits = Object.values(splits).reduce((sum, count) => sum + count, 0);
    if (writtenRows !== finalUrls || countedSplits !== finalUrls) {
      throw new Error(
        `Split assignment expected ${finalUrls.toLocaleString()} rows, wrote ${writtenRows.toLocaleString()}, and counted ${countedSplits.toLocaleString()}`
      );
    }

    const outputName = "part-0000.parquet";
    const temporaryParquet = resolve(temporaryOutputDirectory, `${outputName}.tmp`);
    const outputPath = resolve(temporaryOutputDirectory, outputName);
    await connection.run(`
      COPY (
        SELECT url, split
        FROM final_rows
        ORDER BY url
      ) TO ${sqlString(temporaryParquet)} (
        FORMAT PARQUET,
        COMPRESSION ZSTD,
        COMPRESSION_LEVEL 1,
        ROW_GROUP_SIZE 250000
      )
    `);
    await rename(temporaryParquet, outputPath);
    const outputMetadata = await stat(outputPath);
    const shard: CorpusShard = {
      index: 0,
      path: outputName,
      records: finalUrls,
      bytes: outputMetadata.size,
      sha256: await sha256File(outputPath)
    };
    const manifest: CorpusManifest = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      format: "canonical-url-split-v1",
      corpusId: options.corpusId,
      source: {
        kind: "common-crawl-url-index",
        manifestSha256: options.sourceManifestSha256,
        crawl: options.crawl,
        samplingProfile: options.samplingProfile
      },
      canonicalization: {
        preset: "clean",
        sourceSha256: staging.canonicalizerSha256
      },
      sampling: {
        requestedUrls: options.requestedUrls,
        hostBalancedFraction: options.hostBalancedFraction,
        maximumUrlsPerHost: options.maximumUrlsPerHost,
        candidateMultiplier: options.candidateMultiplier
      },
      seed: options.seed,
      validationFraction: options.validationFraction,
      testFraction: options.testFraction,
      duckdb: {
        version: duckdb.version(),
        threads: options.threads,
        memoryLimit: options.memoryLimit,
        maximumTemporaryDirectorySize: options.maximumTemporaryDirectorySize,
        parquetCompression: "zstd",
        parquetCompressionLevel: 1,
        parquetRowGroupSize: 250000
      },
      counts: {
        candidateRows: staging.counts.candidates,
        acceptedBeforeDedupe: staging.counts.accepted,
        uniqueBeforeSelection,
        duplicateRows: staging.counts.accepted - uniqueBeforeSelection,
        finalUrls,
        distinctHosts
      },
      splits,
      stagingManifestSha256,
      shards: [shard]
    };
    await writeJsonAtomic(resolve(temporaryOutputDirectory, "manifest.json"), manifest);
    appenderConnection.closeSync();
    connection.closeSync();
    instance.closeSync();
    await removeSafePath(parent, options.outputDirectory);
    await rename(temporaryOutputDirectory, options.outputDirectory);
    return manifest;
  } catch (error) {
    await removeSafePath(parent, temporaryOutputDirectory);
    throw error;
  } finally {
    try { appenderConnection.closeSync(); } catch {}
    try { connection.closeSync(); } catch {}
    try { instance.closeSync(); } catch {}
    await removeSafePath(options.workDirectory, databasePath);
    await removeSafePath(options.workDirectory, tempDirectory);
  }
}
