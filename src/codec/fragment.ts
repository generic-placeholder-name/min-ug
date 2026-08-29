import type { CanonicalUrl } from "../canonicalize/index.js";
import type { LoadedCodec } from "./wasm-adapter.js";

export const DISPLAY_LINK_PREFIX = "min.ug#";
export const NAVIGATION_LINK_PREFIX = "https://min.ug/#";

// Every character is admitted literally by RFC 3986's fragment grammar. Avoiding percent and
// hash prevents URL parsers from changing the rendered payload before the browser can parse it.
export const FRAGMENT_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._~!$&'()*+,;=:@/?";

const RADIX = BigInt(FRAGMENT_ALPHABET.length);
const alphabetIndexes = new Map(Array.from(FRAGMENT_ALPHABET, (character, index) => [character, index]));

export interface BitString {
  readonly bytes: Uint8Array;
  readonly bitLength: number;
}

export type FramedPayload =
  | { readonly kind: "literal"; readonly payload: Uint8Array }
  | { readonly kind: "codec"; readonly codecId: number; readonly payload: Uint8Array };

export class FragmentCodecError extends Error {
  readonly code: string;

  constructor (code: string, message: string) {
    super(message);
    this.name = "FragmentCodecError";
    this.code = code;
  }
}

export interface VersionedFragmentCodec {
  readonly currentCodecId: number;
  encodeFragment(url: CanonicalUrl): string;
  decodeFragment(fragment: string): string;
  decodeHash(hash: string): string;
  render(url: CanonicalUrl): string;
}

export interface VersionedFragmentCodecOptions {
  readonly maximumRenderedCharacters?: number;
  readonly maximumPayloadBytes?: number;
}

function requireCodecId (codecId: number): void {
  if (!Number.isSafeInteger(codecId) || codecId < 1) {
    throw new FragmentCodecError("invalid-codec-id", "A codec ID must be a positive safe integer");
  }
}

function bitsForCodec (codecId: number): number[] {
  requireCodecId(codecId);
  if (codecId === 1) return [1, 0];

  // Literal and framing-extension codes share 110. Later immutable codecs use 111 followed by
  // an Elias-gamma code, keeping every future codec one bit shorter than placing it below 1111.
  const binary = (codecId - 1).toString(2);
  return [1, 1, 1, ...new Array<number>(binary.length - 1).fill(0), ...Array.from(binary, Number)];
}

function bitsForFrame (value: FramedPayload): number[] {
  if (value.kind === "literal") return [1, 1, 0, 0];
  return bitsForCodec(value.codecId);
}

function getBit (bits: BitString, index: number): number {
  return bits.bytes[index >>> 3]! >>> (7 - (index & 7)) & 1;
}

function validateBitString (bits: BitString): void {
  if (!Number.isSafeInteger(bits.bitLength) || bits.bitLength < 1) {
    throw new FragmentCodecError("malformed-bits", "A framed bitstring must be nonempty");
  }
  const expectedBytes = Math.ceil(bits.bitLength / 8);
  if (bits.bytes.length !== expectedBytes) {
    throw new FragmentCodecError(
      "malformed-bits",
      `Bit length ${bits.bitLength} requires exactly ${expectedBytes} bytes`
    );
  }
  if (getBit(bits, 0) !== 1) {
    throw new FragmentCodecError("malformed-bits", "A framed bitstring must begin with 1");
  }
  const unusedBits = expectedBytes * 8 - bits.bitLength;
  if (unusedBits > 0 && (bits.bytes.at(-1)! & (1 << unusedBits) - 1) !== 0) {
    throw new FragmentCodecError("malformed-bits", "Unused low bits in the final byte must be zero");
  }
}

