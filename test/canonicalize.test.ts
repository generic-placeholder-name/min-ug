import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_URL_BYTE_ALPHABET,
  CanonicalizationError,
  canonicalize
} from "../src/canonicalize/index.js";
import type {
  CanonicalizationPreset,
  CanonicalizationResult
} from "../src/canonicalize/index.js";
import { aggressivePolicy } from
  "../src/canonicalize/rules/aggressive.js";
import { firefoxQueryStrippingSnapshot } from
  "../src/canonicalize/rules/firefox-query-stripping.js";
import { loadAdversarialCases } from "../tools/corpus/adversarial.js";

const codecAlphabet = new Set(CANONICAL_URL_BYTE_ALPHABET);

test("the canonical URL codec alphabet has 91 unique single-byte symbols", () => {
  assert.equal(CANONICAL_URL_BYTE_ALPHABET.length, 91);
  assert.equal(codecAlphabet.size, 91);
  assert([...codecAlphabet].every(character => character.charCodeAt(0) < 128));
});

function assertReversibleLedger (result: CanonicalizationResult): void {
  let reversed: string = result.url;
  for (const change of [...result.changes].reverse()) {
    assert.equal(change.after, reversed);
    assert.equal(Object.hasOwn(change, "reversible"), false);
    assert(Object.isFrozen(change));
    reversed = change.before;
  }
  assert.equal(reversed, result.browserUrl);
  assert(Object.isFrozen(result.changes));
}

test("Exact canonicalization is WHATWG serialization followed by no optional changes", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["HTTPS://EXAMPLE.COM:443/a/./b/../c", "https://example.com/a/c"],
    ["https://exämple.com/a b", "https://xn--exmple-cua.com/a%20b"],
    ["https://example.com", "https://example.com/"],
    ["https://example.com/a//b/", "https://example.com/a//b/"],
    ["https://example.com/%2f/%Aa?q=%bB", "https://example.com/%2f/%Aa?q=%bB"],
    ["https://example.com/path?next=a=b=c", "https://example.com/path?next=a=b=c"],
    ["https://example.com/path?bare=a+b&escaped=a%2Bb", "https://example.com/path?bare=a+b&escaped=a%2Bb"]
  ];

  for (const [input, expected] of cases) {
    const result = canonicalize(input, { preset: "exact" });
    assert.equal(result.url, expected, input);
    assert.equal(result.browserUrl, expected, input);
    assert.equal(result.parsedFrom, input);
    assert.deepEqual(result.changes, []);
    assert(Object.isFrozen(result));
    assert(Object.isFrozen(result.changes));

    const repeated = canonicalize(result.url, { preset: "exact" });
    assert.equal(repeated.url, result.url, `idempotence: ${input}`);
    assert.equal(new URL(result.url).href, result.url, `parse stability: ${input}`);
  }
});

test("Exact mode performs preflight without changing the URL", () => {
  const credentials = canonicalize("https://alice:secret@example.com/private", { preset: "exact" });
  assert.equal(credentials.url, "https://alice:secret@example.com/private");
  assert.deepEqual(credentials.warnings.map(warning => warning.code), ["credentials-in-url"]);
  assert.equal(credentials.warnings[0]!.severity, "block");

  const signed = canonicalize(
    "https://cdn.example.com/object?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=a%2Bb%2Fc",
    { preset: "exact" }
  );
  assert.equal(
    signed.url,
    "https://cdn.example.com/object?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=a%2Bb%2Fc"
  );
  assert.deepEqual(signed.warnings.map(warning => warning.code), ["signed-url-detected"]);
  assert.deepEqual(signed.changes, []);
});

test("preflight warnings are ordered, immutable, and case-insensitive", () => {
  const result = canonicalize(
    "https://alice:secret@EXAMPLE.COM/file?X-AmZ-AlGoRiThM=AWS4-HMAC-SHA256&X-AmZ-SiGnAtUrE=abc",
    { preset: "exact" }
  );

  assert.equal(
    result.url,
    "https://alice:secret@example.com/file?X-AmZ-AlGoRiThM=AWS4-HMAC-SHA256&X-AmZ-SiGnAtUrE=abc"
  );
  assert.deepEqual(
    result.warnings.map(warning => [warning.code, warning.severity]),
    [
      ["credentials-in-url", "block"],
      ["signed-url-detected", "warn"]
    ]
  );
  assert(Object.isFrozen(result.warnings));
  assert(result.warnings.every(Object.isFrozen));
  assert.deepEqual(result.changes, []);
});

