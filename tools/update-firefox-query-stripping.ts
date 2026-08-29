#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { booleanArg, parseArgs, stringArg } from "./lib/args.js";
import {
  firefoxQueryStrippingSource,
  updateFirefoxQueryStripping
} from "./rules/firefox-query-stripping.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage () {
  console.log(`Usage:
  npm run rules:firefox -- [options]

Options:
  --check              Verify that the checked-in artifact matches Mozilla
  --source <url>       Override the Firefox Remote Settings endpoint
  --output <path>      Override the generated module path
  --help               Show this message`);
}

async function main () {
  const args = parseArgs(process.argv.slice(2));
  if (booleanArg(args, "help")) {
    usage();
    return;
  }
  if (args._.length > 0) throw new Error(`Unexpected argument ${JSON.stringify(args._[0])}`);

  const sourceUrl = stringArg(args, "source", firefoxQueryStrippingSource)!;
  const outputPath = resolve(
    projectRoot,
    stringArg(args, "output", "src/canonicalize/rules/firefox-query-stripping.ts")!
  );
  const check = booleanArg(args, "check", false);
  const result = await updateFirefoxQueryStripping({ sourceUrl, outputPath, check });
  const action = check ? "verified" : (result.changed ? "updated" : "unchanged");
  console.log(
    `Firefox query stripping: ${action}; ` +
    `${result.compiled.stripParameters.length} parameters, ` +
    `${result.compiled.allowBaseDomains.length} allowlisted domains, ` +
    `revision ${result.compiled.recordsLastModified}`
  );
}

main().catch(error => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
