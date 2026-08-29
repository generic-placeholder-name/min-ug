#!/usr/bin/env node

import {
  parseArgs,
  booleanArg,
  numberArg,
  stringArg,
  stringArgs
} from "../lib/args.js";
import { prepareCorpus } from "./prepare.js";

function usage () {
  console.log(`Usage:
  npm run corpus:prepare -- [options]

Options:
  --input <source-id=path>       Repeatable; defaults to ada-url=data/raw/ada-url.txt
  --output <directory>           Defaults to data/processed/stage0
  --normalization aggressive|clean|exact|browser|raw
                                Defaults to clean; browser is an exact-serialization alias
  --seed <text>                  Defaults to min-ug-stage0-v1
  --test-fraction <0..1>         Defaults to 0.2
  --include-adversarial <bool>   Defaults to true
  --limit <count>                Optional per-input development limit`);
}

async function main () {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command !== "prepare" || booleanArg(args, "help")) {
    usage();
    if (command !== "prepare") process.exitCode = command ? 1 : 0;
    return;
  }

  const inputs = stringArgs(args, "input", ["ada-url=data/raw/ada-url.txt"]);
  const manifest = await prepareCorpus({
    inputs,
    outputDirectory: stringArg(args, "output", "data/processed/stage0")!,
    normalization: stringArg(args, "normalization", "clean"),
    seed: stringArg(args, "seed", "min-ug-stage0-v1")!,
    testFraction: numberArg(args, "test-fraction", 0.2, { minimum: 0.01, maximum: 0.99 }),
    includeAdversarial: booleanArg(args, "include-adversarial", true),
    limit: args.limit === undefined
      ? undefined
      : numberArg(args, "limit", undefined, { minimum: 1 })
  });

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch(error => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
