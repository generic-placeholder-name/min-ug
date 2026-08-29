#!/usr/bin/env node

import { resolve } from "node:path";

import {
  booleanArg,
  numberArg,
  parseArgs,
  stringArg,
  stringArgs
} from "../../lib/args.js";
import { sha256File } from "../../lib/files.js";
import { parseByteSize } from "../core/storage.js";
import { createCorpusPaths, readCommonCrawlManifest } from "./manifest.js";
import { CommonCrawlPipeline, defaultWorkerCount } from "./pipeline.js";

const commands = new Set(["sample", "materialize", "pack", "verify", "all"]);

function usage (): void {
  console.log(`Usage:
  npm run corpus:common-crawl -- sample --count <urls> [options]

Commands:
  sample       Acquire candidates, Clean, deduplicate, select exactly --count, and verify
  materialize  Rebuild Parquet from existing staging artifacts
  pack         Generate the temporary memory-mapped training pack
  verify       Verify Parquet and any present training pack
  all          sample, then optionally pack and benchmark

Required for remote sampling:
  --count <urls>                 Final unique canonical URL count
  --athena-output <s3://...>     User-owned Athena query/export location

Local integration mode:
  --candidate-file <path>        Repeatable Parquet, JSONL(.gz), or text(.gz) input

Options:
  --source-manifest <path>       Default: corpus/common-crawl/cc-main-2026-30.json
  --data-root <path>             Default: data
  --work-root <path>             Default: data/work
  --aws-region <region>          Default: us-east-1
  --athena-workgroup <name>      Optional Athena workgroup
  --validation-fraction <0..1>   Default: 0.1
  --test-fraction <0..1>         Default: 0.1
  --threads <count>              Default: logical CPUs minus two
  --canonicalizer-workers <n>    Default: logical CPUs minus two; zero runs inline
  --duckdb-memory <size>         Default: 12GB
  --max-temp <size>              Default: 30GB
  --storage-budget <size>        Default: 70GB
  --minimum-free <size>          Default: 20GB
  --target-shard-bytes <size>    Default: 256MiB
  --staging-shards <count>       Default: 64
  --storage-profile compact|retain Default: compact
  --benchmark-loader <bool>      Run the Python/PyTorch loader benchmark
  --keep-pack <bool>             Retain the generated training pack
  --force <bool>                 Rebuild local artifacts`);
}

async function main (): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (booleanArg(args, "help") || command === undefined) {
    usage();
    return;
  }
  if (!commands.has(command)) {
    usage();
    throw new Error(`Unknown Common Crawl corpus command ${JSON.stringify(command)}`);
  }
  const requestedUrls = numberArg(args, "count", undefined, { minimum: 1 });
  if (requestedUrls === undefined || !Number.isSafeInteger(requestedUrls)) {
    throw new Error("--count must be a positive integer naming the final canonical URL count");
  }
  const sourceManifestPath = resolve(stringArg(
    args,
    "source-manifest",
    "corpus/common-crawl/cc-main-2026-30.json"
  )!);
  const source = await readCommonCrawlManifest(sourceManifestPath);
  const dataRoot = resolve(stringArg(args, "data-root", "data")!);
  const workRoot = resolve(stringArg(args, "work-root", "data/work")!);
  const storageProfile = stringArg(args, "storage-profile", "compact")!;
  if (storageProfile !== "compact" && storageProfile !== "retain") {
    throw new Error("--storage-profile must be compact or retain");
  }
  const validationFraction = numberArg(args, "validation-fraction", 0.1, {
    minimum: 0.000001,
    maximum: 0.499999
  });
  const testFraction = numberArg(args, "test-fraction", 0.1, {
    minimum: 0.000001,
    maximum: 0.499999
  });
  if (validationFraction + testFraction >= 1) {
    throw new Error("Validation and test fractions must sum to less than one");
  }
  const workers = defaultWorkerCount();
  const athenaOutput = stringArg(args, "athena-output");
  const athenaWorkgroup = stringArg(args, "athena-workgroup");
  const pipeline = new CommonCrawlPipeline({
    sourceManifestPath,
    sourceManifestSha256: await sha256File(sourceManifestPath),
    source,
    paths: createCorpusPaths(source.id, dataRoot, workRoot),
    requestedUrls,
    validationFraction,
    testFraction,
    threads: numberArg(args, "threads", workers, { minimum: 1 }),
    canonicalizerWorkers: numberArg(args, "canonicalizer-workers", workers, { minimum: 0 }),
    duckdbMemory: stringArg(args, "duckdb-memory", "12GB")!,
    maximumTemporaryDirectorySize: stringArg(args, "max-temp", "30GB")!,
    storageBudgetBytes: parseByteSize(stringArg(args, "storage-budget", "70GB")!),
    minimumFreeBytes: parseByteSize(stringArg(args, "minimum-free", "20GB")!),
    targetShardBytes: parseByteSize(stringArg(args, "target-shard-bytes", "256MiB")!),
    stagingShards: numberArg(args, "staging-shards", 64, { minimum: 1, maximum: 4096 }),
    compact: storageProfile === "compact",
    keepPack: booleanArg(args, "keep-pack", false),
    benchmarkLoader: booleanArg(args, "benchmark-loader", false),
    force: booleanArg(args, "force", false),
    candidateFiles: stringArgs(args, "candidate-file"),
    awsRegion: stringArg(args, "aws-region", "us-east-1")!,
    ...(athenaOutput === undefined ? {} : { athenaOutput }),
    ...(athenaWorkgroup === undefined ? {} : { athenaWorkgroup })
  });
  await pipeline.initialize();

  if (command === "sample") await pipeline.sample();
  else if (command === "materialize") await pipeline.materialize();
  else if (command === "pack") await pipeline.pack();
  else if (command === "verify") await pipeline.verify();
  else await pipeline.all();
}

main().catch(error => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
