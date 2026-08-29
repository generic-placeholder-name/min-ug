import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalize } from "../src/canonicalize/index.js";
import type { CanonicalUrl } from "../src/canonicalize/index.js";
import {
  createWasmCodecAdapter,
  instantiateWasmCodec
} from "../src/codec/wasm-adapter.js";
import { loadAdversarialCases } from "../tools/corpus/adversarial.js";

const identityFixtureUrl = new URL("./fixtures/identity-codec/identity.wasm", import.meta.url);
const encoder = new TextEncoder();
let fixtureModulePromise: Promise<WebAssembly.Module> | undefined;

interface IdentityExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly minug_alloc: (length: number) => number;
  readonly minug_free: (pointer: number, length: number) => unknown;
  readonly minug_encode: (
    inputPointer: number,
    inputLength: number,
    descriptorPointer: number
  ) => number;
  readonly minug_decode: (
    inputPointer: number,
    inputLength: number,
    descriptorPointer: number
  ) => number;
}

function identityExports (instance: WebAssembly.Instance): IdentityExports {
  return instance.exports as IdentityExports;
}

async function loadIdentityModule (): Promise<WebAssembly.Module> {
  fixtureModulePromise ??= readFile(identityFixtureUrl).then(bytes => WebAssembly.compile(bytes));
  return fixtureModulePromise;
}

test("identity fixture has the frozen five-export ABI and no imports", async () => {
  const module = await loadIdentityModule();
  assert.deepEqual(WebAssembly.Module.imports(module), []);

  const publicExports = WebAssembly.Module.exports(module)
    .filter(entry => entry.kind !== "global")
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(publicExports, [
    { name: "memory", kind: "memory" },
    { name: "minug_alloc", kind: "function" },
    { name: "minug_decode", kind: "function" },
    { name: "minug_encode", kind: "function" },
    { name: "minug_free", kind: "function" }
  ]);
  assert(!WebAssembly.Module.exports(module).some(entry => entry.name === "minug_codec_abi_version"));

  const instance = await WebAssembly.instantiate(module, {}) as WebAssembly.Instance;
  const exports = identityExports(instance);
  assert.equal(exports.minug_alloc.length, 1);
  assert.equal(exports.minug_free.length, 2);
  assert.equal(exports.minug_encode.length, 3);
  assert.equal(exports.minug_decode.length, 3);
});

test("identity codec preserves every accepted post-canonicalization URL exactly", async () => {
  const codec = await instantiateWasmCodec(await loadIdentityModule());
  const records = await loadAdversarialCases();

  for (const record of records) {
    const canonical = canonicalize(record.url, { preset: "exact" });
    const payload = codec.encode(canonical.url);
    assert.deepEqual(payload, encoder.encode(canonical.url), `identity bytes: ${record.name}`);

    const decoded = codec.decode(payload);
    assert.equal(decoded, canonical.url, `codec round trip: ${record.name}`);
    assert.equal(
      canonicalize(decoded, { preset: "exact" }).url,
      decoded,
      `canonical fixed point: ${record.name}`
    );
    assert.deepEqual(codec.encode(canonical.url), payload, `determinism: ${record.name}`);
  }
});

test("codec identity begins after canonicalization, not at the pasted spelling", async () => {
  const raw = "HTTPS://EXAMPLE.COM:443/a/./b/../c";
  const canonical = canonicalize(raw, { preset: "exact" });
  const codec = await instantiateWasmCodec(await loadIdentityModule());

  const decoded = codec.decode(codec.encode(canonical.url));
  assert.notEqual(canonical.url, raw);
  assert.equal(canonical.url, "https://example.com/a/c");
  assert.equal(decoded, canonical.url);
});

test("identity fixture implements the canonical empty-slice representation", async () => {
  const codec = await instantiateWasmCodec(await loadIdentityModule());
  assert.deepEqual(codec.encode("" as CanonicalUrl), new Uint8Array());
  assert.equal(codec.decode(new Uint8Array()), "");
});

test("adapter refreshes memory views when identity encode grows memory", async () => {
  const instance = await WebAssembly.instantiate(
    await loadIdentityModule(),
    {}
  ) as WebAssembly.Instance;
  const exports = identityExports(instance);
  const memory = exports.memory;
  const rawEncode = exports.minug_encode;
  let beforeOperation = 0;
  let afterOperation = 0;

  function minug_encode (inputPointer: number, inputLength: number, descriptorPointer: number) {
    beforeOperation = memory.buffer.byteLength;
    const status = rawEncode(inputPointer, inputLength, descriptorPointer);
    afterOperation = memory.buffer.byteLength;
    return status;
  }

  const codec = createWasmCodecAdapter({
    memory,
    minug_alloc: exports.minug_alloc,
    minug_free: exports.minug_free,
    minug_encode,
    minug_decode: exports.minug_decode
  });
  const canonicalUrl = `https://example.com/${"a".repeat(900_000)}`;
  const payload = codec.encode(canonicalUrl as CanonicalUrl);

  assert(afterOperation > beforeOperation, "identity operation should force memory.grow");
  assert.equal(payload.byteLength, encoder.encode(canonicalUrl).byteLength);
  assert.deepEqual(payload, encoder.encode(canonicalUrl));
});

test("adapter refreshes memory views when identity decode grows memory", async () => {
  const instance = await WebAssembly.instantiate(
    await loadIdentityModule(),
    {}
  ) as WebAssembly.Instance;
  const exports = identityExports(instance);
  const memory = exports.memory;
  const rawDecode = exports.minug_decode;
  let beforeOperation = 0;
  let afterOperation = 0;

  function minug_decode (inputPointer: number, inputLength: number, descriptorPointer: number) {
    beforeOperation = memory.buffer.byteLength;
    const status = rawDecode(inputPointer, inputLength, descriptorPointer);
    afterOperation = memory.buffer.byteLength;
    return status;
  }

  const codec = createWasmCodecAdapter({
    memory,
    minug_alloc: exports.minug_alloc,
    minug_free: exports.minug_free,
    minug_encode: exports.minug_encode,
    minug_decode
  });
  const expected = "a".repeat(900_000);

  assert.equal(codec.decode(encoder.encode(expected)), expected);
  assert(afterOperation > beforeOperation, "identity operation should force memory.grow");
});
