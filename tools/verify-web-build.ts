import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { V1_RELEASE } from "../src/codec/releases.js";

const output = path.resolve("web", "dist");

async function requireFile (file: string): Promise<Buffer> {
  try {
    return await readFile(path.join(output, file));
  } catch (cause) {
    throw new Error(`Web build is missing ${file}`, { cause });
  }
}

await Promise.all([
  requireFile("index.html"),
  requireFile("404.html")
]);

const assetNames = await readdir(path.join(output, "assets"));
const wasmNames = assetNames.filter(name => name.endsWith(".wasm"));
if (wasmNames.length !== 1) {
  throw new Error(`Expected one browser Wasm asset, found ${wasmNames.length}`);
}

const wasm = await requireFile(path.join("assets", wasmNames[0]!));
const actualHash = createHash("sha256").update(wasm).digest("hex");
if (actualHash !== V1_RELEASE.sha256) {
  throw new Error(`Browser Wasm hash ${actualHash} does not match V1 ${V1_RELEASE.sha256}`);
}

console.log(`web codec ${V1_RELEASE.id}: ${V1_RELEASE.model} ${actualHash}`);
