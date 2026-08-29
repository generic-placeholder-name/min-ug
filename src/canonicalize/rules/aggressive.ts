/**
 * AdGuard and ClearURLs rules can depend on request context and browser-extension behavior
 * that an offline URL canonicalizer does not have. These are therefore min.ug policy choices,
 * not a claim of compatibility with either upstream list.
 */

export interface AggressiveStripParameterRule {
  readonly id: string;
  readonly pattern: string;
}

export interface AggressiveRedirectRule {
  readonly id: string;
  readonly hosts?: readonly string[];
  readonly hostSuffix?: string;
  readonly paths?: readonly string[];
  readonly parameters: readonly string[];
}

export interface AggressiveCanonicalizationPolicy {
  readonly provenance: {
    readonly reviewedAt: string;
    readonly references: readonly string[];
  };
  readonly stripParameterRules: readonly AggressiveStripParameterRule[];
  readonly redirectRules: readonly AggressiveRedirectRule[];
  readonly amazonDomains: readonly string[];
  readonly indexFiles: readonly string[];
}

function frozenRule<T extends object> (rule: T): Readonly<T> {
  return Object.freeze(rule);
}

export const aggressivePolicy: AggressiveCanonicalizationPolicy = Object.freeze({
  provenance: Object.freeze({
    reviewedAt: "2026-08-26",
    references: Object.freeze([
      "https://github.com/AdguardTeam/AdguardFilters/blob/master/TrackParamFilter/sections/general_url.txt",
      "https://github.com/ClearURLs/Rules/blob/master/data.min.json"
    ])
  }),

  // Matching decoded names prevents percent-encoding from bypassing a rule while the raw query
  // segment remains untouched unless that rule removes it.
  stripParameterRules: Object.freeze([
    frozenRule({ id: "campaign:utm", pattern: "^utm(?:_[a-z0-9_-]*)?$" }),
    frozenRule({ id: "campaign:mtm", pattern: "^mtm(?:_[a-z0-9_-]*)?$" }),
    frozenRule({ id: "campaign:itm", pattern: "^itm_[a-z0-9_-]+$" }),
    frozenRule({ id: "campaign:otm", pattern: "^otm_[a-z0-9_-]*$" }),
    frozenRule({ id: "campaign:ga", pattern: "^ga_[a-z0-9_-]+$" }),
    frozenRule({ id: "hubspot:hsa", pattern: "^hsa_[a-z0-9_-]+$" }),
    frozenRule({ id: "email:bsft", pattern: "^bsft_[a-z0-9_-]+$" }),
    frozenRule({ id: "adjust:campaign", pattern: "^(?:adj|adjust)_[a-z0-9_-]+$" }),
    frozenRule({ id: "adobe:coremetrics", pattern: "^cm_mmc(?:[a-z0-9_-]*)$" }),
    frozenRule({ id: "facebook:action", pattern: "^(?:fb_action_(?:types|ids)|action_(?:object|type|ref)_map)$" }),
    frozenRule({ id: "email:mc", pattern: "^mc_(?:cid|eid|tc)$" }),
    frozenRule({ id: "tracking:known-name", pattern: "^(?:_ga|_gl|__twitter_impression|adobe_mc_ref|adobe_mc_sdid|awc|cmpid|dclid|fbclid|gclid|gclsrc|gbraid|msclkid|s_cid|srsltid|tgclid|ttclid|twclid|wbraid|yclid|ysclid)$" }),
    frozenRule({ id: "tracking:known-click-id", pattern: "^(?:admitad_uid|aiad_clid|clickid|external_click_id|iclid|irclickid|rb_clickid|rtkcid|sscid|unicorn_click_id|wickedid)$" }),
    frozenRule({ id: "tracking:email", pattern: "^(?:_clde|_cldee|_ope|elq|elqaid|elqat|elqcampaignid|elqtrackid|eml-mediaplan|eml-name|eml-publisher|mkt_tok|ml_subscriber|ml_subscriber_hash|oly_anon_id|oly_enc_id|vero_conv|vero_id)$" }),
    frozenRule({ id: "tracking:analytics", pattern: "^(?:_openstat|clckid|cx_recswidget|dpg_(?:campaign|content|medium|source)|gs_l|hmb_(?:campaign|medium|source)|hsctatracking|oprtrack|tracking_source|usqp|wt_?z?mc|wtrid|ym_tracking_id)$" })
  ]),

  // Restrict unwrapping to embedded destinations because following redirects would make results
  // network-dependent and disclose the destination before the user navigates.
  redirectRules: Object.freeze([
    frozenRule({ id: "unwrap:google", hosts: Object.freeze(["google.com", "www.google.com"]), paths: Object.freeze(["/url"]), parameters: Object.freeze(["url", "q"]) }),
    frozenRule({ id: "unwrap:googleadservices", hostSuffix: "googleadservices.com", parameters: Object.freeze(["adurl"]) }),
    frozenRule({ id: "unwrap:youtube", hostSuffix: "youtube.com", paths: Object.freeze(["/redirect"]), parameters: Object.freeze(["q"]) }),
    frozenRule({ id: "unwrap:facebook", hosts: Object.freeze(["l.facebook.com", "lm.facebook.com"]), paths: Object.freeze(["/l.php"]), parameters: Object.freeze(["u"]) }),
    frozenRule({ id: "unwrap:reddit", hosts: Object.freeze(["out.reddit.com", "click.redditmail.com"]), parameters: Object.freeze(["url"]) }),
    frozenRule({ id: "unwrap:steam", hosts: Object.freeze(["steamcommunity.com"]), paths: Object.freeze(["/linkfilter/"]), parameters: Object.freeze(["url"]) }),
    frozenRule({ id: "unwrap:microsoft-safelinks", hostSuffix: "safelinks.protection.outlook.com", parameters: Object.freeze(["url"]) })
  ]),

  amazonDomains: Object.freeze([
    "amazon.ae", "amazon.ca", "amazon.cn", "amazon.co.jp", "amazon.co.uk",
    "amazon.com", "amazon.com.au", "amazon.com.be", "amazon.com.br", "amazon.com.mx",
    "amazon.com.tr", "amazon.de", "amazon.eg", "amazon.es", "amazon.fr", "amazon.in",
    "amazon.it", "amazon.nl", "amazon.pl", "amazon.sa", "amazon.se", "amazon.sg"
  ]),

  indexFiles: Object.freeze([
    "index.html", "index.htm", "index.php",
    "default.html", "default.htm", "default.asp", "default.aspx"
  ])
});
