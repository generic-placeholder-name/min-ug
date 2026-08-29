import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

import { CANONICAL_URL_BYTE_ALPHABET } from "../src/canonicalize/index.js";
import { CODEC_RELEASES, V1_RELEASE } from "../src/codec/releases.js";
import { booleanArg, parseArgs } from "./lib/args.js";
import { assertReleaseChecksum, verifyCodecReleases } from "./lib/codec-releases.js";
import { sha256File, writeJsonAtomic } from "./lib/files.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const crate = resolve(repository, "codecs/neural-codec");
const artifacts = resolve(repository, "codecs/artifacts");
const cargoTarget = resolve(repository, "data/work/cargo-neural-codecs");
const releaseEntropyCoder = V1_RELEASE.entropyCoder;
const args = parseArgs(process.argv.slice(2));
const compareEntropyCoders = booleanArg(args, "compare-entropy-coders");

async function run (
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", code => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

await run("uv", ["run", "--locked", "python", "-m", "training.export_wasm_models"], repository);
const modelManifest = JSON.parse(await readFile(
  resolve(crate, "models/manifest.json"),
  "utf8"
)) as { readonly alphabet?: unknown; readonly symbolCount?: unknown };
if (
  modelManifest.alphabet !== CANONICAL_URL_BYTE_ALPHABET ||
  modelManifest.symbolCount !== CANONICAL_URL_BYTE_ALPHABET.length + 1
) {
  throw new Error("Exported model alphabet does not match the canonical URL codec boundary");
}
await mkdir(artifacts, { recursive: true });

const built = [];
const entropyCoders = compareEntropyCoders
  ? (["arithmetic", "rans"] as const)
  : ([releaseEntropyCoder] as const);
for (const model of ["gru-l", "transformer-l"] as const) {
  for (const entropyCoder of entropyCoders) {
    await run(
      "cargo",
      [
        "build",
        "--release",
        "--target",
        "wasm32-unknown-unknown",
        "--target-dir",
        cargoTarget,
        "--no-default-features",
        "--features",
        `${model},${entropyCoder}`
      ],
      crate,
      { ...process.env, RUSTFLAGS: "-C target-feature=+simd128" }
    );
    const source = join(
      cargoTarget,
      "wasm32-unknown-unknown",
      "release",
      "minug_neural_codec.wasm"
    );
    const release = compareEntropyCoders
      ? undefined
      : CODEC_RELEASES.find(candidate => candidate.model === model);
    const candidateSha256 = await sha256File(source);
    if (release) assertReleaseChecksum(release, candidateSha256);
    const basename = compareEntropyCoders ? `${model}-${entropyCoder}` : model;
    const destination = resolve(artifacts, `${basename}.wasm`);
    await copyFile(source, destination);
    const contents = await readFile(destination);
    built.push({
      model,
      entropyCoder,
      codecId: release?.id ?? null,
      stability: release ? "frozen" : "experimental",
      path: `codecs/artifacts/${basename}.wasm`,
      bytes: contents.byteLength,
      gzipBytes: gzipSync(contents, { level: 9 }).byteLength,
      brotliBytes: brotliCompressSync(contents, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
      }).byteLength,
      sha256: candidateSha256
    });
  }
}

if (!compareEntropyCoders) await verifyCodecReleases(repository);

await writeJsonAtomic(resolve(
  artifacts,
  compareEntropyCoders ? "entropy-comparison-manifest.json" : "manifest.json"
), {
  schemaVersion: 2,
  createdAt: new Date().toISOString(),
  target: "wasm32-unknown-unknown",
  wasmFeatures: ["simd128"],
  quantization: "symmetric int8 per output row; f32 activation execution",
  probabilityTotal: 4096,
  entropyCoder: compareEntropyCoders ? "comparison" : releaseEntropyCoder,
  artifacts: built
});

for (const artifact of built) {
  console.log(`${artifact.model}/${artifact.entropyCoder}: ${artifact.bytes} bytes ${artifact.sha256}`);
}
