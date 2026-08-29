import { defineCanonicalizationBehavior } from "../behavior-pipeline.js";
import { makeChange, emptyList } from "../result.js";
import { aggressivePolicy } from "../rules/aggressive.js";

const indexFiles = new Set(aggressivePolicy.indexFiles);
const unreservedByte = /^[A-Za-z0-9._~-]$/u;

function dropIndexFile (browserUrl: string) {
  const parsed = new URL(browserUrl);
  const slash = parsed.pathname.lastIndexOf("/");
  const filename = parsed.pathname.slice(slash + 1).toLowerCase();
  if (!indexFiles.has(filename)) return { url: browserUrl, changes: emptyList };

  parsed.pathname = parsed.pathname.slice(0, slash + 1) || "/";
  const after = parsed.href;
  return {
    url: after,
    changes: Object.freeze([
      makeChange("aggressive:drop-index-file", "rfc-normalize", "dropIndexFile", browserUrl, after)
    ])
  };
}

function normalizeEscapes (text: string, decodeDot = true): string {
  return text.replace(/%[0-9A-Fa-f]{2}/gu, escape => {
    const byte = Number.parseInt(escape.slice(1), 16);
    const character = String.fromCharCode(byte);
    if (unreservedByte.test(character) && (decodeDot || character !== ".")) return character;
    return `%${escape.slice(1).toUpperCase()}`;
  });
}

function normalizePathEscapes (pathname: string): string {
  return pathname.split("/").map(segment => {
    const decoded = normalizeEscapes(segment);
    return decoded === "." || decoded === ".."
      ? normalizeEscapes(segment, false)
      : decoded;
  }).join("/");
}

function normalizePercentEscapes (browserUrl: string) {
  const parsed = new URL(browserUrl);
  const originLength = parsed.origin.length;
  const fragmentIndex = browserUrl.indexOf("#", originLength);
  const queryIndex = browserUrl.indexOf("?", originLength);
  const pathEndCandidates = [queryIndex, fragmentIndex].filter(index => index !== -1);
  const pathEnd = pathEndCandidates.length === 0 ? browserUrl.length : Math.min(...pathEndCandidates);
  const path = browserUrl.slice(originLength, pathEnd);
  const suffix = browserUrl.slice(pathEnd);
  const after = `${browserUrl.slice(0, originLength)}${normalizePathEscapes(path)}${normalizeEscapes(suffix)}`;
  if (after === browserUrl) return { url: browserUrl, changes: emptyList };
  return {
    url: after,
    changes: Object.freeze([
      makeChange("rfc3986:percent-encoding", "rfc-normalize", "normalize", browserUrl, after)
    ])
  };
}

export const indexFileRemoval = defineCanonicalizationBehavior({
  id: "index-file-removal",
  stage: "rfc-normalize",
  apply: url => dropIndexFile(url)
});

export const percentEscapeNormalization = defineCanonicalizationBehavior({
  id: "percent-escape-normalization",
  stage: "rfc-normalize",
  apply: url => normalizePercentEscapes(url)
});
