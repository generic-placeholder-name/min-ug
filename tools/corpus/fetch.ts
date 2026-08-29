#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { access, mkdir, readFile, rename } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, booleanArg, stringArg } from "../lib/args.js";
import { sha256File } from "../lib/files.js";
import { errorMessage } from "../lib/errors.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = resolve(projectRoot, "corpus/sources.json");

interface CorpusSource {
  readonly id: string;
  readonly url: string;
  readonly output: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface CorpusSourceManifest {
  readonly sources: readonly CorpusSource[];
}

function projectPath (relativePath: string): string {
  const absolute = resolve(projectRoot, relativePath);
  const rootPrefix = `${projectRoot}${sep}`.toLowerCase();
  if (!absolute.toLowerCase().startsWith(rootPrefix)) {
    throw new Error(`Refusing to write outside the project: ${relativePath}`);
  }
  return absolute;
}

async function exists (path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fetchSource (source: CorpusSource, force: boolean): Promise<void> {
  const output = projectPath(source.output);

  if (!force && await exists(output)) {
    const hash = await sha256File(output);
    if (hash === source.sha256) {
      console.log(`${source.id}: already present and verified (${hash.slice(0, 12)})`);
      return;
    }
    throw new Error(
      `${source.id}: ${source.output} exists but has SHA-256 ${hash}; ` +
      `expected ${source.sha256}. Use --force to replace it.`
    );
  }

  console.log(`${source.id}: downloading ${source.url}`);
  const response = await fetch(source.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${source.id}: download failed with HTTP ${response.status}`);
  }

  if (response.body === null) throw new Error(`${source.id}: response has no body`);
  const temporary = `${output}.${process.pid}.tmp`;
  await mkdir(dirname(output), { recursive: true });
  const stream = createWriteStream(temporary, { flags: "wx" });
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      digest.update(buffer);
      if (!stream.write(buffer)) await once(stream, "drain");
    }
    stream.end();
    await once(stream, "close");
  } catch (error) {
    stream.destroy();
    throw error;
  }
  const hash = digest.digest("hex");
  if (bytes !== source.bytes || hash !== source.sha256) {
    throw new Error(
      `${source.id}: downloaded file did not match the manifest ` +
      `(bytes ${bytes}/${source.bytes}, sha256 ${hash}/${source.sha256})`
    );
  }

  await rename(temporary, output);
  console.log(`${source.id}: wrote ${source.output} (${bytes} bytes)`);
}

async function main () {
  const args = parseArgs(process.argv.slice(2));
  const force = booleanArg(args, "force", false);
  const selected = stringArg(args, "source", "all")!;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CorpusSourceManifest;
  const sources = selected === "all"
    ? manifest.sources
    : manifest.sources.filter(source => source.id === selected);

  if (sources.length === 0) {
    throw new Error(`Unknown corpus source ${JSON.stringify(selected)}`);
  }

  for (const source of sources) await fetchSource(source, force);
}

main().catch(error => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : errorMessage(error));
  process.exitCode = 1;
});