export function framePayload (value: FramedPayload): BitString {
  const header = bitsForFrame(value);
  const bitLength = header.length + value.payload.length * 8;
  const bytes = new Uint8Array(Math.ceil(bitLength / 8));
  for (let index = 0; index < header.length; index += 1) {
    const outputByte = index >>> 3;
    bytes[outputByte] = bytes[outputByte]! | header[index]! << (7 - (index & 7));
  }
  for (let byteIndex = 0; byteIndex < value.payload.length; byteIndex += 1) {
    const byte = value.payload[byteIndex]!;
    for (let bit = 0; bit < 8; bit += 1) {
      const outputIndex = header.length + byteIndex * 8 + bit;
      const outputByte = outputIndex >>> 3;
      bytes[outputByte] = bytes[outputByte]! |
        (byte >>> (7 - bit) & 1) << (7 - (outputIndex & 7));
    }
  }
  return Object.freeze({ bytes, bitLength });
}

function readGamma (bits: BitString, start: number): { readonly value: number; readonly end: number } {
  let zeros = 0;
  while (start + zeros < bits.bitLength && getBit(bits, start + zeros) === 0) zeros += 1;
  const significantBits = zeros + 1;
  if (start + zeros >= bits.bitLength || significantBits > 53) {
    throw new FragmentCodecError("malformed-frame", "Codec ID has an invalid gamma code");
  }
  const end = start + zeros + significantBits;
  if (end > bits.bitLength) {
    throw new FragmentCodecError("malformed-frame", "Codec ID gamma code is truncated");
  }
  let value = 0;
  for (let index = start + zeros; index < end; index += 1) {
    value = value * 2 + getBit(bits, index);
  }
  return { value, end };
}

function payloadAfterHeader (bits: BitString, headerBits: number): Uint8Array {
  const payloadBits = bits.bitLength - headerBits;
  if (payloadBits < 0 || payloadBits % 8 !== 0) {
    throw new FragmentCodecError(
      "malformed-frame",
      "The bits after the dispatch header do not form whole payload bytes"
    );
  }
  const output = new Uint8Array(payloadBits / 8);
  for (let byteIndex = 0; byteIndex < output.length; byteIndex += 1) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      byte = byte << 1 | getBit(bits, headerBits + byteIndex * 8 + bit);
    }
    output[byteIndex] = byte;
  }
  return output;
}

export function unframePayload (bits: BitString): FramedPayload {
  validateBitString(bits);
  if (bits.bitLength < 2) {
    throw new FragmentCodecError("malformed-frame", "Dispatch header is truncated");
  }
  if (getBit(bits, 1) === 0) {
    return { kind: "codec", codecId: 1, payload: payloadAfterHeader(bits, 2) };
  }
  if (bits.bitLength < 3) {
    throw new FragmentCodecError("malformed-frame", "Dispatch header is truncated");
  }
  if (getBit(bits, 2) === 0) {
    if (bits.bitLength < 4) {
      throw new FragmentCodecError("malformed-frame", "Dispatch header is truncated");
    }
    if (getBit(bits, 3) === 0) {
      return { kind: "literal", payload: payloadAfterHeader(bits, 4) };
    }
    throw new FragmentCodecError("reserved-frame", "This framing extension is not supported");
  }
  const gamma = readGamma(bits, 3);
  const codecId = gamma.value + 1;
  requireCodecId(codecId);
  return {
    kind: "codec",
    codecId,
    payload: payloadAfterHeader(bits, gamma.end)
  };
}

export function renderBitString (bits: BitString): string {
  validateBitString(bits);
  let value = 0n;
  for (const byte of bits.bytes) value = value << 8n | BigInt(byte);
  value >>= BigInt(bits.bytes.length * 8 - bits.bitLength);

  const output: string[] = [];
  while (value > 0n) {
    output.push(FRAGMENT_ALPHABET[Number(value % RADIX)]!);
    value /= RADIX;
  }
  return output.reverse().join("");
}

