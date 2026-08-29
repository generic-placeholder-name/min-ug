import { defineCanonicalizationBehavior } from "../behavior-pipeline.js";
import { hostMatchesSuffix } from "../host.js";
import { makeChange, emptyList } from "../result.js";
import { aggressivePolicy } from "../rules/aggressive.js";

const amazonDomains = new Set(aggressivePolicy.amazonDomains);

function rewriteAmazonProduct (browserUrl: string) {
  const parsed = new URL(browserUrl);
  const isAmazon = [...amazonDomains].some(domain => hostMatchesSuffix(parsed.hostname, domain));
  if (!isAmazon) return { url: browserUrl, changes: emptyList };

  const match = /^\/(?:[^/]+\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/.*)?$/iu.exec(
    parsed.pathname
  );
  if (match === null) return { url: browserUrl, changes: emptyList };

  parsed.pathname = `/dp/${match[1]!.toUpperCase()}`;
  const after = parsed.href;
  if (after === browserUrl) return { url: browserUrl, changes: emptyList };
  return {
    url: after,
    changes: Object.freeze([
      makeChange("site:amazon-product", "site-rewrite", "rewrite", browserUrl, after)
    ])
  };
}

export const amazonProductPath = defineCanonicalizationBehavior({
  id: "amazon-product-path",
  stage: "site-rewrite",
  apply: url => rewriteAmazonProduct(url)
});
