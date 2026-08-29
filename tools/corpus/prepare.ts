import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import { canonicalize } from "../../src/canonicalize/index.js";
import { loadAdversarialCases } from "./adversarial.js";
import { classifyUrl } from "./classify.js";
import {
  sha256File,
  sha256Text,
  toJsonLines,
  writeFileAtomic,
  writeJsonAtomic
} from "../lib/files.js";
import { errorMessage } from "../lib/errors.js";

export type CorpusNormalization = "aggressive" | "clean" | "exact" | "browser" | "raw";
export type CorpusSplitName = "seenHost" | "unseenHost" | "temporalSeenHost";
export type CorpusSplitAssignment = "train" | "test" | "excluded";

interface InputSource {
  readonly id: string;
  readonly path: string;
}

interface SourceRecord {
  readonly rawUrl: string;
  readonly source: string;
  readonly sourceIndex: number;
  readonly timestamp?: number;
  readonly tags: readonly string[];
}

interface CorpusRecord {
  readonly id: string;
  readonly url: string;
  rawUrl?: string;
  readonly hostname: string;
  sources: string[];
  readonly sourceIndex: number;
  timestamp?: number;
  tags?: string[];
  adversarial?: boolean;
  classes?: string[];
  readonly splits: Partial<Record<CorpusSplitName, CorpusSplitAssignment>>;
}

interface RejectedRecord {
  readonly source: string;
  readonly sourceIndex: number;
  readonly line?: string;
  readonly url?: string;
  readonly reason: string;
}

interface SourceMetadata {
  readonly id: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly recordsRead: number;
}

interface LoadedSource {
  readonly records: SourceRecord[];
  readonly rejected: RejectedRecord[];
  readonly metadata: SourceMetadata;
}

export interface PrepareCorpusOptions {
  readonly inputs: readonly string[];
  readonly outputDirectory: string;
  readonly normalization?: string | undefined;
  readonly seed: string;
  readonly testFraction: number;
  readonly includeAdversarial: boolean;
  readonly limit?: number | undefined;
}

export interface CorpusManifest {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly normalization: CorpusNormalization;
  readonly seed: string;
  readonly testFraction: number;
  readonly inputs: readonly SourceMetadata[];
  readonly includesBuiltInAdversarial: boolean;
  readonly counts: {
    readonly input: number;
    readonly acceptedBeforeDedupe: number;
    readonly unique: number;
    readonly duplicates: number;
    readonly rejected: number;
    readonly hosts: number;
    readonly popularHosts: number;
  };
  readonly splits: Record<CorpusSplitName, Record<string, number>>;
  readonly splitHosts: Record<CorpusSplitName, Record<string, number>>;
}

const splitNames = ["seenHost", "unseenHost", "temporalSeenHost"] as const;
const normalizations = new Set<CorpusNormalization>([
  "aggressive", "clean", "exact", "browser", "raw"
]);

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isCorpusNormalization (value: string): value is CorpusNormalization {
  return normalizations.has(value as CorpusNormalization);
}

function score (seed: string, value: string): number {
  const prefix = sha256Text(`${seed}\0${value}`).slice(0, 13);
  return Number.parseInt(prefix, 16) / 0xfffffffffffff;
}

function groupBy<T, K> (records: readonly T[], key: (record: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const record of records) {
    const value = key(record);
    const group = groups.get(value) ?? [];
    group.push(record);
    groups.set(value, group);
  }
  return groups;
}

function assignSeenHost (records: readonly CorpusRecord[], seed: string, testFraction: number): void {
  for (const group of groupBy(records, record => record.hostname).values()) {
    if (group.length < 2) {
      group[0]!.splits.seenHost = "train";
      continue;
    }
    const testCount = Math.min(group.length - 1, Math.max(1, Math.floor(group.length * testFraction)));
    const ordered = [...group].sort((left, right) =>
      score(`${seed}:seen-host`, left.id) - score(`${seed}:seen-host`, right.id)
    );
    const testIds = new Set(ordered.slice(0, testCount).map(record => record.id));
    for (const record of group) record.splits.seenHost = testIds.has(record.id) ? "test" : "train";
  }
}

function assignUnseenHost (
  records: readonly CorpusRecord[],
  seed: string,
  testFraction: number
): void {
  for (const record of records) {
    record.splits.unseenHost = score(`${seed}:unseen-host`, record.hostname) < testFraction
      ? "test"
      : "train";
  }
}