test("signed URL preflight recognizes documented provider formats", () => {
  const cases: readonly (readonly [string, string])[] = [
    [
      "AWS Signature Version 4",
      "https://downloads.example.com/object?X-Amz-Credential=AKIA%2Fscope&X-Amz-Signature=abc"
    ],
    [
      "Google Cloud Storage V4 signing",
      "https://storage.googleapis.com/bucket/object?X-Goog-Date=20260826T120000Z&X-Goog-Signature=abc"
    ],
    [
      "Amazon CloudFront signing",
      "https://media.example.com/video?Policy=abc&Signature=def&Key-Pair-Id=K123"
    ],
    [
      "Amazon S3 Signature Version 2",
      "https://bucket.s3.amazonaws.com/object?AWSAccessKeyId=AKIA&Expires=1800000000&Signature=abc"
    ],
    [
      "Google Cloud Storage V2 signing",
      "https://storage.googleapis.com/bucket/object?GoogleAccessId=account%40example.com&Expires=1800000000&Signature=abc"
    ],
    [
      "Azure Storage shared access signature",
      "https://account.blob.core.windows.net/container/object?sv=2024-11-04&se=2026-08-27&sp=r&sr=b&sig=abc"
    ],
    [
      "Azure Storage shared access signature",
      "https://account.blob.core.windows.net/container/object?se=2026-08-27&sig=legacy"
    ],
    [
      "Cloudinary delivery URL signing",
      "https://media.example.com/image/authenticated/s--93M3Q7uh--/c_fill/sample.png"
    ],
    [
      "Cloudinary delivery URL signing",
      "https://media.example.com/image/authenticated/%73--93M3Q7uh--/c_fill/sample.png"
    ],
    [
      "Google Maps Platform URL signing",
      "https://maps.googleapis.com/maps/api/staticmap?center=Chicago&key=AIza-example&signature=abc_def"
    ],
    [
      "Google Maps Platform URL signing",
      "https://maps.googleapis.com/maps/api/streetview?location=Chicago&client=gme-example&signature=abc_def"
    ],
    [
      "Supabase Storage signed URL",
      "https://project.supabase.co/storage/v1/object/sign/private/report.pdf?token=ey.example.signature"
    ],
    [
      "Supabase Storage signed URL",
      "https://storage.example.com/storage/v1/render/image/sign/private/photo.jpg?width=200&token=ey.example.signature"
    ]
  ];

  for (const [scheme, input] of cases) {
    const result = canonicalize(input, { preset: "exact" });
    assert.deepEqual(result.warnings.map(warning => warning.code), ["signed-url-detected"], scheme);
    assert.match(result.warnings[0]!.detail, new RegExp(scheme), scheme);
    assert.equal(result.url, input, scheme);
    assert.deepEqual(result.changes, [], scheme);
  }
});

test("generic parameter names and known shortener hosts do not trigger preflight", () => {
  const cases = [
    "https://example.com/?expires=tomorrow",
    "https://example.com/?sig=abc",
    "https://example.com/?signature=abc&expires=1800000000",
    "https://example.com/?X-Amz-Signature=abc",
    "https://example.com/?sig=abc&sv=2024-11-04",
    "https://example.com/file?token=abc&expires=1800000000",
    "https://example.com/s--not-eight--/file.jpg",
    "https://maps.googleapis.com/maps/api/staticmap?center=Chicago&signature=abc",
    "https://maps.googleapis.com/maps/api/directions?key=AIza-example&signature=abc",
    "https://project.supabase.co/storage/v1/object/public/bucket/file?token=abc",
    "https://bit.ly/abc"
  ];

  for (const input of cases) {
    assert.deepEqual(canonicalize(input, { preset: "exact" }).warnings, [], input);
  }
});

