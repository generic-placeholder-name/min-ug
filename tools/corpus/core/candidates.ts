import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

import { DuckDBInstance } from "@duckdb/node-api";

import type { CandidateFile } from "./types.js";

function sqlString (value: string): string {
  return `'${value.replaceAll("'", "''").replaceAll("\\", "/")}'`;
}

function parseJsonUrl (line: string): string {
  const value: unknown = JSON.parse(line);
  if (typeof value === "string") return value;
  if (
    typeof value === "object" && value !== null &&
    "url" in value && typeof value.url === "string"
  ) return value.url;
  throw new Error("Candidate JSON line must be a URL string or an object with a string url field");
}

async function * lineCandidates (file: CandidateFile): AsyncGenerator<string> {
  const compressed = file.format === "jsonl-gzip" || file.format === "text-gzip";
  const input = compressed
    ? createReadStream(file.path).pipe(createGunzip())
    : createReadStream(file.path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    yield file.format === "jsonl" || file.format === "jsonl-gzip"
      ? parseJsonUrl(line)
      : line.trim();
  }
}

async function * parquetCandidates (
  file: CandidateFile,
  threads: number
): AsyncGenerator<string> {
  const instance = await DuckDBInstance.create(":memory:", { threads: String(threads) });
  const connection = await instance.connect();
  try {
    const result = await connection.stream(
      `SELECT url FROM read_parquet(${sqlString(file.path)})`
    );
    for await (const rows of result.yieldRows()) {
      for (const row of rows) {
        if (typeof row[0] !== "string") throw new Error(`Candidate file ${file.path} has a non-string URL`);
        yield row[0];
      }
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

export async function * readCandidateUrls (
  files: readonly CandidateFile[],
  threads = 1
): AsyncGenerator<string> {
  for (const file of files) {
    const candidates = file.format === "parquet"
      ? parquetCandidates(file, threads)
      : lineCandidates(file);
    for await (const url of candidates) yield url;
  }
}
