export interface NumericSummary {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export function percentile (values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function describe (values: readonly number[]): NumericSummary | null {
  if (values.length === 0) return null;
  let total = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of values) {
    total += value;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return {
    count: values.length,
    min: minimum,
    max: maximum,
    mean: total / values.length,
    median: percentile(values, 0.5)!,
    p50: percentile(values, 0.5)!,
    p95: percentile(values, 0.95)!,
    p99: percentile(values, 0.99)!
  };
}