test("Clean is the default and Exact remains explicit", () => {
  const result = canonicalize("https://example.com");
  assert.equal(result.requestedPreset, "clean");
  assert.equal(result.effectivePreset, "clean");
  assert.equal(result.url, "https://example.com/");

  const exact = canonicalize("https://example.com/?fbclid=abc", { preset: "exact" });
  assert.equal(exact.url, "https://example.com/?fbclid=abc");
  assert.equal(exact.effectivePreset, "exact");
  assert.deepEqual(exact.changes, []);
});

test("Clean strips the bundled conservative parameters without reserializing survivors", () => {
  const input =
    "https://example.com/path?keep=a%20b&FBCLID=one&bare&fb%63lid=two&plus=a+b#frag";
  const result = canonicalize(input, { preset: "clean" });

  assert.equal(result.browserUrl, input);
  assert.equal(result.url, "https://example.com/path?keep=a%20b&bare&plus=a+b#frag");
  assert.equal(result.effectivePreset, "clean");
  assert.deepEqual(
    result.changes.map(change => change.ruleId),
    ["firefox-query-stripping:fbclid", "firefox-query-stripping:fbclid"]
  );
  assert(result.changes.every(change =>
    change.stage === "strip-params" &&
    change.kind === "removeParam" &&
    change.savedChars > 0 &&
    Object.isFrozen(change)
  ));
  assert(Object.isFrozen(result.changes));

  let reversed: string = result.url;
  for (const change of [...result.changes].reverse()) {
    assert.equal(change.after, reversed);
    reversed = change.before;
  }
  assert.equal(reversed, result.browserUrl);

  const repeated = canonicalize(result.url, { preset: "clean" });
  assert.equal(repeated.url, result.url);
  assert.deepEqual(repeated.changes, []);
});

test("Clean preserves non-snapshot parameters and honors the Firefox base-domain exception", () => {
  const functional = "https://example.com/?utm_source=newsletter&ref=account&id=42";
  assert.equal(canonicalize(functional).url, functional);

  const allowed = "https://click.googleadservices.com/page?gclid=one&fbclid=two&keep=three";
  const result = canonicalize(allowed);
  assert.equal(result.url, allowed);
  assert.deepEqual(result.changes, []);

  const lookalike = canonicalize("https://notgoogleadservices.com/?gclid=one");
  assert.equal(lookalike.url, "https://notgoogleadservices.com/");
});

test("preflight hazards suppress Clean before optional transforms", () => {
  const credentials = canonicalize("https://alice:secret@example.com/?fbclid=abc");
  assert.equal(credentials.effectivePreset, "exact");
  assert.equal(credentials.url, credentials.browserUrl);
  assert.deepEqual(credentials.changes, []);
  assert.deepEqual(credentials.warnings.map(warning => warning.code), ["credentials-in-url"]);

  const signedInput =
    "https://cdn.example.com/file?X-Amz-Date=20260826T120000Z&X-Amz-Signature=abc&fbclid=tracking";
  const signed = canonicalize(signedInput);
  assert.equal(signed.effectivePreset, "exact");
  assert.equal(signed.url, signedInput);
  assert.deepEqual(signed.changes, []);
  assert.deepEqual(signed.warnings.map(warning => warning.code), ["signed-url-detected"]);
});

test("Aggressive composes stripping, index removal, and RFC percent normalization", () => {
  const input = "https://example.com/article/index.html?utm_source=x&keep=a%2fb#x%7ey";
  const result = canonicalize(input, { preset: "aggressive" });

  assert.equal(result.url, "https://example.com/article/?keep=a%2Fb#x~y");
  assert.equal(result.requestedPreset, "aggressive");
  assert.equal(result.effectivePreset, "aggressive");
  assert.deepEqual(result.changes.map(change => [change.stage, change.kind, change.ruleId]), [
    ["strip-params", "removeParam", "aggressive-query-stripping:campaign:utm"],
    ["rfc-normalize", "dropIndexFile", "aggressive:drop-index-file"],
    ["rfc-normalize", "normalize", "rfc3986:percent-encoding"]
  ]);
  assertReversibleLedger(result);

  const repeated = canonicalize(result.url, { preset: "aggressive" });
  assert.equal(repeated.url, result.url);
  assert.deepEqual(repeated.changes, []);
});

