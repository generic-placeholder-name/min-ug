import { readFile } from "node:fs/promises";

import { writeFileAtomic } from "../lib/files.js";
import { errorCode } from "../lib/errors.js";

export const firefoxQueryStrippingSource =
  "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/query-stripping/records";

const maximumResponseBytes = 1024 * 1024;

interface FirefoxRemoteRecord {
  readonly id: string;
  readonly last_modified: number;
  readonly stripList: readonly string[];
  readonly allowList: readonly string[];
}

export interface CompiledFirefoxQueryStripping {
  readonly sourceUrl: string;
  readonly recordsLastModified: number;
  readonly records: readonly {
    readonly id: string;
    readonly lastModified: number;
  }[];
  readonly stripParameters: readonly string[];
  readonly allowBaseDomains: readonly string[];
}

interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  text(): Promise<string>;
}

export type FirefoxRulesFetch = (
  input: string,
  init: RequestInit
) => Promise<FetchResponseLike>;

export interface UpdateFirefoxQueryStrippingOptions {
  readonly sourceUrl?: string;
  readonly outputPath: string;
  readonly check?: boolean;
  readonly fetchImplementation?: FirefoxRulesFetch;
}

export interface UpdateFirefoxQueryStrippingResult {
  readonly changed: boolean;
  readonly compiled: CompiledFirefoxQueryStripping;
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord (
  record: unknown,
  index: number
): asserts record is FirefoxRemoteRecord {
  if (!isRecord(record)) {
    throw new Error(`data[${index}] must be an object`);
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new Error(`data[${index}].id must be a non-empty string`);
  }
  if (
    typeof record.last_modified !== "number" ||
    !Number.isSafeInteger(record.last_modified) ||
    record.last_modified < 0
  ) {
    throw new Error(`data[${index}].last_modified must be a non-negative safe integer`);
  }
  for (const field of ["stripList", "allowList"]) {
    if (!Array.isArray(record[field]) || !record[field].every(value => typeof value === "string")) {
      throw new Error(`data[${index}].${field} must be an array of strings`);
    }
  }
}

function appendUnique (
  target: string[],
  seen: Set<string>,
  values: readonly string[],
  normalize: (value: string) => string,
  label: string
): void {
  for (const value of values) {
    if (value.length === 0 || /[\u0000-\u001F\u007F]/u.test(value)) {
      throw new Error(`${label} contains an empty or control-character value`);
    }
    const normalized = normalize(value);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      target.push(normalized);
    }
  }
}

function normalizeDomain (value: string): string {
  const lower = value.toLowerCase();
  let parsed;
  try {
    parsed = new URL(`https://${lower}/`);
  } catch {
    throw new Error(`allowList contains invalid domain ${JSON.stringify(value)}`);
  }
  if (parsed.hostname !== lower || parsed.host !== lower || lower.includes("@")) {
    throw new Error(`allowList contains invalid domain ${JSON.stringify(value)}`);
  }
  return lower;
}

export function compileFirefoxQueryStripping (
  state: unknown,
  sourceUrl = firefoxQueryStrippingSource
): CompiledFirefoxQueryStripping {
  if (!isRecord(state) || !Array.isArray(state.data)) {
    throw new Error("Firefox Remote Settings response must contain a data array");
  }
  if (state.data.length === 0) {
    throw new Error("Firefox Remote Settings response contains no records");
  }

  const activeRecords: FirefoxRemoteRecord[] = [];
  for (const [index, record] of (state.data as unknown[]).entries()) {
    if (isRecord(record) && record.deleted === true) continue;
    assertRecord(record, index);
    activeRecords.push(record);
  }
  activeRecords.sort((left, right) =>
    right.last_modified - left.last_modified || left.id.localeCompare(right.id)
  );

  const stripParameters: string[] = [];
  const allowBaseDomains: string[] = [];
  const seenParameters = new Set<string>();
  const seenDomains = new Set<string>();
  for (const record of activeRecords) {
    appendUnique(
      stripParameters,
      seenParameters,
      record.stripList,
      value => value.toLowerCase(),
      `${record.id}.stripList`
    );
    appendUnique(
      allowBaseDomains,
      seenDomains,
      record.allowList,
      normalizeDomain,
      `${record.id}.allowList`
    );
  }

  if (stripParameters.length === 0) {
    throw new Error("Firefox Remote Settings state contains no stripping parameters");
  }

  return {
    sourceUrl,
    recordsLastModified: Math.max(...activeRecords.map(record => record.last_modified)),
    records: activeRecords.map(record => ({
      id: record.id,
      lastModified: record.last_modified
    })),
    stripParameters,
    allowBaseDomains
  };
}

