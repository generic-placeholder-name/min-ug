import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runBenchmark } from "../tools/bench/run.js";
import type { BenchmarkCodec } from "../tools/bench/run.js";
import { errorCode } from "../tools/lib/errors.js";

function createSyntheticCodec (): BenchmarkCodec {
  return {
    id: "synthetic-test-codec",
    alphabetName: "test",
    alphabetSize: 64,
    encode (url) {
      if (url.includes("reject.example")) {
        const error = Object.assign(new Error("synthetic rejection"), {
          code: "synthetic-rejection"
        });
        throw error;
      }
      return url;
    },
    decode (payload) {
      return payload.includes("mismatch.example")
        ? "https://different.example/path"
        : payload;
    },
    render (payload) {
      return `test:${payload}`;
    },
    countSymbols (payload) {
      return payload.length;
    },
    isInputError (error: unknown) {
      return errorCode(error) === "synthetic-rejection";
    }
  };
}

test("benchmark records exact, mismatch, and rejection outcomes for any codec", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "min-ug-bench-test-"));
  const corpusPath = join(temporary, "records.jsonl");
  const outputPath = join(temporary, "report.json");
  const failuresPath = join(temporary, "failures.jsonl");
  const records = [
    {
      id: "exact",
      url: "https://exact.example/path",
      hostname: "exact.example",
      sources: ["test"],
      classes: ["query-heavy"],
      splits: { seenHost: "train", unseenHost: "train", temporalSeenHost: "excluded" }
    },
    {
      id: "mismatch",
      url: "https://mismatch.example/path",
      hostname: "mismatch.example",
      sources: ["test"],
      classes: ["synthetic-mismatch"],
      splits: { seenHost: "test", unseenHost: "train", temporalSeenHost: "excluded" }
    },
    {
      id: "rejected",
      url: "https://reject.example/path",
      hostname: "reject.example",
      sources: ["test"],
      classes: ["synthetic-rejection"],
      splits: { seenHost: "train", unseenHost: "train", temporalSeenHost: "excluded" }
    }
  ];
  await writeFile(corpusPath, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);

  const { report, failures } = await runBenchmark({
    codec: createSyntheticCodec(),
    baselineMetadata: {
      schemaVersion: 1,
      name: "Synthetic test codec",
      revision: "synthetic-v1"
    },
    corpusPath,
    split: "all",
    alphabet: "ascii",
    warmup: 0,
    sampleCount: 5,
    outputPath,
    failuresPath
  });

  assert.equal(report.baseline.revision, "synthetic-v1");
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.statuses.exact, 1);
  assert.equal(report.summary.statuses.mismatch, 1);
  assert.equal(report.summary.statuses.rejected, 1);
  assert.equal(report.summary.reasons.other, 1);
  assert.equal(report.summary.reasons["synthetic-rejection"], 1);
  assert.equal(report.summary.originalCharacters!.count, 3);
  assert.equal(failures.length, 2);
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).summary.total, 3);
  assert.equal((await readFile(failuresPath, "utf8")).trim().split("\n").length, 2);
});
