import { runCanonicalizationBehaviors } from "./behavior-pipeline.js";
import {
  CANONICAL_URL_BYTE_ALPHABET,
  isCanonicalUrlByteSpelling
} from "./codec-domain.js";
import { presetPolicies } from "./policies.js";
import { preflight } from "./preflight.js";
import { makeWarning, emptyList } from "./result.js";

declare const canonicalUrlBrand: unique symbol;

/** An accepted HTTP(S) URL ready to cross the codec boundary. */
export type CanonicalUrl = string & { readonly [canonicalUrlBrand]: true };

export type CanonicalizationPreset = "aggressive" | "clean" | "exact";
export type CanonicalizationStage = "unwrap" | "site-rewrite" | "strip-params" | "rfc-normalize";
export type CanonicalizationChangeKind =
  | "removeParam"
  | "unwrap"
  | "rewrite"
  | "normalize"
  | "dropIndexFile";
export type CanonicalizationWarningCode =
  | "credentials-in-url"
  | "signed-url-detected"
  | "unwrap-depth-exceeded"
  | "rule-failed"
  | "canonicalizer-unstable";
export type CanonicalizationWarningSeverity = "info" | "warn" | "block";

export { CANONICAL_URL_BYTE_ALPHABET };

/** One user-visible, independently reversible optional transformation. */
export interface CanonicalizationChange {
  readonly ruleId: string;
  readonly stage: CanonicalizationStage;
  readonly kind: CanonicalizationChangeKind;
  /** Complete URL before this transformation. */
  readonly before: string;
  /** Complete URL after this transformation. */
  readonly after: string;
  readonly savedChars: number;
}

/** A condition the caller should surface alongside the canonicalization result. */
export interface CanonicalizationWarning {
  readonly code: CanonicalizationWarningCode;
  readonly severity: CanonicalizationWarningSeverity;
  readonly detail: string;
}

export interface CanonicalizationResult {
  /** Original string supplied by the caller. */
  readonly parsedFrom: string;
  /** URL produced by the browser-compatible mandatory serialization step. */
  readonly browserUrl: string;
  /** URL to encode. This equals `browserUrl` when Exact is effective. */
  readonly url: CanonicalUrl;
  readonly requestedPreset: CanonicalizationPreset;
  /** May be Exact despite the request when cleaning could invalidate a hazardous URL. */
  readonly effectivePreset: CanonicalizationPreset;
  /** Ordered chain from `browserUrl` to `url`, suitable for display or restoration. */
  readonly changes: readonly CanonicalizationChange[];
  readonly warnings: readonly CanonicalizationWarning[];
}

export interface CanonicalizationOptions {
  readonly preset?: CanonicalizationPreset;
}

const supportedPresets = new Set(Object.keys(presetPolicies));

/** Thrown when the input cannot become an absolute HTTP(S) URL or the preset is unknown. */
export class CanonicalizationError extends Error {
  readonly code: string;

  constructor (code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CanonicalizationError";
    this.code = code;
  }
}

function applyPreset (browserUrl: string, preset: CanonicalizationPreset) {
  return runCanonicalizationBehaviors(browserUrl, presetPolicies[preset]);
}

function verifyResult (
  browserUrl: string,
  url: string,
  changes: readonly CanonicalizationChange[],
  preset: CanonicalizationPreset
): boolean {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.href !== url ||
    !isCanonicalUrlByteSpelling(url)
  ) {
    return false;
  }

  let cursor = browserUrl;
  for (const change of changes) {
    if (change.before !== cursor) return false;
    cursor = change.after;
  }
  if (cursor !== url) return false;

  const repeated = applyPreset(url, preset);
  return !repeated.abort && repeated.url === url && repeated.changes.length === 0;
}

function unstableWarning () {
  return makeWarning(
    "canonicalizer-unstable",
    "warn",
    "Canonicalization verification failed; returned the browser-serialized Exact URL instead."
  );
}

/**
 * Produces the URL passed to a codec.
 *
 * Clean is the default. Exact applies no optional transformations. Aggressive may unwrap an
 * embedded destination and apply broader, explicitly opt-in normalization. Hazard detection can
 * make Exact effective even when another preset was requested.
 */
export function canonicalize (
  input: string,
  options: CanonicalizationOptions = {}
): CanonicalizationResult {
  if (typeof input !== "string") {
    throw new CanonicalizationError("invalid-input", "URL input must be a string");
  }

  const requestedPreset = options.preset ?? "clean";
  if (!supportedPresets.has(requestedPreset)) {
    throw new CanonicalizationError(
      "unsupported-preset",
      `Canonicalization preset ${JSON.stringify(requestedPreset)} is not implemented`
    );
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch (cause) {
    throw new CanonicalizationError("invalid-url", "Input is not an absolute URL", cause);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CanonicalizationError(
      "unsupported-protocol",
      `Only http and https URLs are accepted, received ${parsed.protocol}`
    );
  }

  const browserUrl = parsed.href;
  if (!isCanonicalUrlByteSpelling(browserUrl)) {
    throw new CanonicalizationError(
      "unsupported-codec-byte",
      "Browser-serialized URL contains a byte outside the codec alphabet"
    );
  }

  const preflightWarnings = preflight(parsed);
  const cleaningSuppressed = preflightWarnings.some(warning =>
    warning.code === "credentials-in-url" || warning.code === "signed-url-detected"
  );
  const effectivePreset = requestedPreset !== "exact" && !cleaningSuppressed
    ? requestedPreset
    : "exact";
  const cleaned = applyPreset(browserUrl, effectivePreset);
  const warnings = cleaned.warnings.length === 0
    ? preflightWarnings
    : Object.freeze([...preflightWarnings, ...cleaned.warnings]);

  if (cleaned.abort || !verifyResult(browserUrl, cleaned.url, cleaned.changes, effectivePreset)) {
    const fallbackWarnings = cleaned.abort
      ? warnings
      : Object.freeze([...warnings, unstableWarning()]);
    return Object.freeze({
      parsedFrom: input,
      browserUrl,
      url: browserUrl as CanonicalUrl,
      requestedPreset,
      effectivePreset: "exact",
      changes: emptyList,
      warnings: fallbackWarnings
    });
  }

  return Object.freeze({
    parsedFrom: input,
    browserUrl,
    url: cleaned.url as CanonicalUrl,
    requestedPreset,
    effectivePreset,
    changes: cleaned.changes,
    warnings
  });
}