function assignTemporalSeenHost (records: readonly CorpusRecord[], testFraction: number): void {
  for (const group of groupBy(records, record => record.hostname).values()) {
    const timestamped = group.filter(
      (record): record is CorpusRecord & { timestamp: number } =>
        typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
    );
    for (const record of group) record.splits.temporalSeenHost = "excluded";
    if (timestamped.length < 2) continue;

    timestamped.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
    const testCount = Math.min(
      timestamped.length - 1,
      Math.max(1, Math.floor(timestamped.length * testFraction))
    );
    const firstTest = timestamped.length - testCount;
    timestamped.forEach((record, index) => {
      record.splits.temporalSeenHost = index >= firstTest ? "test" : "train";
    });
  }
}

function parseInputSpec (spec: string): InputSource {
  const separator = spec.indexOf("=");
  if (separator === -1) {
    return { id: basename(spec, extname(spec)), path: resolve(spec) };
  }
  return { id: spec.slice(0, separator), path: resolve(spec.slice(separator + 1)) };
}

async function loadSourceRecords (source: InputSource, limit?: number): Promise<LoadedSource> {
  const contents = await readFile(source.path, "utf8");
  const jsonLines = extname(source.path).toLowerCase() === ".jsonl";
  const records: SourceRecord[] = [];
  const rejected: RejectedRecord[] = [];
  let seen = 0;

  for (const [lineIndex, line] of contents.split(/\r?\n/u).entries()) {
    if (line.length === 0) continue;
    if (limit !== undefined && seen >= limit) break;
    seen += 1;
    try {
      const parsed: unknown = jsonLines ? JSON.parse(line) : { url: line };
      if (!isRecord(parsed) || typeof parsed.url !== "string") {
        throw new Error("record has no string url field");
      }
      const timestamp = parsed.timestamp === undefined
        ? undefined
        : (typeof parsed.timestamp === "number"
            ? parsed.timestamp
            : Date.parse(String(parsed.timestamp)));
      const tags = Array.isArray(parsed.tags) && parsed.tags.every(tag => typeof tag === "string")
        ? parsed.tags
        : [];
      records.push({
        rawUrl: parsed.url,
        source: source.id,
        sourceIndex: lineIndex + 1,
        ...(timestamp === undefined ? {} : { timestamp }),
        tags
      });
    } catch (error) {
      rejected.push({
        source: source.id,
        sourceIndex: lineIndex + 1,
        line,
        reason: errorMessage(error)
      });
    }
  }

  const file = await stat(source.path);
  return {
    records,
    rejected,
    metadata: {
      id: source.id,
      path: source.path,
      bytes: file.size,
      sha256: await sha256File(source.path),
      recordsRead: seen
    }
  };
}

function normalizeRecord (input: SourceRecord, normalization: CorpusNormalization): CorpusRecord {
  const canonical = canonicalize(input.rawUrl, {
    preset: normalization === "clean" || normalization === "aggressive"
      ? normalization
      : "exact"
  });
  const parsed = new URL(canonical.url);
  const url = normalization === "raw" ? input.rawUrl : canonical.url;
  return {
    id: sha256Text(url),
    url,
    ...(input.rawUrl === url ? {} : { rawUrl: input.rawUrl }),
    hostname: parsed.hostname.toLowerCase(),
    sources: [input.source],
    sourceIndex: input.sourceIndex,
    ...(typeof input.timestamp === "number" && Number.isFinite(input.timestamp)
      ? { timestamp: input.timestamp }
      : {}),
    tags: [...input.tags],
    adversarial: input.source === "built-in-adversarial",
    splits: {}
  };
}

function splitCounts (
  records: readonly CorpusRecord[]
): Record<CorpusSplitName, Record<string, number>> {
  const counts: Record<CorpusSplitName, Record<string, number>> = {
    seenHost: {},
    unseenHost: {},
    temporalSeenHost: {}
  };
  for (const split of splitNames) {
    counts[split] = {};
    for (const record of records) {
      const assignment = record.splits[split]!;
      counts[split][assignment] = (counts[split][assignment] ?? 0) + 1;
    }
  }
  return counts;
}