test("Aggressive statically unwraps only allowlisted wrappers, recursively", () => {
  const input =
    "https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.youtube.com%2Fredirect%3Fq%3Dhttps%253A%252F%252Fexample.com%252Fx%253Ffbclid%253Done%2526keep%253Dtwo";
  const result = canonicalize(input, { preset: "aggressive" });

  assert.equal(result.url, "https://example.com/x?keep=two");
  assert.deepEqual(result.changes.map(change => change.ruleId), [
    "unwrap:facebook",
    "unwrap:youtube",
    "firefox-query-stripping:fbclid"
  ]);
  assertReversibleLedger(result);

  const lookalike = "https://youtube.com.example/redirect?q=https%3A%2F%2Fevil.example%2F";
  assert.equal(canonicalize(lookalike, { preset: "aggressive" }).url, lookalike);
});

test("Aggressive rewrites narrow Amazon product paths without touching Clean", () => {
  const input =
    "https://www.amazon.com/Very-Nice-Thing/dp/B012345678/ref=something?utm_campaign=x&th=1";
  const aggressive = canonicalize(input, { preset: "aggressive" });
  assert.equal(aggressive.url, "https://www.amazon.com/dp/B012345678?th=1");
  assert.deepEqual(aggressive.changes.map(change => change.ruleId), [
    "site:amazon-product",
    "aggressive-query-stripping:campaign:utm"
  ]);
  assert.equal(canonicalize(input, { preset: "clean" }).url, input);

  const lookalike = "https://www.amazon.com.evil.example/Thing/dp/B012345678";
  assert.equal(canonicalize(lookalike, { preset: "aggressive" }).url, lookalike);
});

test("Aggressive preserves path dot-segment parse stability during RFC normalization", () => {
  const result = canonicalize(
    "https://example.com/a/%2e%2efoo/%7euser?q=%41%2f%bB",
    { preset: "aggressive" }
  );
  assert.equal(result.url, "https://example.com/a/..foo/~user?q=A%2F%BB");
  assert.equal(new URL(result.url).href, result.url);
  assert.equal(canonicalize(result.url, { preset: "aggressive" }).url, result.url);
});

test("Aggressive falls back to Exact for nested hazards and excessive unwrap depth", () => {
  const signedTarget =
    "https://cdn.example.com/file?X-Amz-Date=20260826T120000Z&X-Amz-Signature=abc";
  const signedWrapper = `https://www.youtube.com/redirect?q=${encodeURIComponent(signedTarget)}`;
  const signed = canonicalize(signedWrapper, { preset: "aggressive" });
  assert.equal(signed.url, signed.browserUrl);
  assert.equal(signed.effectivePreset, "exact");
  assert.deepEqual(signed.changes, []);
  assert.deepEqual(signed.warnings.map(warning => warning.code), ["signed-url-detected"]);

  let nested = "https://example.com/final";
  for (let index = 0; index < 4; index += 1) {
    nested = `https://www.youtube.com/redirect?q=${encodeURIComponent(nested)}`;
  }
  const tooDeep = canonicalize(nested, { preset: "aggressive" });
  assert.equal(tooDeep.url, tooDeep.browserUrl);
  assert.equal(tooDeep.effectivePreset, "exact");
  assert.deepEqual(tooDeep.changes, []);
  assert.deepEqual(tooDeep.warnings.map(warning => warning.code), ["unwrap-depth-exceeded"]);
});

test("Aggressive reports malformed static wrappers instead of guessing", () => {
  const input = "https://www.google.com/url?q=not-a-url&keep=a%2fb";
  const result = canonicalize(input, { preset: "aggressive" });
  assert.equal(result.url, "https://www.google.com/url?q=not-a-url&keep=a%2Fb");
  assert.equal(result.effectivePreset, "aggressive");
  assert.deepEqual(result.warnings.map(warning => warning.code), ["rule-failed"]);
  assert(Object.isFrozen(result.warnings));
  assert(result.warnings.every(Object.isFrozen));
});

