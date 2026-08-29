import { defineCanonicalizationBehavior } from "../behavior-pipeline.js";
import { hostMatchesSuffix } from "../host.js";
import { preflight } from "../preflight.js";
import { makeChange, makeWarning, emptyList } from "../result.js";
import { aggressivePolicy } from "../rules/aggressive.js";
import type { CanonicalizationChange, CanonicalizationWarning } from "../index.js";
import type { AggressiveRedirectRule } from "../rules/aggressive.js";

interface RedirectMatch {
  readonly rule: AggressiveRedirectRule;
  readonly value: string;
}

function parameterValue (url: URL, names: readonly string[]): string | undefined {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  for (const [name, value] of url.searchParams) {
    if (wanted.has(name.toLowerCase())) return value;
  }
  return undefined;
}

function matchingRedirect (url: URL): RedirectMatch | undefined {
  for (const rule of aggressivePolicy.redirectRules) {
    const hostMatches = rule.hosts?.includes(url.hostname) ||
      (rule.hostSuffix !== undefined && hostMatchesSuffix(url.hostname, rule.hostSuffix));
    if (!hostMatches || (rule.paths !== undefined && !rule.paths.includes(url.pathname))) continue;
    const value = parameterValue(url, rule.parameters);
    if (value !== undefined) return { rule, value };
  }
  return undefined;
}

function unwrapStaticRedirects (browserUrl: string, maxDepth = 3) {
  let current = browserUrl;
  const changes: CanonicalizationChange[] = [];
  const warnings: CanonicalizationWarning[] = [];
  const seen = new Set([current]);

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const match = matchingRedirect(new URL(current));
    if (match === undefined) break;

    let candidate;
    try {
      candidate = new URL(match.value);
    } catch {
      warnings.push(makeWarning(
        "rule-failed",
        "warn",
        `${match.rule.id} found an embedded value that is not an absolute URL.`
      ));
      break;
    }
    if (candidate.protocol !== "http:" && candidate.protocol !== "https:") {
      warnings.push(makeWarning(
        "rule-failed",
        "warn",
        `${match.rule.id} found an embedded URL with unsupported scheme ${candidate.protocol}`
      ));
      break;
    }

    const candidateWarnings = preflight(candidate);
    if (candidateWarnings.length > 0) {
      return {
        url: browserUrl,
        changes: emptyList,
        warnings: Object.freeze([...warnings, ...candidateWarnings]),
        abort: true
      };
    }

    const after = candidate.href;
    if (seen.has(after)) {
      warnings.push(makeWarning(
        "rule-failed",
        "warn",
        `${match.rule.id} produced a redirect cycle; unwrapping stopped.`
      ));
      break;
    }
    changes.push(makeChange(match.rule.id, "unwrap", "unwrap", current, after));
    current = after;
    seen.add(current);
  }

  if (changes.length === maxDepth && matchingRedirect(new URL(current)) !== undefined) {
    return {
      url: browserUrl,
      changes: emptyList,
      warnings: Object.freeze([...warnings, makeWarning(
        "unwrap-depth-exceeded",
        "warn",
        `Static redirect nesting exceeds the limit of ${maxDepth}; returned Exact instead.`
      )]),
      abort: true
    };
  }

  return {
    url: current,
    changes: changes.length === 0 ? emptyList : Object.freeze(changes),
    warnings: warnings.length === 0 ? emptyList : Object.freeze(warnings),
    abort: false
  };
}

export const staticRedirectUnwrapping = defineCanonicalizationBehavior({
  id: "static-redirect-unwrapping",
  stage: "unwrap",
  apply: url => unwrapStaticRedirects(url)
});