function splitHostCounts (
  records: readonly CorpusRecord[]
): Record<CorpusSplitName, Record<string, number>> {
  const counts = {} as Record<CorpusSplitName, Record<string, number>>;
  for (const split of splitNames) {
    const hosts: Record<string, Set<string>> = {};
    for (const record of records) {
      const assignment = record.splits[split]!;
      const assigned = hosts[assignment] ?? new Set();
      assigned.add(record.hostname);
      hosts[assignment] = assigned;
    }
    counts[split] = Object.fromEntries(
      Object.entries(hosts).map(([assignment, assigned]) => [assignment, assigned.size])
    );
  }
  return counts;
}

export async function prepareCorpus (options: PrepareCorpusOptions): Promise<CorpusManifest> {
  const requestedNormalization = options.normalization ?? "clean";
  if (!isCorpusNormalization(requestedNormalization)) {
    throw new Error("normalization must be aggressive, clean, exact, browser, or raw");
  }
  const normalization = requestedNormalization;

  const inputSpecs = options.inputs.map(parseInputSpec);
  const loaded: LoadedSource[] = [];
  for (const source of inputSpecs) loaded.push(await loadSourceRecords(source, options.limit));

  const rawRecords = loaded.flatMap(source => source.records);
  const rejected = loaded.flatMap(source => source.rejected);
  if (options.includeAdversarial) {
    const adversarial = await loadAdversarialCases();
    rawRecords.push(...adversarial.map((record, index) => ({
      rawUrl: record.url,
      source: "built-in-adversarial",
      sourceIndex: index + 1,
      tags: [...record.tags]
    })));
  }

  const unique = new Map<string, CorpusRecord>();
  let acceptedBeforeDedupe = 0;
  for (const input of rawRecords) {
    try {
      const record = normalizeRecord(input, normalization);
      acceptedBeforeDedupe += 1;
      const existing = unique.get(record.url);
      if (existing) {
        existing.sources = [...new Set([...existing.sources, ...record.sources])].sort();
        existing.tags = [
          ...new Set([...(existing.tags ?? []), ...(record.tags ?? [])])
        ].sort();
        existing.adversarial = (existing.adversarial ?? false) ||
          (record.adversarial ?? false);
      } else {
        unique.set(record.url, record);
      }
    } catch (error) {
      rejected.push({
        source: input.source,
        sourceIndex: input.sourceIndex,
        url: input.rawUrl,
        reason: errorMessage(error)
      });
    }
  }

  const records = [...unique.values()];
  assignSeenHost(records, options.seed, options.testFraction);
  assignUnseenHost(records, options.seed, options.testFraction);
  assignTemporalSeenHost(records, options.testFraction);

  const hostCounts = new Map<string, number>();
  for (const record of records) hostCounts.set(record.hostname, (hostCounts.get(record.hostname) ?? 0) + 1);
  const popularHosts = new Set(
    [...hostCounts.entries()]
      .filter(([, count]) => count >= 10)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 100)
      .map(([hostname]) => hostname)
  );

  for (const record of records) {
    record.classes = classifyUrl(record.url, {
      tags: record.tags ?? [],
      hostCount: hostCounts.get(record.hostname),
      popularHost: popularHosts.has(record.hostname),
      adversarial: record.adversarial ?? false
    });
    delete record.tags;
    delete record.adversarial;
    if (record.rawUrl === undefined) delete record.rawUrl;
    if (record.timestamp === undefined) delete record.timestamp;
  }

  const outputDirectory = resolve(options.outputDirectory);
  const manifest: CorpusManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    normalization,
    seed: options.seed,
    testFraction: options.testFraction,
    inputs: loaded.map(source => source.metadata),
    includesBuiltInAdversarial: options.includeAdversarial,
    counts: {
      input: rawRecords.length,
      acceptedBeforeDedupe,
      unique: records.length,
      duplicates: acceptedBeforeDedupe - records.length,
      rejected: rejected.length,
      hosts: hostCounts.size,
      popularHosts: popularHosts.size
    },
    splits: splitCounts(records),
    splitHosts: splitHostCounts(records)
  };

  await writeFileAtomic(resolve(outputDirectory, "records.jsonl"), toJsonLines(records));
  await writeFileAtomic(resolve(outputDirectory, "rejected.jsonl"), toJsonLines(rejected));
  await writeJsonAtomic(resolve(outputDirectory, "manifest.json"), manifest);
  return manifest;
}
