import type {
  CanonicalizationChange,
  CanonicalizationChangeKind,
  CanonicalizationStage,
  CanonicalizationWarning,
  CanonicalizationWarningCode,
  CanonicalizationWarningSeverity
} from "./index.js";

export type CanonicalizationBehaviorContext = Readonly<Record<string, unknown>>;

/** A behavior must account for its complete URL mutation through an ordered change ledger. */
export interface CanonicalizationBehaviorApplication {
  readonly url: string;
  readonly changes?: readonly CanonicalizationChange[];
  readonly warnings?: readonly CanonicalizationWarning[];
  /** Requests rollback of this pipeline run and an Exact result. */
  readonly abort?: boolean;
}

/** Extension contract for optional canonicalization behavior. */
export interface CanonicalizationBehaviorDefinition {
  readonly id: string;
  readonly stage: CanonicalizationStage;
  readonly apply: (
    url: string,
    context: CanonicalizationBehaviorContext
  ) => CanonicalizationBehaviorApplication;
}

export interface CanonicalizationBehaviorResult {
  readonly url: string;
  readonly changes: readonly CanonicalizationChange[];
  readonly warnings: readonly CanonicalizationWarning[];
  readonly abort: boolean;
}

export type CanonicalizationPolicy = readonly CanonicalizationBehaviorDefinition[];

const emptyList: readonly never[] = Object.freeze([]);
const stageOrder = new Map<CanonicalizationStage, number>([
  ["unwrap", 0],
  ["site-rewrite", 1],
  ["strip-params", 2],
  ["rfc-normalize", 3]
]);
const changeKinds = new Set<CanonicalizationChangeKind>([
  "removeParam", "unwrap", "rewrite", "normalize", "dropIndexFile"
]);
const warningCodes = new Set<CanonicalizationWarningCode>([
  "credentials-in-url",
  "signed-url-detected",
  "unwrap-depth-exceeded",
  "rule-failed",
  "canonicalizer-unstable"
]);
const warningSeverities = new Set<CanonicalizationWarningSeverity>(["info", "warn", "block"]);

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isStage (value: unknown): value is CanonicalizationStage {
  return typeof value === "string" && stageOrder.has(value as CanonicalizationStage);
}

function isChangeKind (value: unknown): value is CanonicalizationChangeKind {
  return typeof value === "string" && changeKinds.has(value as CanonicalizationChangeKind);
}

function isWarningCode (value: unknown): value is CanonicalizationWarningCode {
  return typeof value === "string" && warningCodes.has(value as CanonicalizationWarningCode);
}

function isWarningSeverity (value: unknown): value is CanonicalizationWarningSeverity {
  return typeof value === "string" &&
    warningSeverities.has(value as CanonicalizationWarningSeverity);
}

function requireBehaviorShape (
  definition: unknown
): asserts definition is CanonicalizationBehaviorDefinition {
  if (!isRecord(definition)) {
    throw new TypeError("Canonicalization behavior must be an object");
  }
  if (typeof definition.id !== "string" || definition.id.length === 0) {
    throw new TypeError("Canonicalization behavior id must be a non-empty string");
  }
  if (!isStage(definition.stage)) {
    throw new TypeError(`Canonicalization behavior ${definition.id} has unknown stage ${definition.stage}`);
  }
  if (typeof definition.apply !== "function") {
    throw new TypeError(`Canonicalization behavior ${definition.id} must provide apply()`);
  }
}

/** Validates and freezes a behavior before registration. */
export function defineCanonicalizationBehavior (
  definition: CanonicalizationBehaviorDefinition
): CanonicalizationBehaviorDefinition {
  requireBehaviorShape(definition);
  return Object.freeze({
    id: definition.id,
    stage: definition.stage,
    apply: definition.apply
  });
}

function requirePolicyShape (behaviors: unknown): asserts behaviors is CanonicalizationPolicy {
  if (!Array.isArray(behaviors)) throw new TypeError("Behavior policy must be an array");

  let previousStage = -1;
  const behaviorIds = new Set();
  for (const behavior of behaviors as unknown[]) {
    requireBehaviorShape(behavior);
    const order = stageOrder.get(behavior.stage)!;
    if (order < previousStage) {
      throw new TypeError(`Canonicalization behavior ${behavior.id} is out of stage order`);
    }
    if (behaviorIds.has(behavior.id)) {
      throw new TypeError(`Duplicate canonicalization behavior id ${behavior.id}`);
    }
    previousStage = order;
    behaviorIds.add(behavior.id);
  }
}

