import { defineCanonicalizationBehavior } from "../behavior-pipeline.js";
import { hostMatchesSuffix } from "../host.js";
import { makeChange, emptyList } from "../result.js";
import { aggressivePolicy } from "../rules/aggressive.js";
import { firefoxQueryStrippingSnapshot } from "../rules/firefox-query-stripping.js";

const conservativeStripParameters = new Set(
  firefoxQueryStrippingSnapshot.stripParameters.map(name => name.toLowerCase())
);
const aggressiveStripRules = aggressivePolicy.stripParameterRules.map(rule => ({
  ...rule,
  expression: new RegExp(rule.pattern, "iu")
}));

interface QueryParts {
  readonly prefix: string;
  readonly fragment: string;
  segments: string[];
}

type StrippingTier = "conservative" | "aggressive";

function isAllowedBaseDomain (hostname: string): boolean {
  return firefoxQueryStrippingSnapshot.allowBaseDomains.some(domain =>
    hostMatchesSuffix(hostname, domain)
  );
}

function splitQuery (href: string): QueryParts | undefined {
  const fragmentIndex = href.indexOf("#");
  const beforeFragment = fragmentIndex === -1 ? href : href.slice(0, fragmentIndex);
  const queryIndex = beforeFragment.indexOf("?");
  if (queryIndex === -1) return undefined;
  return {
    prefix: beforeFragment.slice(0, queryIndex),
    fragment: fragmentIndex === -1 ? "" : href.slice(fragmentIndex),
    segments: beforeFragment.slice(queryIndex + 1).split("&")
  };
}

function decodedParameterName (segment: string): string | undefined {
  const iterator = new URLSearchParams(segment).keys();
  const first = iterator.next();
  return first.done ? undefined : first.value;
}

function serializeQuery (parts: QueryParts): string {
  return parts.segments.length === 0
    ? `${parts.prefix}${parts.fragment}`
    : `${parts.prefix}?${parts.segments.join("&")}${parts.fragment}`;
}

function aggressiveRuleFor (name: string) {
  return aggressiveStripRules.find(rule => rule.expression.test(name));
}

function stripParameters (browserUrl: string, tier: StrippingTier) {
  const parsed = new URL(browserUrl);
  if (tier === "conservative" && isAllowedBaseDomain(parsed.hostname)) {
    return { url: browserUrl, changes: emptyList };
  }

  const parts = splitQuery(browserUrl);
  if (parts === undefined) return { url: browserUrl, changes: emptyList };

  let current = browserUrl;
  const changes = [];
  for (let index = 0; index < parts.segments.length;) {
    const name = decodedParameterName(parts.segments[index]!);
    const normalizedName = name?.toLowerCase();
    const conservative = normalizedName !== undefined &&
      conservativeStripParameters.has(normalizedName);
    const aggressiveRule = normalizedName === undefined
      ? undefined
      : aggressiveRuleFor(normalizedName);
    if (!conservative && (tier !== "aggressive" || aggressiveRule === undefined)) {
      index += 1;
      continue;
    }

    const before = current;
    parts.segments.splice(index, 1);
    current = serializeQuery(parts);
    const ruleId = conservative
      ? `firefox-query-stripping:${normalizedName}`
      : `aggressive-query-stripping:${aggressiveRule!.id}`;
    changes.push(makeChange(ruleId, "strip-params", "removeParam", before, current));
  }

  return {
    url: current,
    changes: changes.length === 0 ? emptyList : Object.freeze(changes)
  };
}

export const conservativeQueryParameterStripping = defineCanonicalizationBehavior({
  id: "conservative-query-parameter-stripping",
  stage: "strip-params",
  apply: url => stripParameters(url, "conservative")
});

export const aggressiveQueryParameterStripping = defineCanonicalizationBehavior({
  id: "aggressive-query-parameter-stripping",
  stage: "strip-params",
  apply: url => stripParameters(url, "aggressive")
});
