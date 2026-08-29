import { readFile } from "node:fs/promises";

const fixtureUrl = new URL("../../corpus/adversarial.jsonl", import.meta.url);

export interface AdversarialCase {
  readonly name: string;
  readonly url: string;
  readonly tags: readonly string[];
}

function parseCase (line: string, index: number): AdversarialCase {
  const value: unknown = JSON.parse(line);
  if (
    value === null ||
    typeof value !== "object" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !("tags" in value) ||
    !Array.isArray(value.tags) ||
    !value.tags.every(tag => typeof tag === "string")
  ) {
    throw new Error(`adversarial.jsonl:${index + 1}: invalid case`);
  }
  return { name: value.name, url: value.url, tags: value.tags };
}

export async function loadAdversarialCases (): Promise<AdversarialCase[]> {
  const curated = (await readFile(fixtureUrl, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(parseCase);

  const byteEscapes = Array.from({ length: 256 }, (_, byte) => {
    const escape = byte.toString(16).toUpperCase().padStart(2, "0");
    return {
      name: `percent-byte-${escape}`,
      url: `https://bytes.example/path?value=%${escape}`,
      tags: ["percent-escape", "all-byte-escapes"]
    };
  });

  return [...curated, ...byteEscapes];
}