/** Validates stage order and behavior identity, then freezes a preset policy. */
export function defineCanonicalizationPolicy (
  behaviors: readonly CanonicalizationBehaviorDefinition[]
): CanonicalizationPolicy {
  requirePolicyShape(behaviors);
  return Object.freeze([...behaviors]);
}

function behaviorFailure (
  initialUrl: string,
  warnings: readonly CanonicalizationWarning[],
  behavior: CanonicalizationBehaviorDefinition,
  reason: string
): CanonicalizationBehaviorResult {
  return Object.freeze({
    url: initialUrl,
    changes: emptyList,
    warnings: Object.freeze([
      ...warnings,
      Object.freeze({
        code: "rule-failed",
        severity: "warn",
        detail: `${behavior.id} violated the behavior contract (${reason}); returned Exact.`
      })
    ]),
    abort: true
  });
}

function normalizeWarnings (
  warnings: unknown,
  behavior: CanonicalizationBehaviorDefinition
): readonly CanonicalizationWarning[] {
  if (warnings === undefined) return emptyList;
  if (!Array.isArray(warnings)) throw new TypeError("warnings must be an array");
  return (warnings as unknown[]).map(warning => {
    if (
      !isRecord(warning) ||
      !isWarningCode(warning.code) ||
      !isWarningSeverity(warning.severity) ||
      typeof warning.detail !== "string"
    ) {
      throw new TypeError(`behavior ${behavior.id} returned an invalid warning`);
    }
    return Object.freeze({
      code: warning.code,
      severity: warning.severity,
      detail: warning.detail
    });
  });
}

function normalizeChanges (
  before: string,
  after: string,
  changes: unknown,
  behavior: CanonicalizationBehaviorDefinition
): readonly CanonicalizationChange[] {
  if (changes === undefined) changes = emptyList;
  if (!Array.isArray(changes)) throw new TypeError("changes must be an array");

  let cursor = before;
  const normalized: CanonicalizationChange[] = [];
  for (const change of changes as unknown[]) {
    if (
      !isRecord(change) ||
      typeof change.ruleId !== "string" ||
      change.ruleId.length === 0 ||
      !isStage(change.stage) ||
      change.stage !== behavior.stage ||
      !isChangeKind(change.kind) ||
      typeof change.before !== "string" ||
      change.before !== cursor ||
      typeof change.after !== "string" ||
      typeof change.savedChars !== "number" ||
      !Number.isSafeInteger(change.savedChars) ||
      change.savedChars !== Math.max(0, change.before.length - change.after.length)
    ) {
      throw new TypeError(`behavior ${behavior.id} returned an invalid change chain`);
    }
    cursor = change.after;
    normalized.push(Object.freeze({
      ruleId: change.ruleId,
      stage: change.stage,
      kind: change.kind,
      before: change.before,
      after: change.after,
      savedChars: change.savedChars
    }));
  }
  if (cursor !== after) {
    throw new TypeError(`behavior ${behavior.id} changed the URL without a complete ledger`);
  }
  return normalized;
}

export function runCanonicalizationBehaviors (
  initialUrl: string,
  behaviors: CanonicalizationPolicy,
  context: CanonicalizationBehaviorContext = {}
): CanonicalizationBehaviorResult {
  if (typeof initialUrl !== "string") throw new TypeError("Pipeline input must be a string");
  requirePolicyShape(behaviors);

  let current = initialUrl;
  const changes: CanonicalizationChange[] = [];
  const warnings: CanonicalizationWarning[] = [];
  const behaviorContext = Object.freeze({ ...context });
  for (const behavior of behaviors) {
    let application: unknown;
    try {
      application = behavior.apply(current, behaviorContext);
      if (!isRecord(application)) {
        throw new TypeError("apply() must return an object");
      }
      if (typeof application.url !== "string") {
        throw new TypeError("url must be a string");
      }
      if (application.abort !== undefined && typeof application.abort !== "boolean") {
        throw new TypeError("abort must be a boolean");
      }
      const applicationWarnings = normalizeWarnings(application.warnings, behavior);
      warnings.push(...applicationWarnings);
      if (application.abort === true) {
        return Object.freeze({
          url: initialUrl,
          changes: emptyList,
          warnings: warnings.length === 0 ? emptyList : Object.freeze(warnings),
          abort: true
        });
      }
      const applicationChanges = normalizeChanges(
        current,
        application.url,
        application.changes,
        behavior
      );
      changes.push(...applicationChanges);
      current = application.url;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return behaviorFailure(initialUrl, warnings, behavior, reason);
    }
  }

  return Object.freeze({
    url: current,
    changes: changes.length === 0 ? emptyList : Object.freeze(changes),
    warnings: warnings.length === 0 ? emptyList : Object.freeze(warnings),
    abort: false
  });
}
