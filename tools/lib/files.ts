import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function hashFile (path: string, algorithm: "sha1" | "sha256"): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function sha1File (path: string): Promise<string> {
  return hashFile(path, "sha1");
}

export async function sha256File (path: string): Promise<string> {
  return hashFile(path, "sha256");
}

export function sha256Text (value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function writeFileAtomic (
  path: string,
  contents: string | Uint8Array
): Promise<void> {
  const absolute = resolve(path);
  const temporary = `${absolute}.${process.pid}.tmp`;
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(temporary, contents);
  await rename(temporary, absolute);
}

export async function writeJsonAtomic (path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function toJsonLines (records: readonly unknown[]): string {
  return records.length === 0
    ? ""
    : `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
}