function frozenStringArray (values: readonly string[], indentation: number): string {
  const prefix = " ".repeat(indentation);
  return [
    "Object.freeze([",
    ...values.map(value => `${prefix}${JSON.stringify(value)},`),
    `${" ".repeat(indentation - 2)}])`
  ].join("\n");
}

export function renderFirefoxQueryStrippingModule (
  compiled: CompiledFirefoxQueryStripping
): string {
  const records = compiled.records.map(record =>
    `      Object.freeze({ id: ${JSON.stringify(record.id)}, lastModified: ${record.lastModified} }),`
  ).join("\n");
  const stripParameters = frozenStringArray(compiled.stripParameters, 4);
  const allowBaseDomains = frozenStringArray(compiled.allowBaseDomains, 4);

  return `/* Generated by tools/update-firefox-query-stripping.ts; do not edit by hand. */
/**
 * Pinning Mozilla's policy keeps the same input deterministic across releases, avoids a runtime
 * policy request, and makes any expansion of default Clean behavior visible in review.
 */
export const firefoxQueryStrippingSnapshot = Object.freeze({
  source: Object.freeze({
    url: ${JSON.stringify(compiled.sourceUrl)},
    records: Object.freeze([
${records}
    ])
  }),
  recordsLastModified: ${compiled.recordsLastModified},
  stripParameters: ${stripParameters},
  allowBaseDomains: ${allowBaseDomains}
});
`;
}

export async function fetchFirefoxQueryStrippingState (
  sourceUrl: string = firefoxQueryStrippingSource,
  fetchImplementation: FirefoxRulesFetch = fetch
): Promise<unknown> {
  const response = await fetchImplementation(sourceUrl, {
    headers: { accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(`Firefox Remote Settings request failed with HTTP ${response.status}`);
  }
  if (new URL(response.url).origin !== new URL(sourceUrl).origin) {
    throw new Error(`Firefox Remote Settings redirected to a different origin: ${response.url}`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumResponseBytes) {
    throw new Error(`Firefox Remote Settings response exceeds ${maximumResponseBytes} bytes`);
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error("Firefox Remote Settings returned invalid JSON", { cause });
  }
}

export async function updateFirefoxQueryStripping ({
  sourceUrl = firefoxQueryStrippingSource,
  outputPath,
  check = false,
  fetchImplementation = fetch
}: UpdateFirefoxQueryStrippingOptions): Promise<UpdateFirefoxQueryStrippingResult> {
  const state = await fetchFirefoxQueryStrippingState(sourceUrl, fetchImplementation);
  const compiled = compileFirefoxQueryStripping(state, sourceUrl);
  const generated = renderFirefoxQueryStrippingModule(compiled);

  if (check) {
    let existing;
    try {
      existing = await readFile(outputPath, "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (existing !== generated) {
      throw new Error("Firefox query-stripping artifact is out of date; run npm run rules:firefox");
    }
    return { changed: false, compiled };
  }

  let existing;
  try {
    existing = await readFile(outputPath, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (existing === generated) return { changed: false, compiled };
  await writeFileAtomic(outputPath, generated);
  return { changed: true, compiled };
}
