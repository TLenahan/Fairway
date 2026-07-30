import { InsightsConfig } from './config';
import { mean, median, pearson, sampleSd, metricSeries, metricValue } from './stats';
import { BiasVarianceEntry, InsightMetricKey, UnfilteredBucket } from './types';

/**
 * Bias-vs-variance classification (BUILD_SPEC §6.6).
 *
 * For a (club, intent) bucket, splits metrics into two disjoint classes and
 * classifies each independently — a metric is NEVER eligible for both paths:
 *
 * - OUTCOME metrics (launchDirDeg, offlineM, curveM) are "bias" candidates:
 *   a systematic non-zero offset relative to their own spread. `|mean| / sd`
 *   at or above `config.biasVariance.biasOffsetSigma` (with n >= minShots)
 *   classifies as 'bias', reporting the signed mean offset and the sd used
 *   as the denominator.
 * - DELIVERY metrics (smash, clubSpeedMs, launchDeg, backspinRpm, and the
 *   three wrist-extension metrics) are "variance-driver" candidates: does
 *   this metric's spread explain offlineM's spread? Correlate
 *   |metric − metric median| against |offlineM − offline median| over shots
 *   where both are present; `|pearson| >= minOutcomeCorrelation` (n >=
 *   minShots) classifies as 'variance-driver', reporting that |r| and the
 *   metric's own sd (over the paired shots).
 * - Anything that doesn't clear its path's bar is 'neutral', with all
 *   diagnostic fields null.
 *
 * `untagged` is quarantine (§ philosophy) — always returns [].
 */

const OUTCOME_METRICS: readonly InsightMetricKey[] = [
  'launchDirDeg',
  'offlineM',
  'curveM',
];

const DELIVERY_METRICS: readonly InsightMetricKey[] = [
  'smash',
  'clubSpeedMs',
  'launchDeg',
  'backspinRpm',
  'wristExtTop',
  'wristExtImpact',
  'wristExtPeakDown',
];

const NEUTRAL = (metric: InsightMetricKey): BiasVarianceEntry => ({
  metric,
  classification: 'neutral',
  meanOffset: null,
  sigma: null,
  outcomeCorrelation: null,
});

const classifyBias = (
  metric: InsightMetricKey,
  bucket: UnfilteredBucket,
  config: InsightsConfig,
): BiasVarianceEntry => {
  const series = metricSeries(bucket.shots, metric);
  if (series.length < config.biasVariance.minShots) return NEUTRAL(metric);

  const m = mean(series);
  const sd = sampleSd(series);
  // sd === 0 with a non-zero mean is every shot landing on the same
  // non-zero offset — the maximal-confidence bias case. Guard the
  // division instead of letting it produce Infinity/NaN.
  const ratio = sd === 0 ? (m === 0 ? 0 : Infinity) : Math.abs(m) / sd;
  if (ratio >= config.biasVariance.biasOffsetSigma) {
    return { metric, classification: 'bias', meanOffset: m, sigma: sd, outcomeCorrelation: null };
  }
  return NEUTRAL(metric);
};

const classifyVarianceDriver = (
  metric: InsightMetricKey,
  bucket: UnfilteredBucket,
  config: InsightsConfig,
): BiasVarianceEntry => {
  const metricVals: number[] = [];
  const offlineVals: number[] = [];
  for (const shot of bucket.shots) {
    const mv = metricValue(shot, metric);
    const ov = shot.offlineM;
    if (mv !== null && ov !== null) {
      metricVals.push(mv);
      offlineVals.push(ov);
    }
  }
  if (metricVals.length < config.biasVariance.minShots) return NEUTRAL(metric);

  const metricMedian = median(metricVals);
  const offlineMedian = median(offlineVals);
  const absMetric = metricVals.map((v) => Math.abs(v - metricMedian));
  const absOffline = offlineVals.map((v) => Math.abs(v - offlineMedian));
  const r = pearson(absMetric, absOffline);
  if (Math.abs(r) >= config.biasVariance.minOutcomeCorrelation) {
    return {
      metric,
      classification: 'variance-driver',
      meanOffset: null,
      sigma: sampleSd(metricVals),
      outcomeCorrelation: Math.abs(r),
    };
  }
  return NEUTRAL(metric);
};

export function classifyBiasVariance(
  bucket: UnfilteredBucket,
  config: InsightsConfig,
): BiasVarianceEntry[] {
  if (bucket.key.intent === 'untagged') return [];

  const entries: BiasVarianceEntry[] = [];
  for (const metric of OUTCOME_METRICS) entries.push(classifyBias(metric, bucket, config));
  for (const metric of DELIVERY_METRICS) entries.push(classifyVarianceDriver(metric, bucket, config));
  return entries;
}
