import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { CorpusPaths } from "../core/types.js";
import type { CommonCrawlSourceManifest } from "./types.js";

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings (value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

function numbers (value: unknown, name: string): number[] {
  if (!Array.isArray(value) || !value.every(item => Number.isInteger(item))) {
    throw new Error(`${name} must be an array of integers`);
  }
  return value as number[];
}

export async function readCommonCrawlManifest (
  path: string
): Promise<CommonCrawlSourceManifest> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported Common Crawl source manifest schema");
  }
  if (
    typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(value.id) ||
    typeof value.crawl !== "string" || !/^CC-MAIN-[0-9]{4}-[0-9]{2}$/u.test(value.crawl) ||
    typeof value.description !== "string" ||
    !isRecord(value.index) ||
    typeof value.index.database !== "string" ||
    typeof value.index.table !== "string" ||
    typeof value.index.location !== "string" ||
    !isRecord(value.sampling)
  ) throw new Error("Invalid Common Crawl source manifest metadata");
  const sampling = value.sampling;
  if (
    sampling.profile !== "balanced-v1" ||
    typeof sampling.seed !== "string" || sampling.seed.length === 0 ||
    typeof sampling.candidateMultiplier !== "number" || sampling.candidateMultiplier <= 1 ||
    typeof sampling.hostBalancedFraction !== "number" ||
    sampling.hostBalancedFraction < 0 || sampling.hostBalancedFraction > 1 ||
    typeof sampling.maximumUrlsPerHost !== "number" ||
    !Number.isInteger(sampling.maximumUrlsPerHost) || sampling.maximumUrlsPerHost < 1 ||
    typeof sampling.hashBuckets !== "number" ||
    !Number.isInteger(sampling.hashBuckets) || sampling.hashBuckets < 1000
  ) throw new Error("Invalid Common Crawl sampling profile");
  const protocols = strings(sampling.protocols, "sampling.protocols");
  if (!protocols.every(protocol => protocol === "http" || protocol === "https")) {
    throw new Error("Common Crawl protocols must be HTTP or HTTPS");
  }
  const statuses = numbers(sampling.statuses, "sampling.statuses");
  const mimeTypes = strings(sampling.mimeTypes, "sampling.mimeTypes");
  return {
    schemaVersion: 1,
    id: value.id,
    crawl: value.crawl,
    description: value.description,
    index: {
      database: value.index.database,
      table: value.index.table,
      location: value.index.location
    },
    sampling: {
      profile: "balanced-v1",
      seed: sampling.seed,
      candidateMultiplier: sampling.candidateMultiplier,
      hostBalancedFraction: sampling.hostBalancedFraction,
      maximumUrlsPerHost: sampling.maximumUrlsPerHost,
      hashBuckets: sampling.hashBuckets,
      protocols: protocols as ("http" | "https")[],
      statuses,
      mimeTypes
    }
  };
}

export function createCorpusPaths (
  corpusId: string,
  dataRoot: string,
  workRoot: string
): CorpusPaths {
  const workDirectory = resolve(workRoot, corpusId);
  const corpusDirectory = resolve(dataRoot, "corpus", corpusId);
  const packDirectory = resolve(dataRoot, "training", corpusId, "pack");
  return {
    workDirectory,
    candidateDirectory: resolve(workDirectory, "candidates"),
    acquisitionManifestPath: resolve(workDirectory, "acquisition.manifest.json"),
    stagingDirectory: resolve(workDirectory, "staging"),
    stagingManifestPath: resolve(workDirectory, "staging.manifest.json"),
    corpusDirectory,
    corpusManifestPath: resolve(corpusDirectory, "manifest.json"),
    packDirectory,
    packManifestPath: resolve(packDirectory, "manifest.json")
  };
}

export function candidateFormat (
  path: string
): "parquet" | "jsonl" | "jsonl-gzip" | "text" | "text-gzip" {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".parquet")) return "parquet";
  if (name.endsWith(".jsonl.gz") || name.endsWith(".ndjson.gz")) return "jsonl-gzip";
  if (name.endsWith(".jsonl") || name.endsWith(".ndjson")) return "jsonl";
  if (name.endsWith(".txt.gz")) return "text-gzip";
  if (name.endsWith(".txt")) return "text";
  throw new Error(`Unsupported candidate file format: ${path}`);
}
