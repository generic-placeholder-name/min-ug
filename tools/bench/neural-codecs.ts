#!/usr/bin/env node

import assert from "node:assert/strict";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { CanonicalUrl } from "../../src/canonicalize/index.js";
import {
  DISPLAY_LINK_PREFIX,
  framePayload,
  parseBitString,
  unframePayload,
  renderBitString
} from "../../src/codec/fragment.js";
import { V1_RELEASE } from "../../src/codec/releases.js";
import { instantiateWasmCodec } from "../../src/codec/wasm-adapter.js";
import { booleanArg, numberArg, parseArgs, stringArg } from "../lib/args.js";
import { writeJsonAtomic } from "../lib/files.js";
import { describe } from "./stats.js";

interface PackFile { readonly path: string }
interface PackShard {
  readonly index: number;
  readonly records: number;
  readonly files: {
    readonly bytes: PackFile;
    readonly offsets: PackFile;
    readonly splits: PackFile;
  };
}
interface PackManifest { readonly shards: readonly PackShard[] }
interface Location { readonly shard: PackShard; readonly index: number }

function generator (initial: number): () => number {
  let state = initial >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

async function sampleLocations (
  directory: string,
  manifest: PackManifest,
  split: number,
  count: number,
  seed: number
): Promise<Location[]> {
  const random = generator(seed);
  const selected: Location[] = [];
  let eligible = 0;
  for (const shard of manifest.shards) {
    const [splits, offsets] = await Promise.all([
      readFile(resolve(directory, shard.files.splits.path)),
      readFile(resolve(directory, shard.files.offsets.path))
    ]);
    for (let index = 0; index < shard.records; index += 1) {
      if (splits[index] !== split) continue;
      const start = offsets.readUInt32LE(index * 4);
      const end = offsets.readUInt32LE((index + 1) * 4);
      if (end - start > 511) continue;
      eligible += 1;
      const location = { shard, index };
      if (selected.length < count) selected.push(location);
      else {
        const replacement = Math.floor(random() * eligible);
        if (replacement < count) selected[replacement] = location;
      }
    }
  }
  if (selected.length !== count) {
    throw new Error(`split ${split} has only ${selected.length} eligible URLs`);
  }
  return selected;
}

async function loadUrls (directory: string, locations: readonly Location[]): Promise<string[]> {
  const grouped = new Map<number, Location[]>();
  for (const location of locations) {
    const group = grouped.get(location.shard.index) ?? [];
    group.push(location);
    grouped.set(location.shard.index, group);
  }
  const urls: string[] = [];
  for (const group of grouped.values()) {
    const shard = group[0]!.shard;
    const offsets = await readFile(resolve(directory, shard.files.offsets.path));
    const bytes = await open(resolve(directory, shard.files.bytes.path), "r");
    try {
      for (const location of group) {
        const start = offsets.readUInt32LE(location.index * 4);
        const end = offsets.readUInt32LE((location.index + 1) * 4);
        const buffer = Buffer.allocUnsafe(end - start);
        const result = await bytes.read(buffer, 0, buffer.length, start);
        if (result.bytesRead !== buffer.length) throw new Error("short training-pack read");
        urls.push(buffer.toString("utf8"));
      }
    } finally {
      await bytes.close();
    }
  }
  return urls;
}

function payloadCharacters (bytes: number, alphabet: number): number {
  return Math.ceil(bytes * 8 / Math.log2(alphabet));
}

async function benchmark (
  name: string,
  model: string,
  entropyCoder: string,
  wasmPath: string,
  urls: readonly string[],
  warmup: number
) {
  const wasm = await readFile(wasmPath);
  const codec = await instantiateWasmCodec(wasm, {
    maxCanonicalUrlBytes: 511,
    maxPayloadBytes: 2048,
    maxMemoryBytes: 64 * 1024 * 1024
  });
  for (const url of urls.slice(0, warmup)) {
    assert.equal(codec.decode(codec.encode(url as CanonicalUrl)), url);
  }

  const encodeMilliseconds: number[] = [];
  const decodeMilliseconds: number[] = [];
  const payloadBytes: number[] = [];
  const asciiCharacters: number[] = [];
  const qrCharacters: number[] = [];
  const originalCharacters: number[] = [];
  const framedFragmentCharacters: number[] = [];
  const framedLinkCharacters: number[] = [];
  const framedEncodeMilliseconds: number[] = [];
  const framedDecodeMilliseconds: number[] = [];
  let inputBytes = 0;
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]!;
    const startedEncode = performance.now();
    const payload = codec.encode(url as CanonicalUrl);
    const finishedCoreEncode = performance.now();
    encodeMilliseconds.push(finishedCoreEncode - startedEncode);
    const rendered = renderBitString(framePayload({
      kind: "codec",
      codecId: V1_RELEASE.id,
      payload
    }));
    framedEncodeMilliseconds.push(performance.now() - startedEncode);
    framedFragmentCharacters.push(rendered.length);
    framedLinkCharacters.push(DISPLAY_LINK_PREFIX.length + rendered.length);
    const startedFramedDecode = performance.now();
    const framed = unframePayload(parseBitString(rendered));
    assert.equal(framed.kind, "codec");
    let decodedPayload = payload;
    if (framed.kind === "codec") {
      assert.equal(framed.codecId, V1_RELEASE.id);
      decodedPayload = framed.payload;
    }
    const startedDecode = performance.now();
    const decoded = codec.decode(decodedPayload);
    const finishedDecode = performance.now();
    decodeMilliseconds.push(finishedDecode - startedDecode);
    framedDecodeMilliseconds.push(finishedDecode - startedFramedDecode);
    assert.equal(decoded, url, `${name} round trip ${index}`);
    if (index < 16) {
      assert.deepEqual(codec.encode(url as CanonicalUrl), payload, `${name} determinism ${index}`);
    }
    const bytes = Buffer.byteLength(url, "utf8");
    inputBytes += bytes;
    payloadBytes.push(payload.byteLength);
    asciiCharacters.push(payloadCharacters(payload.byteLength, 84));
    qrCharacters.push(payloadCharacters(payload.byteLength, 43));
    originalCharacters.push(Array.from(url).length);
  }
  return {
    candidate: name,
    model,
    entropyCoder,
    wasmBytes: (await stat(wasmPath)).size,
    urls: urls.length,
    exact: urls.length,
    inputBytes,
    payloadBytes: describe(payloadBytes),
    payloadBitsPerUrl: payloadBytes.reduce((sum, value) => sum + value * 8, 0) / urls.length,
    payloadToInputByteRatio: payloadBytes.reduce((sum, value) => sum + value, 0) / inputBytes,
    ascii84PayloadCharacters: describe(asciiCharacters),
    qr43PayloadCharacters: describe(qrCharacters),
    codec1Link: {
      codecId: V1_RELEASE.id,
      dispatchHeaderBits: 2,
      alphabetSize: 81,
      displayPrefix: DISPLAY_LINK_PREFIX,
      fragmentCharacters: describe(framedFragmentCharacters),
      linkCharacters: describe(framedLinkCharacters),
      encodeMilliseconds: describe(framedEncodeMilliseconds),
      decodeMilliseconds: describe(framedDecodeMilliseconds)
    },
    originalCharacters: describe(originalCharacters),
    encodeMilliseconds: describe(encodeMilliseconds),
    decodeMilliseconds: describe(decodeMilliseconds),
    urlsPerSecond: {
      encode: urls.length * 1000 / encodeMilliseconds.reduce((sum, value) => sum + value, 0),
      decode: urls.length * 1000 / decodeMilliseconds.reduce((sum, value) => sum + value, 0)
    }
  };
}

