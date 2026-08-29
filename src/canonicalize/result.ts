import type {
  CanonicalizationChange,
  CanonicalizationChangeKind,
  CanonicalizationStage,
  CanonicalizationWarning,
  CanonicalizationWarningCode,
  CanonicalizationWarningSeverity
} from "./index.js";

export const emptyList: readonly never[] = Object.freeze([]);

export function makeWarning (
  code: CanonicalizationWarningCode,
  severity: CanonicalizationWarningSeverity,
  detail: string
): CanonicalizationWarning {
  return Object.freeze({ code, severity, detail });
}

export function makeChange (
  ruleId: string,
  stage: CanonicalizationStage,
  kind: CanonicalizationChangeKind,
  before: string,
  after: string
): CanonicalizationChange {
  return Object.freeze({
    ruleId,
    stage,
    kind,
    before,
    after,
    savedChars: Math.max(0, before.length - after.length)
  });
}
