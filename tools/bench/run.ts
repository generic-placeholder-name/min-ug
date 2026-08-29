import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createHamrBaseline,
  verifyHamrVendor
} from "../baselines/hamr.js";
import { classifyDifference } from "./classify-failure.js";
import { describe } from "./stats.js";
import { toJsonLines, writeFileAtomic, writeJsonAtomic } from "../lib/files.js";
import { errorCode, errorMessage, errorName } from "../lib/errors.js";

type CorpusSplitName = "seenHost" | "unseenHost" | "temporalSeenHost";

export interface BenchmarkCodec {
  readonly id: string;
  readonly alphabetName: string;
  readonly alphabetSize: number;
  encode(input: string): string;
  decode(payload: string): string;
  render(payload: string): string;
  countSymbols(payload: string): number;
  isInputError?(error: unknown): boolean;
}

export interface BenchmarkCorpusRecord {
  readonly id: string;
  readonly url: string;
  readonly classes?: readonly string[];
  readonly splits?: Readonly<Record<string, string>>;
  readonly sources?: readonly string[];
}

export interface BenchmarkMetadata {
  readonly schemaVersion: number;
  readonly name: string;
  readonly revision: string;
  readonly [key: string]: unknown;
}

export interface RunBenchmarkOptions {
  readonly codec?: BenchmarkCodec;
  readonly baselineMetadata?: BenchmarkMetadata;
  readonly corpusPath: string;
  readonly split: string;
  readonly alphabet?: string | undefined;
  readonly limit?: number | undefined;
  readonly warmup?: number | undefined;
  readonly sampleCount?: number | undefined;
  readonly outputPath?: string | undefined;
  readonly failuresPath?: string | undefined;
}

export interface BenchmarkResult {
  readonly id: string;
  readonly expected: string;
  readonly originalCharacters: number;
  readonly classes: readonly string[];
  readonly splits: Readonly<Record<string, string>>;
  readonly sources: readonly string[];
  encodeMilliseconds?: number;
  decodeMilliseconds?: number;
  payloadSymbols?: number;
  payloadBits?: number;
  renderedCharacters?: number;
  actual?: string;
  status?: string;
  reason?: string;
  error?: string;
}

const splitNames: Readonly<Record<string, CorpusSplitName>> = Object.freeze({
  "seen-host": "seenHost",
  "unseen-host": "unseenHost",
  "temporal-seen-host": "temporalSeenHost"
});

async function readOptionalJson (path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

export async function loadCorpus (path: string): Promise<{
  readonly absolute: string;
  readonly records: BenchmarkCorpusRecord[];
  readonly manifest: unknown | null;
}> {
  const absolute = resolve(path);
  const contents = await readFile(absolute, "utf8");
  const records = contents
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index): BenchmarkCorpusRecord => {
      try {
        return JSON.parse(line) as BenchmarkCorpusRecord;
      } catch (error) {
        throw new Error(`${absolute}:${index + 1}: ${errorMessage(error)}`);
      }
    });
  const manifest = await readOptionalJson(resolve(dirname(absolute), "manifest.json"));
  return { absolute, records, manifest };
}

export function selectRecords (
  records: readonly BenchmarkCorpusRecord[],
  selection = "all"
): BenchmarkCorpusRecord[] | readonly BenchmarkCorpusRecord[] {
  if (selection === "all") return records;
  const separator = selection.lastIndexOf(":");
  if (separator === -1) {
    throw new Error("--split must be all or <seen-host|unseen-host|temporal-seen-host>:<train|test>");
  }
  const splitName = splitNames[selection.slice(0, separator)];
  const assignment = selection.slice(separator + 1);
  if (!splitName || (assignment !== "train" && assignment !== "test")) {
    throw new Error(`Invalid split selection ${JSON.stringify(selection)}`);
  }
  return records.filter(record => record.splits?.[splitName] === assignment);
}

function increment (object: Record<string, number>, key: string): void {
  object[key] = (object[key] ?? 0) + 1;
}

function hasPayloadMetrics (result: BenchmarkResult): result is BenchmarkResult & {
  payloadSymbols: number;
  payloadBits: number;
  renderedCharacters: number;
} {
  return result.payloadSymbols !== undefined &&
    result.payloadBits !== undefined &&
    result.renderedCharacters !== undefined;
}

function presentNumbers (values: readonly (number | undefined)[]): number[] {
  return values.filter((value): value is number => value !== undefined && Number.isFinite(value));
}

function summarizeGroup (results: readonly BenchmarkResult[]) {
  const statuses: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  for (const result of results) {
    increment(statuses, result.status ?? "unknown");
    if (result.status !== "exact" && result.reason) increment(reasons, result.reason);
  }
  const encodable = results.filter(hasPayloadMetrics);
  return {
    total: results.length,
    exact: statuses.exact ?? 0,
    exactRate: results.length === 0 ? null : (statuses.exact ?? 0) / results.length,
    statuses,
    reasons,
    payloadSymbols: describe(encodable.map(result => result.payloadSymbols)),
    renderedCharacters: describe(encodable.map(result => result.renderedCharacters))
  };
}

