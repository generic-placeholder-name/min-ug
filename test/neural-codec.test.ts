import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { CanonicalUrl } from "../src/canonicalize/index.js";
import {
  CodecStatus,
  WasmCodecStatusError,
  instantiateWasmCodec
} from "../src/codec/wasm-adapter.js";

const cases = [
  "https://example.com/",
  "https://www.example.com/a/b/c?x=1&next=a%3Db%3Dc#fragment",
  "http://localhost:8080/path",
  "https://xn--bcher-kva.example/%E2%9C%93",
  "https://example.com/%E6%97%A5%E6%9C%AC%E8%AA%9E?q=%F0%9F%98%80",
  "https://subdomain.example.co.uk/a-very-long-file-name.html",
  "https://example.com/?empty=&repeated=1&repeated=2",
  `https://example.com/${"a".repeat(200)}`
] as const;

for (const model of ["gru-l", "transformer-l"] as const) {
  test(`${model} quantized WASM has the codec ABI and round trips`, async () => {
    const bytes = await readFile(new URL(`../codecs/artifacts/${model}.wasm`, import.meta.url));
    const module = await WebAssembly.compile(bytes);
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    const exports = WebAssembly.Module.exports(module)
      .filter(entry => entry.kind !== "global")
      .sort((left, right) => left.name.localeCompare(right.name));
    assert.deepEqual(exports, [
      { name: "memory", kind: "memory" },
      { name: "minug_alloc", kind: "function" },
      { name: "minug_decode", kind: "function" },
      { name: "minug_encode", kind: "function" },
      { name: "minug_free", kind: "function" }
    ]);
    const codec = await instantiateWasmCodec(module);
    for (const value of cases) {
      const payload = codec.encode(value as CanonicalUrl);
      assert.equal(codec.decode(payload), value);
      assert.deepEqual(codec.encode(value as CanonicalUrl), payload);
    }
    const prefix = "https://example.com/";
    const maximum = prefix + "a".repeat(511 - prefix.length);
    assert.equal(codec.decode(codec.encode(maximum as CanonicalUrl)), maximum);
    const oversized = `${maximum}a`;
    assert.throws(
      () => codec.encode(oversized as CanonicalUrl),
      error => error instanceof WasmCodecStatusError &&
        error.status === CodecStatus.INVALID_INPUT
    );
    assert.throws(
      () => codec.encode("https://example.com/é" as CanonicalUrl),
      error => error instanceof WasmCodecStatusError &&
        error.status === CodecStatus.INVALID_INPUT
    );
  });
}
