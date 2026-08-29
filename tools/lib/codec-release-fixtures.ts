import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { CanonicalUrl } from "../../src/canonicalize/index.js";
import { FRAGMENT_ALPHABET } from "../../src/codec/fragment.js";
import { V1_RELEASE } from "../../src/codec/releases.js";
import { instantiateV1Codec } from "../../src/codec/v1.js";
import { instantiateWasmCodec } from "../../src/codec/wasm-adapter.js";

const fixturePath = "codecs/releases/v1-fixtures.json";

interface StoredFixtures {
  readonly vectors: readonly { readonly url: string }[];
}

export async function generateV1Fixtures (repository: string) {
  const stored = JSON.parse(await readFile(resolve(repository, fixturePath), "utf8")) as StoredFixtures;
  const wasm = await readFile(resolve(repository, V1_RELEASE.artifact));
  const core = await instantiateWasmCodec(wasm, {
    maxCanonicalUrlBytes: V1_RELEASE.maximumCanonicalUrlBytes,
    maxPayloadBytes: V1_RELEASE.maximumPayloadBytes
  });
  const codec = await instantiateV1Codec(wasm);
  return {
    schemaVersion: 1,
    codecId: V1_RELEASE.id,
    wasmSha256: V1_RELEASE.sha256,
    framing: "10 || opaque payload bytes",
    alphabet: FRAGMENT_ALPHABET,
    vectors: stored.vectors.map(({ url }) => ({
      url,
      payloadHex: Buffer.from(core.encode(url as CanonicalUrl)).toString("hex"),
      fragment: codec.encodeFragment(url as CanonicalUrl),
      displayLink: codec.render(url as CanonicalUrl)
    }))
  };
}

export async function verifyV1Fixtures (repository: string): Promise<void> {
  const stored = JSON.parse(await readFile(resolve(repository, fixturePath), "utf8"));
  assert.deepEqual(stored, await generateV1Fixtures(repository), "codec ID 1 fixtures have drifted");
}

export const V1_FIXTURE_PATH = fixturePath;
