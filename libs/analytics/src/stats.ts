import { MetricStat } from '@golf/types';

/** Arithmetic mean. Callers must pass a non-empty array. */
export const mean = (values: number[]): number => {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
};

/**
 * Median: middle value of the sorted list; the average of the two middle
 * values when the count is even. Callers must pass a non-empty array.
 */
export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * SAMPLE standard deviation (n − 1 denominator, Bessel's correction) — the
 * shots in a session are a sample of the golfer's swing, not the population.
 * Defined as 0 when n = 1: a single observation has no spread to report and
 * the n − 1 denominator would otherwise be undefined.
 */
export const sampleSd = (values: number[]): number => {
  if (values.length <= 1) return 0;
  const m = mean(values);
  let sumSq = 0;
  for (const v of values) sumSq += (v - m) * (v - m);
  return Math.sqrt(sumSq / (values.length - 1));
};

/**
 * Full MetricStat over the MEASURED values of one metric. `n` is the measured
 * count, which may be smaller than the shot count because of the null rule —
 * nulls are excluded upstream, never averaged in as 0. Returns null when no
 * shot measured the metric (the caller omits the key entirely).
 */
export const computeMetricStat = (values: number[]): MetricStat | null => {
  if (values.length === 0) return null;
  return {
    n: values.length,
    mean: mean(values),
    median: median(values),
    sd: sampleSd(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
};
