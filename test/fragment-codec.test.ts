import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalUrl } from "../src/canonicalize/index.js";
import {
  createVersionedFragmentCodec,
  DISPLAY_LINK_PREFIX,
  FragmentCodecError,
  FRAGMENT_ALPHABET,
  framePayload,
  NAVIGATION_LINK_PREFIX,
  parseBitString,
  renderBitString,
  unframePayload
} from "../src/codec/fragment.js";
import type { LoadedCodec } from "../src/codec/wasm-adapter.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const identityCodec: LoadedCodec = {
  encode: url => encoder.encode(url),
  decode: payload => decoder.decode(payload)
};

function errorCode (code: string): (error: unknown) => boolean {
  return error => error instanceof FragmentCodecError && error.code === code;
}

test("base-81 rendering preserves arbitrary framed bytes and their exact bit length", () => {
  assert.equal(FRAGMENT_ALPHABET.length, 81);
  for (let length = 0; length <= 64; length += 1) {
    const payload = Uint8Array.from({ length }, (_, index) => index * 73 + length & 0xff);
    for (const frame of [
      { kind: "codec", codecId: 1, payload },
      { kind: "codec", codecId: 2, payload },
      { kind: "codec", codecId: 127, payload },
      { kind: "literal", payload }
    ] as const) {
      const bits = framePayload(frame);
      const rendered = renderBitString(bits);
      assert.deepEqual(parseBitString(rendered), bits);
      assert.deepEqual(unframePayload(bits), frame);
      assert.deepEqual(unframePayload(parseBitString(rendered)), frame);
    }
  }
});

test("v1 uses the two-bit 10 dispatch header without byte padding", () => {
  const framed = framePayload({ kind: "codec", codecId: 1, payload: Uint8Array.of(0x00, 0xff) });
  assert.equal(framed.bitLength, 18);
  assert.deepEqual(framed.bytes, Uint8Array.of(0x80, 0x3f, 0xc0));
  assert.deepEqual(unframePayload(framed), {
    kind: "codec",
    codecId: 1,
    payload: Uint8Array.of(0x00, 0xff)
  });
});

test("rare literal mode yields one bit so every future codec saves one", () => {
  assert.equal(framePayload({ kind: "literal", payload: new Uint8Array() }).bitLength, 4);
  assert.equal(framePayload({ kind: "codec", codecId: 2, payload: new Uint8Array() }).bitLength, 4);
  assert.equal(framePayload({ kind: "codec", codecId: 3, payload: new Uint8Array() }).bitLength, 6);
  assert.equal(framePayload({ kind: "codec", codecId: 4, payload: new Uint8Array() }).bitLength, 6);
  assert.equal(framePayload({ kind: "codec", codecId: 5, payload: new Uint8Array() }).bitLength, 8);
});

test("fragment alphabet survives standard URL fragment parsing literally", () => {
  const url = new URL(`${NAVIGATION_LINK_PREFIX}${FRAGMENT_ALPHABET}`);
  assert.equal(url.hash.slice(1), FRAGMENT_ALPHABET);
});

test("versioned fragment codec renders v1 and can still dispatch future IDs", () => {
  const secondCodec: LoadedCodec = {
    encode: url => encoder.encode(`two:${url}`),
    decode: payload => decoder.decode(payload).slice(4)
  };
  const codecs = new Map([[1, identityCodec], [2, secondCodec]]);
  const v1 = createVersionedFragmentCodec(codecs, 1);
  const value = "https://example.com/a?b=c" as CanonicalUrl;
  const fragment = v1.encodeFragment(value);
  assert.equal(v1.currentCodecId, 1);
  assert.equal(v1.render(value), `${DISPLAY_LINK_PREFIX}${fragment}`);
  assert.equal(v1.decodeFragment(fragment), value);
  assert.equal(v1.decodeHash(`#${fragment}`), value);

  const v2 = createVersionedFragmentCodec(codecs, 2);
  const future = v2.encodeFragment(value);
  assert.equal(v1.decodeFragment(future), value);
  assert.notEqual(fragment, future);
});

test("malformed, reserved, and unavailable frames fail instead of guessing a codec", () => {
  const codec = createVersionedFragmentCodec(new Map([[1, identityCodec]]), 1);
  assert.throws(() => parseBitString(""), errorCode("malformed-rendering"));
  assert.throws(() => parseBitString(`0${FRAGMENT_ALPHABET[1]}`), errorCode("malformed-rendering"));
  assert.throws(() => parseBitString("%"), errorCode("malformed-rendering"));
  assert.throws(
    () => unframePayload({ bytes: Uint8Array.of(0xd0), bitLength: 4 }),
    errorCode("reserved-frame")
  );
  const unavailable = renderBitString(framePayload({ kind: "codec", codecId: 2, payload: new Uint8Array() }));
  assert.throws(() => codec.decodeFragment(unavailable), errorCode("unknown-codec"));
  assert.throws(() => codec.decodeHash(unavailable), errorCode("invalid-hash"));
});

test("fragment bounds are enforced before unbounded conversion or emission", () => {
  const value = "https://example.com/" as CanonicalUrl;
  const tinyPayload = createVersionedFragmentCodec(new Map([[1, identityCodec]]), 1, {
    maximumPayloadBytes: 1
  });
  assert.throws(() => tinyPayload.encodeFragment(value), errorCode("payload-limit"));

  const tinyRendering = createVersionedFragmentCodec(new Map([[1, identityCodec]]), 1, {
    maximumRenderedCharacters: 2
  });
  assert.throws(() => tinyRendering.encodeFragment(value), errorCode("rendered-limit"));
  assert.throws(() => tinyRendering.decodeFragment("123"), errorCode("rendered-limit"));
});
