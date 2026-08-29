import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadAdversarialCases } from "../tools/corpus/adversarial.js";
import { classifyUrl } from "../tools/corpus/classify.js";
import { prepareCorpus } from "../tools/corpus/prepare.js";

test("adversarial corpus covers every percent byte plus curated hazards", async () => {
  const records = await loadAdversarialCases();
  assert.equal(records.length, 273);
  assert(records.some(record => record.url.includes("%00")));
  assert(records.some(record => record.url.includes("%FF")));
  assert(records.some(record => record.tags.includes("userinfo")));
});

test("URL classifier identifies benchmark breakdown classes", () => {
  const classes = classifyUrl(
    "https://popular.example/redirect/123e4567-e89b-12d3-a456-426614174000?url=https%3A%2F%2Finner.example%2Fx&a=1&b=2&c=3",
    { hostCount: 50, popularHost: true }
  );
  assert(classes.includes("uuid-or-hash-bearing"));
  assert(classes.includes("wrapped"));
  assert(classes.includes("query-heavy"));
  assert(classes.includes("popular-host-opaque-id"));
});

test("corpus preparation deduplicates and creates deterministic leakage-safe splits", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "min-ug-corpus-test-"));
  const input = join(temporary, "input.jsonl");
  const rows = [];
  for (let index = 0; index < 10; index += 1) {
    rows.push({ url: `https://seen.example/items/${index}`, timestamp: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z` });
  }
  rows.push({ url: "https://singleton.example/only" });
  rows.push({ url: "https://seen.example/items/0" });
  await writeFile(input, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);

  const firstOutput = join(temporary, "first");
  const secondOutput = join(temporary, "second");
  const options = {
    inputs: [`test=${input}`],
    normalization: "browser",
    seed: "deterministic-seed",
    testFraction: 0.2,
    includeAdversarial: false
  };
  const first = await prepareCorpus({ ...options, outputDirectory: firstOutput });
  const second = await prepareCorpus({ ...options, outputDirectory: secondOutput });
  assert.equal(first.counts.unique, 11);
  assert.equal(first.counts.duplicates, 1);
  assert.deepEqual(first.splits, second.splits);

  const firstRecords = (await readFile(join(firstOutput, "records.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  const secondRecords = (await readFile(join(secondOutput, "records.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(firstRecords, secondRecords);

  const seenTest = firstRecords.filter(record => record.splits.seenHost === "test");
  assert.equal(seenTest.length, 2);
  assert(seenTest.every(record => record.hostname === "seen.example"));
  assert(firstRecords.some(record => record.splits.temporalSeenHost === "test"));

  const unseenAssignments = new Map();
  for (const record of firstRecords) {
    const previous = unseenAssignments.get(record.hostname);
    if (previous) assert.equal(previous, record.splits.unseenHost);
    unseenAssignments.set(record.hostname, record.splits.unseenHost);
  }
});

test("corpus preparation defaults to Clean while retaining Exact and Aggressive variants", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "min-ug-clean-corpus-test-"));
  const input = join(temporary, "input.txt");
  await writeFile(input, [
    "https://example.com/article?fbclid=tracking",
    "https://example.com/article",
    "https://example.com/article?utm_source=kept"
  ].join("\n"));

  const cleanOutput = join(temporary, "clean");
  const exactOutput = join(temporary, "exact");
  const aggressiveOutput = join(temporary, "aggressive");
  const shared = {
    inputs: [`test=${input}`],
    seed: "normalization-test",
    testFraction: 0.2,
    includeAdversarial: false
  };

  const clean = await prepareCorpus({ ...shared, outputDirectory: cleanOutput });
  const exact = await prepareCorpus({
    ...shared,
    outputDirectory: exactOutput,
    normalization: "exact"
  });
  const aggressive = await prepareCorpus({
    ...shared,
    outputDirectory: aggressiveOutput,
    normalization: "aggressive"
  });

  assert.equal(clean.normalization, "clean");
  assert.equal(clean.counts.unique, 2);
  assert.equal(clean.counts.duplicates, 1);
  assert.equal(exact.normalization, "exact");
  assert.equal(exact.counts.unique, 3);
  assert.equal(aggressive.normalization, "aggressive");
  assert.equal(aggressive.counts.unique, 1);

  const cleanUrls = (await readFile(join(cleanOutput, "records.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line)).map(record => record.url).sort();
  assert.deepEqual(cleanUrls, [
    "https://example.com/article",
    "https://example.com/article?utm_source=kept"
  ]);
});