async function main () {
  const args = parseArgs(process.argv.slice(2));
  if (booleanArg(args, "help")) {
    console.log("Usage: npm run codec:neural:bench -- [--compare-entropy-coders] [--urls 200] [--warmup 3] [--output report.json]");
    return;
  }
  const compareEntropyCoders = booleanArg(args, "compare-entropy-coders");
  const count = numberArg(args, "urls", 200, { minimum: 2 })!;
  const packManifestPath = stringArg(
    args,
    "manifest",
    "data/training/cc-main-2026-30-balanced-v1/pack/manifest.json"
  )!;
  const output = stringArg(
    args,
    "output",
    compareEntropyCoders
      ? "reports/neural-entropy-comparison.json"
      : "reports/neural-wasm-benchmark.json"
  )!;
  const warmup = numberArg(args, "warmup", 3, { minimum: 0 })!;
  const directory = dirname(resolve(packManifestPath));
  const manifest = JSON.parse(await readFile(packManifestPath, "utf8")) as PackManifest;
  const half = Math.floor(count / 2);
  const locations = [
    ...await sampleLocations(directory, manifest, 1, half, 0x6d696e75),
    ...await sampleLocations(directory, manifest, 3, count - half, 0x636f6465)
  ];
  const urls = await loadUrls(directory, locations);
  const candidates = compareEntropyCoders
    ? [
        { model: "gru-l", entropyCoder: "arithmetic" },
        { model: "gru-l", entropyCoder: "rans" },
        { model: "transformer-l", entropyCoder: "arithmetic" },
        { model: "transformer-l", entropyCoder: "rans" }
      ]
    : [
        { model: "gru-l", entropyCoder: V1_RELEASE.entropyCoder },
        { model: "transformer-l", entropyCoder: V1_RELEASE.entropyCoder }
      ];
  const results = [];
  for (const candidate of candidates) {
    const name = `${candidate.model}/${candidate.entropyCoder}`;
    const basename = compareEntropyCoders
      ? `${candidate.model}-${candidate.entropyCoder}`
      : candidate.model;
    console.log(`benchmarking ${name} on ${urls.length} URLs`);
    results.push(await benchmark(
      name,
      candidate.model,
      candidate.entropyCoder,
      resolve(`codecs/artifacts/${basename}.wasm`),
      urls,
      warmup
    ));
  }
  const report = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    corpus: {
      manifest: resolve(packManifestPath),
      sample: "seeded reservoir; equal seen-host and unseen-host validation URLs",
      urls: count,
      maximumUrlBytes: 511
    },
    rendering: {
      scope: "payload estimates plus actual codec-ID-1 framing for every candidate",
      candidateEstimatesExclude: "bit framing, codec ID, and link prefix",
      asciiAlphabet: 84,
      qrAlphabet: 43,
      codec1: {
        codecId: V1_RELEASE.id,
        framing: "10 followed immediately by opaque codec bytes",
        fragmentAlphabet: 81,
        displayPrefix: DISPLAY_LINK_PREFIX
      }
    },
    results
  };
  await writeJsonAtomic(output, report);
  console.log(JSON.stringify(report, null, 2));
  console.log(`wrote ${output}`);
}

main().catch(error => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