function summarizeByClass (results: readonly BenchmarkResult[]) {
  const groups = new Map<string, BenchmarkResult[]>();
  for (const result of results) {
    for (const name of result.classes) {
      const group = groups.get(name) ?? [];
      group.push(result);
      groups.set(name, group);
    }
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, group]) => [name, summarizeGroup(group)])
  );
}

function summarizeBySplit (results: readonly BenchmarkResult[]) {
  const groups = new Map<string, BenchmarkResult[]>();
  for (const result of results) {
    for (const [name, assignment] of Object.entries(result.splits)) {
      if (assignment === "excluded") continue;
      const key = `${name}:${assignment}`;
      const group = groups.get(key) ?? [];
      group.push(result);
      groups.set(key, group);
    }
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, group]) => [name, summarizeGroup(group)])
  );
}

function failureRecord (result: BenchmarkResult) {
  return {
    id: result.id,
    status: result.status,
    reason: result.reason,
    expected: result.expected,
    actual: result.actual,
    error: result.error,
    classes: result.classes,
    sources: result.sources
  };
}

export async function runBenchmark (options: RunBenchmarkOptions) {
  const codec = options.codec ?? createHamrBaseline({ alphabet: options.alphabet });
  const baselineMetadata = options.baselineMetadata ?? (
    options.codec
      ? { schemaVersion: 1, name: codec.id, revision: codec.id }
      : await verifyHamrVendor()
  );
  const corpus = await loadCorpus(options.corpusPath);
  let selected = selectRecords(corpus.records, options.split);
  if (options.limit !== undefined) selected = selected.slice(0, options.limit);

  const warmupCount = Math.min(options.warmup ?? 0, selected.length);
  for (let index = 0; index < warmupCount; index += 1) {
    try {
      const payload = codec.encode(selected[index]!.url);
      codec.decode(payload);
    } catch {
      // Warmup must exercise the same error paths without changing benchmark outcomes.
    }
  }

  const results: BenchmarkResult[] = [];
  for (const record of selected) {
    const result: BenchmarkResult = {
      id: record.id,
      expected: record.url,
      originalCharacters: Array.from(record.url).length,
      classes: record.classes ?? [],
      splits: record.splits ?? {},
      sources: record.sources ?? []
    };
    let payload;
    const encodeStart = performance.now();
    try {
      payload = codec.encode(record.url);
      result.encodeMilliseconds = performance.now() - encodeStart;
    } catch (error) {
      result.encodeMilliseconds = performance.now() - encodeStart;
      result.status = codec.isInputError?.(error) ? "rejected" : "encode-error";
      result.reason = errorCode(error) ?? errorName(error, "encode-error");
      result.error = errorMessage(error);
      results.push(result);
      continue;
    }

    result.payloadSymbols = codec.countSymbols(payload);
    result.payloadBits = result.payloadSymbols * Math.log2(codec.alphabetSize);
    result.renderedCharacters = Array.from(codec.render(payload)).length;
    const decodeStart = performance.now();
    try {
      result.actual = codec.decode(payload);
      result.decodeMilliseconds = performance.now() - decodeStart;
    } catch (error) {
      result.decodeMilliseconds = performance.now() - decodeStart;
      result.status = "decode-error";
      result.reason = errorName(error, "decode-error");
      result.error = errorMessage(error);
      results.push(result);
      continue;
    }

    result.reason = classifyDifference(record.url, result.actual);
    result.status = result.reason === "exact" ? "exact" : "mismatch";
    results.push(result);
  }

  const encodable = results.filter(hasPayloadMetrics);
  const failures = results.filter(result => result.status !== "exact");
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    baseline: baselineMetadata,
    benchmark: {
      alphabet: codec.alphabetName,
      alphabetSize: codec.alphabetSize,
      split: options.split,
      requestedLimit: options.limit ?? null,
      warmup: warmupCount,
      renderedPrefix: codec.render("")
    },
    corpus: {
      recordsPath: corpus.absolute,
      manifest: corpus.manifest
    },
    summary: {
      ...summarizeGroup(results),
      originalCharacters: describe(results.map(result => result.originalCharacters)),
      payloadBits: describe(encodable.map(result => result.payloadBits)),
      encodeMilliseconds: describe(presentNumbers(results.map(result => result.encodeMilliseconds))),
      decodeMilliseconds: describe(presentNumbers(results.map(result => result.decodeMilliseconds))),
      fallbackRate: null
    },
    byClass: summarizeByClass(results),
    bySplit: summarizeBySplit(results),
    failureSamples: failures.slice(0, options.sampleCount ?? 10).map(failureRecord)
  };

  if (options.outputPath) await writeJsonAtomic(options.outputPath, report);
  if (options.failuresPath) {
    await writeFileAtomic(options.failuresPath, toJsonLines(failures.map(failureRecord)));
  }
  return { report, failures };
}
