import { makeWarning, emptyList } from "./result.js";
import { detectProbableSignedUrlScheme } from "./signed-url.js";
import type { CanonicalizationWarning } from "./index.js";

export function preflight (url: URL): readonly CanonicalizationWarning[] {
  const warnings: CanonicalizationWarning[] = [];
  if (url.username !== "" || url.password !== "") {
    warnings.push(makeWarning(
      "credentials-in-url",
      "block",
      "The URL contains a username or password; require explicit confirmation before shortening it."
    ));
  }

  const signedUrlScheme = detectProbableSignedUrlScheme(url);
  if (signedUrlScheme !== undefined) {
    warnings.push(makeWarning(
      "signed-url-detected",
      "warn",
      `The URL matches ${signedUrlScheme}; optional cleaning must remain disabled.`
    ));
  }
  return warnings.length === 0 ? emptyList : Object.freeze(warnings);
}
