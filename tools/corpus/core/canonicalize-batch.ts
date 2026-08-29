import { canonicalize, CanonicalizationError } from "../../../src/canonicalize/index.js";

export interface CanonicalizationInput {
  readonly ordinal: number;
  readonly url: string;
}

export interface CanonicalizedUrl {
  readonly ordinal: number;
  readonly url: string;
  readonly hostname: string;
}

export interface CanonicalizationRejection {
  readonly ordinal: number;
  readonly code: string;
  readonly detail: string;
}

export interface CanonicalizationBatchResult {
  readonly accepted: readonly CanonicalizedUrl[];
  readonly rejected: readonly CanonicalizationRejection[];
}

export function canonicalizeBatch (
  inputs: readonly CanonicalizationInput[]
): CanonicalizationBatchResult {
  const accepted: CanonicalizedUrl[] = [];
  const rejected: CanonicalizationRejection[] = [];
  for (const input of inputs) {
    try {
      const result = canonicalize(input.url, { preset: "clean" });
      accepted.push({
        ordinal: input.ordinal,
        url: result.url,
        hostname: new URL(result.url).hostname.toLowerCase()
      });
    } catch (error) {
      rejected.push({
        ordinal: input.ordinal,
        code: error instanceof CanonicalizationError ? error.code : "canonicalization-failed",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { accepted, rejected };
}
