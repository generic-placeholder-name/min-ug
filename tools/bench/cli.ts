#!/usr/bin/env node

import { booleanArg, parseArgs, numberArg, stringArg } from "../lib/args.js";
import { runBenchmark } from "./run.js";

function usage () {
  console.log(`Usage:
  npm run bench -- [options]

Options:
  --corpus <records.jsonl>   Defaults to data/processed/stage0/records.jsonl
  --split <selection>        all, seen-host:test, unseen-host:test, etc. (default: all)
  --alphabet ascii|qr        Defaults to ascii
  --limit <count>            Optional development limit
  --warmup <count>           Defaults to 100
  --samples <count>          Failure samples embedded in report (default: 10)
  --output <report.json>     Defaults to reports/ha-mr-latest.json
  --failures <failures.jsonl> Defaults to reports/ha-mr-latest.failures.jsonl`);
}

function percent (value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function fixed (value: number | null | undefined): string {
  return value === null || value === undefined ? "n/a" : value.toFixed(2);
}

async function main () {
  const args = parseArgs(process.argv.slice(2));
  if (booleanArg(args, "help")) {
    usage();
    return;
  }

  const outputPath = stringArg(args, "output", "reports/ha-mr-latest.json")!;
  const failuresPath = stringArg(
    args,
    "failures",
    "reports/ha-mr-latest.failures.jsonl"
  )!;
  const { report } = await runBenchmark({
    corpusPath: stringArg(args, "corpus", "data/processed/stage0/records.jsonl")!,
    split: stringArg(args, "split", "all")!,
    alphabet: stringArg(args, "alphabet", "ascii")!,
    limit: args.limit === undefined ? undefined : numberArg(args, "limit", undefined, { minimum: 1 }),
    warmup: numberArg(args, "warmup", 100, { minimum: 0 }),
    sampleCount: numberArg(args, "samples", 10, { minimum: 0 }),
    outputPath,
    failuresPath
  });

  console.log(`ha.mr ${report.baseline.revision}`);
  console.log(`records: ${report.summary.total}`);
  console.log(`exact: ${report.summary.exact} (${percent(report.summary.exactRate)})`);
  console.log(`mean payload symbols: ${fixed(report.summary.payloadSymbols?.mean)}`);
  console.log(`mean rendered characters: ${fixed(report.summary.renderedCharacters?.mean)}`);
  console.log(`mean encode/decode ms: ${fixed(report.summary.encodeMilliseconds?.mean)} / ${fixed(report.summary.decodeMilliseconds?.mean)}`);
  console.log(`report: ${outputPath}`);
  console.log(`failures: ${failuresPath}`);
}

main().catch(error => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
