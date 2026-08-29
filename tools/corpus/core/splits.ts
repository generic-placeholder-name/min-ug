import { sha256Text } from "../../lib/files.js";
import {
  CorpusSplit,
  corpusSplitNames,
  type CorpusSplitName,
  type SplitCounts
} from "./types.js";

export interface SplitRecord {
  readonly url: string;
  split?: CorpusSplit;
}

export interface SplitOptions {
  readonly seed: string;
  readonly validationFraction: number;
  readonly testFraction: number;
}

export function emptySplitCounts (): SplitCounts {
  return {
    train: 0,
    seenHostValidation: 0,
    seenHostTest: 0,
    unseenHostValidation: 0,
    unseenHostTest: 0
  };
}

export function splitName (split: CorpusSplit): CorpusSplitName {
  const name = corpusSplitNames[split];
  if (name === undefined) throw new Error(`Unknown corpus split ${split}`);
  return name;
}

export function partitionScore (seed: string, kind: string, value: string): number {
  const prefix = sha256Text(`${seed}\0${kind}\0${value}`).slice(0, 13);
  return Number.parseInt(prefix, 16) / 0xfffffffffffff;
}

function threeWayAssignment (score: number, options: SplitOptions): 0 | 1 | 2 {
  const trainingBoundary = 1 - options.validationFraction - options.testFraction;
  if (score < trainingBoundary) return 0;
  if (score < trainingBoundary + options.validationFraction) return 1;
  return 2;
}

function validateOptions (options: SplitOptions): void {
  if (
    options.validationFraction <= 0 ||
    options.testFraction <= 0 ||
    options.validationFraction + options.testFraction >= 1
  ) throw new Error("Validation and test fractions must be positive and sum to less than one");
}

export function assignHostSplits (
  hostname: string,
  records: readonly SplitRecord[],
  options: SplitOptions
): void {
  validateOptions(options);
  const hostAssignment = threeWayAssignment(
    partitionScore(options.seed, "host", hostname),
    options
  );
  if (hostAssignment === 1) {
    for (const record of records) record.split = CorpusSplit.UnseenHostValidation;
    return;
  }
  if (hostAssignment === 2) {
    for (const record of records) record.split = CorpusSplit.UnseenHostTest;
    return;
  }

  for (const record of records) {
    const assignment = threeWayAssignment(
      partitionScore(options.seed, "url", record.url),
      options
    );
    record.split = assignment === 0
      ? CorpusSplit.Train
      : assignment === 1
        ? CorpusSplit.SeenHostValidation
        : CorpusSplit.SeenHostTest;
  }
  if (records.length > 0 && !records.some(record => record.split === CorpusSplit.Train)) {
    const selected = [...records].sort((left, right) =>
      partitionScore(options.seed, "repair", left.url) -
        partitionScore(options.seed, "repair", right.url) ||
      left.url.localeCompare(right.url)
    )[0]!;
    selected.split = CorpusSplit.Train;
  }
}

export function incrementSplitCount (counts: SplitCounts, split: CorpusSplit): void {
  counts[splitName(split)] += 1;
}

export function isCorpusSplit (value: number): value is CorpusSplit {
  return Number.isInteger(value) && value >= CorpusSplit.Train && value <= CorpusSplit.UnseenHostTest;
}
