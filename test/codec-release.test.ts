import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { CanonicalUrl } from "../src/canonicalize/index.js";
import { DISPLAY_LINK_PREFIX, parseBitString, unframePayload } from "../src/codec/fragment.js";
import { V1_RELEASE } from "../src/codec/releases.js";
import { instantiateV1Codec } from "../src/codec/v1.js";
import { instantiateWasmCodec } from "../src/codec/wasm-adapter.js";
import { assertReleaseChecksum } from "../tools/lib/codec-releases.js";

const v1Artifact = new URL("../codecs/artifacts/gru-l.wasm", import.meta.url);
const v1Fixtures = new URL("../codecs/releases/v1-fixtures.json", import.meta.url);

interface V1Fixtures {
  readonly codecId: number;
  readonly wasmSha256: string;
  readonly vectors: readonly {
    readonly url: string;
    readonly payloadHex: string;
    readonly fragment: string;
    readonly displayLink: string;
  }[];
}

test("codec ID 1 permanently identifies the pinned GRU-L WASM", async () => {
  const bytes = await readFile(v1Artifact);
  const actual = createHash("sha256").update(bytes).digest("hex");
  assert.equal(V1_RELEASE.id, 1);
  assert.equal(V1_RELEASE.model, "gru-l");
  assert.equal(V1_RELEASE.entropyCoder, "arithmetic");
  assert.equal(V1_RELEASE.artifact, "codecs/artifacts/gru-l.wasm");
  assertReleaseChecksum(V1_RELEASE, actual);
  assert.throws(
    () => assertReleaseChecksum(V1_RELEASE, "0".repeat(64)),
    /Released codec 1 \(gru-l\) is immutable/u
  );
});

test("the public v1 fragment path dispatches to GRU-L and round trips exactly", async () => {
  const codec = await instantiateV1Codec(await readFile(v1Artifact));
  const values = [
    "https://example.com/",
    "https://example.com/a/b?next=a%3Db%3Dc#inner",
    "https://example.com/%E6%97%A5%E6%9C%AC%E8%AA%9E?q=%F0%9F%98%80"
  ] as const;
  for (const value of values) {
    const fragment = codec.encodeFragment(value as CanonicalUrl);
    const framed = unframePayload(parseBitString(fragment));
    assert.equal(framed.kind, "codec");
    if (framed.kind === "codec") assert.equal(framed.codecId, 1);
    assert.equal(codec.decodeFragment(fragment), value);
    assert.equal(codec.decodeHash(`#${fragment}`), value);
    assert.equal(codec.render(value as CanonicalUrl), `${DISPLAY_LINK_PREFIX}${fragment}`);
  }
});

test("v1 reproduces its frozen byte payloads and complete rendered links", async () => {
  const [wasm, fixtureText] = await Promise.all([
    readFile(v1Artifact),
    readFile(v1Fixtures, "utf8")
  ]);
  const fixtures = JSON.parse(fixtureText) as V1Fixtures;
  assert.equal(fixtures.codecId, V1_RELEASE.id);
  assert.equal(fixtures.wasmSha256, V1_RELEASE.sha256);
  const core = await instantiateWasmCodec(wasm, {
    maxCanonicalUrlBytes: V1_RELEASE.maximumCanonicalUrlBytes,
    maxPayloadBytes: V1_RELEASE.maximumPayloadBytes
  });
  const v1 = await instantiateV1Codec(wasm);
  for (const fixture of fixtures.vectors) {
    const url = fixture.url as CanonicalUrl;
    assert.equal(Buffer.from(core.encode(url)).toString("hex"), fixture.payloadHex);
    assert.equal(v1.encodeFragment(url), fixture.fragment);
    assert.equal(v1.render(url), fixture.displayLink);
    assert.equal(v1.decodeFragment(fixture.fragment), fixture.url);
  }
});
