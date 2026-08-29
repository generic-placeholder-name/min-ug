import assert from "node:assert/strict";
import test from "node:test";

import {
  defineCanonicalizationBehavior,
  defineCanonicalizationPolicy,
  runCanonicalizationBehaviors
} from "../src/canonicalize/behavior-pipeline.js";
import type { CanonicalizationBehaviorDefinition } from
  "../src/canonicalize/behavior-pipeline.js";
import type {
  CanonicalizationChange,
  CanonicalizationChangeKind,
  CanonicalizationStage
} from "../src/canonicalize/index.js";

function change (
  ruleId: string,
  stage: CanonicalizationStage,
  kind: CanonicalizationChangeKind,
  before: string,
  after: string
): CanonicalizationChange {
  return {
    ruleId,
    stage,
    kind,
    before,
    after,
    savedChars: Math.max(0, before.length - after.length)
  };
}

test("preset policies are separate compositions over one behavior interface", () => {
  const shared = defineCanonicalizationBehavior({
    id: "shared",
    stage: "strip-params",
    apply (url) {
      const after = `${url}/shared`;
      return {
        url: after,
        changes: [change("shared", "strip-params", "rewrite", url, after)]
      };
    }
  });
  const aggressiveOnly = defineCanonicalizationBehavior({
    id: "aggressive-only",
    stage: "rfc-normalize",
    apply (url) {
      const after = `${url}/extra`;
      return {
        url: after,
        changes: [change("aggressive-only", "rfc-normalize", "normalize", url, after)]
      };
    }
  });
  const exactPolicy = defineCanonicalizationPolicy([]);
  const cleanPolicy = defineCanonicalizationPolicy([shared]);
  const aggressivePolicy = defineCanonicalizationPolicy([shared, aggressiveOnly]);

  const exact = runCanonicalizationBehaviors("start", exactPolicy);
  assert.equal(exact.url, "start");
  assert.deepEqual(exact.changes, []);

  const clean = runCanonicalizationBehaviors("start", cleanPolicy);
  assert.equal(clean.url, "start/shared");
  assert.deepEqual(clean.changes.map(item => item.ruleId), ["shared"]);

  const aggressive = runCanonicalizationBehaviors("start", aggressivePolicy);
  assert.equal(aggressive.url, "start/shared/extra");
  assert.deepEqual(
    aggressive.changes.map(item => item.ruleId),
    ["shared", "aggressive-only"]
  );
  assert(Object.isFrozen(shared));
  assert.equal(Object.hasOwn(shared, "presets"), false);
  assert(Object.isFrozen(cleanPolicy));
  assert(Object.isFrozen(aggressive));
  assert(Object.isFrozen(aggressive.changes));
  assert(aggressive.changes.every(Object.isFrozen));
});

test("behavior pipeline rolls back earlier changes when a later behavior aborts", () => {
  const first = defineCanonicalizationBehavior({
    id: "first",
    stage: "unwrap",
    apply (url) {
      return {
        url: "intermediate",
        changes: [change("first", "unwrap", "unwrap", url, "intermediate")]
      };
    }
  });
  const second = defineCanonicalizationBehavior({
    id: "second",
    stage: "site-rewrite",
    apply (url) {
      return {
        url,
        warnings: [{ code: "signed-url-detected", severity: "warn", detail: "hazard" }],
        abort: true
      };
    }
  });

  const result = runCanonicalizationBehaviors("original", [first, second]);
  assert.equal(result.url, "original");
  assert.equal(result.abort, true);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.warnings.map(warning => warning.code), ["signed-url-detected"]);
});

test("behavior pipeline converts thrown or malformed behavior into a safe rollback", () => {
  const thrown = defineCanonicalizationBehavior({
    id: "throws",
    stage: "strip-params",
    apply () {
      throw new Error("boom");
    }
  });
  const thrownResult = runCanonicalizationBehaviors("original", [thrown]);
  assert.equal(thrownResult.url, "original");
  assert.equal(thrownResult.abort, true);
  assert.deepEqual(thrownResult.warnings.map(warning => warning.code), ["rule-failed"]);

  const malformed = defineCanonicalizationBehavior({
    id: "malformed",
    stage: "strip-params",
    apply () {
      return { url: "changed", changes: [] };
    }
  });
  const malformedResult = runCanonicalizationBehaviors("original", [malformed]);
  assert.equal(malformedResult.url, "original");
  assert.equal(malformedResult.abort, true);
  assert.deepEqual(malformedResult.changes, []);
  assert.match(malformedResult.warnings[0]!.detail, /complete ledger/u);
});

test("behavior definitions and policies reject ambiguous contracts", () => {
  assert.throws(
    () => defineCanonicalizationBehavior({
      id: "missing-apply",
      stage: "strip-params"
    } as unknown as CanonicalizationBehaviorDefinition),
    /must provide apply/u
  );

  const later = defineCanonicalizationBehavior({
    id: "later",
    stage: "rfc-normalize",
    apply: url => ({ url })
  });
  const earlier = defineCanonicalizationBehavior({
    id: "earlier",
    stage: "unwrap",
    apply: url => ({ url })
  });
  assert.throws(
    () => defineCanonicalizationPolicy([later, earlier]),
    /out of stage order/u
  );
  assert.throws(
    () => defineCanonicalizationPolicy([earlier, earlier]),
    /Duplicate canonicalization behavior id/u
  );
});