export function parseBitString (input: string, maximumCharacters = 1024 * 1024): BitString {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 1) {
    throw new FragmentCodecError("invalid-limit", "maximumCharacters must be a positive integer");
  }
  if (input.length === 0) throw new FragmentCodecError("malformed-rendering", "Rendered payload is empty");
  if (input.length > maximumCharacters) {
    throw new FragmentCodecError(
      "rendered-limit",
      `Rendered payload is ${input.length} characters; the limit is ${maximumCharacters}`
    );
  }
  if (input[0] === FRAGMENT_ALPHABET[0]) {
    throw new FragmentCodecError("malformed-rendering", "Rendered payload has a leading zero digit");
  }
  let value = 0n;
  for (const character of input) {
    const digit = alphabetIndexes.get(character);
    if (digit === undefined) {
      throw new FragmentCodecError(
        "malformed-rendering",
        `Character ${JSON.stringify(character)} is not in the fragment alphabet`
      );
    }
    value = value * RADIX + BigInt(digit);
  }

  const binary = value.toString(2);
  const bitLength = binary.length;
  const bytes = new Uint8Array(Math.ceil(bitLength / 8));
  value <<= BigInt(bytes.length * 8 - bitLength);
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return Object.freeze({ bytes, bitLength });
}

export function createVersionedFragmentCodec (
  codecs: ReadonlyMap<number, LoadedCodec>,
  currentCodecId: number,
  options: VersionedFragmentCodecOptions = {}
): VersionedFragmentCodec {
  requireCodecId(currentCodecId);
  if (!codecs.has(currentCodecId)) {
    throw new FragmentCodecError("unknown-codec", `Current codec ${currentCodecId} is not loaded`);
  }
  for (const id of codecs.keys()) requireCodecId(id);
  const maximumRenderedCharacters = options.maximumRenderedCharacters ?? 1024 * 1024;
  const maximumPayloadBytes = options.maximumPayloadBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maximumPayloadBytes) || maximumPayloadBytes < 0) {
    throw new FragmentCodecError("invalid-limit", "maximumPayloadBytes must be a nonnegative integer");
  }

  function encodeFragment (url: CanonicalUrl): string {
    const payload = codecs.get(currentCodecId)!.encode(url);
    if (payload.length > maximumPayloadBytes) {
      throw new FragmentCodecError(
        "payload-limit",
        `Codec payload is ${payload.length} bytes; the limit is ${maximumPayloadBytes}`
      );
    }
    const rendered = renderBitString(framePayload({ kind: "codec", codecId: currentCodecId, payload }));
    if (rendered.length > maximumRenderedCharacters) {
      throw new FragmentCodecError(
        "rendered-limit",
        `Rendered payload is ${rendered.length} characters; the limit is ${maximumRenderedCharacters}`
      );
    }
    return rendered;
  }

  function decodeFragment (fragment: string): string {
    const framed = unframePayload(parseBitString(fragment, maximumRenderedCharacters));
    if (framed.payload.length > maximumPayloadBytes) {
      throw new FragmentCodecError(
        "payload-limit",
        `Codec payload is ${framed.payload.length} bytes; the limit is ${maximumPayloadBytes}`
      );
    }
    if (framed.kind === "literal") return new TextDecoder("utf-8", { fatal: true }).decode(framed.payload);
    const codec = codecs.get(framed.codecId);
    if (!codec) throw new FragmentCodecError("unknown-codec", `Codec ${framed.codecId} is not loaded`);
    return codec.decode(framed.payload);
  }

  return Object.freeze({
    currentCodecId,
    encodeFragment,
    decodeFragment,
    decodeHash (hash: string) {
      if (!hash.startsWith("#")) {
        throw new FragmentCodecError("invalid-hash", "A location hash must begin with #");
      }
      return decodeFragment(hash.slice(1));
    },
    render (url: CanonicalUrl) {
      return `${DISPLAY_LINK_PREFIX}${encodeFragment(url)}`;
    }
  });
}
