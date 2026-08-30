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

const [indexHtml, notFoundHtml, headersFile] = await Promise.all([
  requireFile("index.html"),
  requireFile("404.html"),
  requireFile("_headers")
]);

for (const [name, html] of [["index.html", indexHtml], ["404.html", notFoundHtml]] as const) {
  const source = html.toString("utf8");
  for (const match of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (match[1]!.trim().length !== 0) {
      throw new Error(`${name} contains an inline script that the production CSP will block`);
    }
  }
}

const headers = headersFile.toString("utf8");
const requiredSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "Referrer-Policy: no-referrer",
  "X-Content-Type-Options: nosniff"
];
for (const directive of requiredSecurityPolicy) {
  if (!headers.includes(directive)) {
    throw new Error(`Web build is missing security policy ${directive}`);
  }
}
if (headers.includes("'unsafe-inline'") || headers.includes("'unsafe-eval'")) {
  throw new Error("Web security policy must not permit unsafe inline or evaluated JavaScript");
}

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
