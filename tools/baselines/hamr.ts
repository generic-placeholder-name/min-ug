import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { compress, decompress } from "../../vendor/ha-mr/compress.js";
import {
  outputAlphabetASCII,
  outputAlphabetQR
} from "../../vendor/ha-mr/alphabets.js";
import { errorMessage } from "../lib/errors.js";

const manifestUrl = new URL("../../vendor/ha-mr/manifest.json", import.meta.url);

export class BaselineInputError extends Error {
  readonly code: string;

  constructor (code: string, message: string) {
    super(message);
    this.name = "BaselineInputError";
    this.code = code;
  }
}

export interface HamrVendorMetadata {
  readonly schemaVersion: number;
  readonly name: string;
  readonly revision: string;
  readonly files: Readonly<Record<string, {
    readonly bytes: number;
    readonly sha256: string;
  }>>;
  readonly [key: string]: unknown;
}

export interface HamrBaseline {
  readonly id: "ha-mr-latest";
  readonly alphabetName: string;
  readonly alphabet: readonly string[];
  readonly alphabetSize: number;
  encode(input: string): string;
  decode(payload: string): string;
  render(payload: string): string;
  countSymbols(payload: string): number;
  isInputError(error: unknown): boolean;
}

const alphabets: Readonly<Record<"ascii" | "qr", readonly string[]>> = Object.freeze({
  ascii: outputAlphabetASCII,
  qr: outputAlphabetQR
});

export async function getHamrMetadata (): Promise<HamrVendorMetadata> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as HamrVendorMetadata;
}

export async function verifyHamrVendor (): Promise<HamrVendorMetadata> {
  const metadata = await getHamrMetadata();
  for (const [name, expected] of Object.entries(metadata.files)) {
    const contents = await readFile(new URL(`../../vendor/ha-mr/${name}`, import.meta.url));
    const actual = createHash("sha256").update(contents).digest("hex");
    if (contents.byteLength !== expected.bytes || actual !== expected.sha256) {
      throw new Error(
        `Vendored ha.mr file ${name} does not match manifest.json ` +
        `(bytes ${contents.byteLength}/${expected.bytes}, sha256 ${actual}/${expected.sha256})`
      );
    }
  }
  return metadata;
}

export function getHamrAlphabet (name = "ascii"): readonly string[] {
  const alphabet = alphabets[name as keyof typeof alphabets];
  if (!alphabet) {
    throw new BaselineInputError(
      "unknown-alphabet",
      `Unknown ha.mr alphabet ${JSON.stringify(name)}; expected ascii or qr`
    );
  }
  return alphabet;
}

/** Match the input checks in ha.mr's current browser UI for comparison benchmarks. */
export function validateHamrInput (input: string): string {
  const trimmed = input.trim();
  const hasProtocol = /\w+:\/\//.test(trimmed);
  let url;

  try {
    url = new URL(hasProtocol ? trimmed : `http://${trimmed}`);
  } catch (error) {
    throw new BaselineInputError("invalid-url", `Invalid URL: ${errorMessage(error)}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BaselineInputError(
      "unsupported-protocol",
      `Only http and https are supported, received ${url.protocol}`
    );
  }

  if (url.username || url.password) {
    throw new BaselineInputError("unsupported-credentials", "Credentials are not supported");
  }

  return trimmed;
}

export function createHamrBaseline (
  options: { readonly alphabet?: string | undefined } = {}
): HamrBaseline {
  const alphabetName = options.alphabet ?? "ascii";
  const alphabet = getHamrAlphabet(alphabetName);

  return Object.freeze({
    id: "ha-mr-latest",
    alphabetName,
    alphabet,
    alphabetSize: alphabet.length,
    encode (input: string) {
      return compress(validateHamrInput(input), alphabet);
    },
    decode (payload: string) {
      return decompress(payload, alphabet);
    },
    render (payload: string) {
      return alphabetName === "qr"
        ? `HTTP://HA.MR/${payload}`
        : `http://ha.mr#${payload}`;
    },
    countSymbols (payload: string) {
      return Array.from(payload).length;
    },
    isInputError (error: unknown) {
      return error instanceof BaselineInputError;
    }
  });
}
