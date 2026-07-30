import { InsightsConfig } from './config';
import { median, sampleSd, metricSeries } from './stats';
import { DispersionIndex, UnfilteredBucket } from './types';

/**
 * Windowed dispersion index (BUILD_SPEC §6.8).
 *
 * This is a rollup over an entire (club, intent) window — it is NEVER a
 * per-swing number, and it is computed strictly from the UnfilteredBucket
 * (dispersion is never re-filtered by shot quality; that is the cardinal
 * sin this module must not commit).
 *
 * Components (each null when its underlying data is absent):
 *   - carrySigmaPct:  sampleSd(carryM) / median(carryM) * 100
 *   - offlineSigmaM:  sampleSd(offlineM)
 *   - smashSigma:     sampleSd(smash)
 *   - strikeScatterMm: sampleSd(sqrt(h² + v²)) over shots with both strike
 *                       coordinates present, only when there are at least 5
 *                       such strikes — otherwise null (too few to trust).
 *
 * `value` is the weighted mean of whichever components are available,
 * using config.dispersionIndex.weights renormalized over the available
 * subset (a bucket missing strike data still gets a value from the other
 * three, reweighted to sum to 1). The components intentionally mix units
 * (%, m, dimensionless smash, mm) — this is a composite score tuned via its
 * weights, not a physical quantity.
 *
 * `value` is null whenever the bucket has fewer than
 * config.dispersionIndex.minShots shots, or when no component is available
 * to average. `untagged` is quarantine — returns nulls without inspecting
 * shots.
 */

export function computeDispersionIndex(
  bucket: UnfilteredBucket,
  config: InsightsConfig,
): DispersionIndex {
  const emptyComponents = {
    carrySigmaPct: null,
    offlineSigmaM: null,
    smashSigma: null,
    strikeScatterMm: null,
  };

  if (bucket.key.intent === 'untagged') {
    return { key: bucket.key, n: 0, value: null, components: emptyComponents };
  }

  const n = bucket.shots.length;

  const carrySeries = metricSeries(bucket.shots, 'carryM');
  const carryMedian = carrySeries.length > 0 ? median(carrySeries) : null;
  const carrySigmaPct =
    carryMedian !== null && carryMedian !== 0
      ? (sampleSd(carrySeries) / carryMedian) * 100
      : null;

  const offlineSeries = metricSeries(bucket.shots, 'offlineM');
  const offlineSigmaM = offlineSeries.length > 0 ? sampleSd(offlineSeries) : null;

  const smashSeries = metricSeries(bucket.shots, 'smash');
  const smashSigma = smashSeries.length > 0 ? sampleSd(smashSeries) : null;

  const strikeScatter: number[] = [];
  for (const shot of bucket.shots) {
    if (shot.strikeHMm !== null && shot.strikeVMm !== null) {
      strikeScatter.push(Math.sqrt(shot.strikeHMm ** 2 + shot.strikeVMm ** 2));
    }
  }
  const strikeScatterMm = strikeScatter.length >= 5 ? sampleSd(strikeScatter) : null;

  const components = { carrySigmaPct, offlineSigmaM, smashSigma, strikeScatterMm };

  if (n < config.dispersionIndex.minShots) {
    return { key: bucket.key, n, value: null, components };
  }

  const weights = config.dispersionIndex.weights;
  const weighted: Array<[number, number]> = [
    [carrySigmaPct, weights.carry],
    [offlineSigmaM, weights.offline],
    [smashSigma, weights.smash],
    [strikeScatterMm, weights.strike],
  ].filter((pair): pair is [number, number] => pair[0] !== null);

  const weightSum = weighted.reduce((acc, [, w]) => acc + w, 0);
  const value =
    weightSum === 0 ? null : weighted.reduce((acc, [v, w]) => acc + v * w, 0) / weightSum;

  return { key: bucket.key, n, value, components };
}