test("preflight hazards suppress Aggressive before any optional transform", () => {
  const input = "https://alice:secret@example.com/index.html?utm_source=x&fbclid=y";
  const result = canonicalize(input, { preset: "aggressive" });
  assert.equal(result.url, result.browserUrl);
  assert.equal(result.effectivePreset, "exact");
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.warnings.map(warning => warning.code), ["credentials-in-url"]);
});

test("the bundled conservative rule snapshot has a reviewable golden surface", () => {
  assert.deepEqual(firefoxQueryStrippingSnapshot.allowBaseDomains, ["googleadservices.com"]);
  assert.deepEqual(firefoxQueryStrippingSnapshot.stripParameters, [
    "gclid",
    "dclid",
    "msclkid",
    "_openstat",
    "yclid",
    "wickedid",
    "twclid",
    "_hsenc",
    "__hssc",
    "__hstc",
    "__hsfp",
    "hsctatracking",
    "wbraid",
    "gbraid",
    "ysclid",
    "mc_eid",
    "oly_anon_id",
    "oly_enc_id",
    "__s",
    "vero_id",
    "mkt_tok",
    "fbclid"
  ]);
  assert(Object.isFrozen(firefoxQueryStrippingSnapshot));
  assert(Object.isFrozen(firefoxQueryStrippingSnapshot.stripParameters));
  assert(Object.isFrozen(firefoxQueryStrippingSnapshot.allowBaseDomains));
});

test("the bundled aggressive policy has a reviewable golden surface", () => {
  assert.equal(aggressivePolicy.provenance.reviewedAt, "2026-08-26");
  assert.deepEqual(aggressivePolicy.redirectRules.map(rule => rule.id), [
    "unwrap:google",
    "unwrap:googleadservices",
    "unwrap:youtube",
    "unwrap:facebook",
    "unwrap:reddit",
    "unwrap:steam",
    "unwrap:microsoft-safelinks"
  ]);
  assert.deepEqual(aggressivePolicy.indexFiles, [
    "index.html", "index.htm", "index.php",
    "default.html", "default.htm", "default.asp", "default.aspx"
  ]);
  assert(Object.isFrozen(aggressivePolicy));
  assert(Object.isFrozen(aggressivePolicy.provenance));
  assert(Object.isFrozen(aggressivePolicy.provenance.references));
  assert(Object.isFrozen(aggressivePolicy.stripParameterRules));
  assert(aggressivePolicy.stripParameterRules.every(Object.isFrozen));
  assert(Object.isFrozen(aggressivePolicy.redirectRules));
  assert(aggressivePolicy.redirectRules.every(Object.isFrozen));
});

test("every adversarial URL is stable under every canonicalization preset", async () => {
  const records = await loadAdversarialCases();
  for (const preset of ["exact", "clean", "aggressive"] satisfies CanonicalizationPreset[]) {
    for (const record of records) {
      const result = canonicalize(record.url, { preset });
      assert.equal(new URL(result.url).href, result.url, `${preset} parse stability: ${record.name}`);
      assert(
        [...result.url].every(character => codecAlphabet.has(character)),
        `${preset} codec alphabet: ${record.name}`
      );
      assert.equal(
        canonicalize(result.url, { preset }).url,
        result.url,
        `${preset} idempotence: ${record.name}`
      );
      assertReversibleLedger(result);
    }
  }
});

test("canonicalizer rejects anything outside absolute HTTP(S)", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["/relative", "invalid-url"],
    ["not a URL", "invalid-url"],
    ["javascript:alert(1)", "unsupported-protocol"],
    ["file:///tmp/example", "unsupported-protocol"]
  ];

  for (const [input, code] of cases) {
    assert.throws(
      () => canonicalize(input, { preset: "exact" }),
      error => error instanceof CanonicalizationError && error.code === code,
      input
    );
  }
  assert.throws(
    () => canonicalize("https://example.com", {
      preset: "unknown" as CanonicalizationPreset
    }),
    error => error instanceof CanonicalizationError && error.code === "unsupported-preset"
  );
  assert.throws(
    () => canonicalize(42 as unknown as string),
    error => error instanceof CanonicalizationError && error.code === "invalid-input"
  );
});
