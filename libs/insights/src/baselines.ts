import { InsightsConfig } from './config';
import { greatShots } from './great';
import {
  Certification,
  CertificationStatus,
  ChangepointResult,
  ChangepointVerdict,
  DispersionBaseline,
  InsightMetricKey,
  InsightShot,
  MetricStat,
  ReferenceBaseline,
  UnfilteredBucket,
} from './types';
import {
  cusumAlarm,
  ewmaWeight,
  iqr,
  mean,
  median,
  metricSeries,
  metricValue,
  sampleSd,
  weightedMean,
} from './stats';

/**
 * Baselines, certification, and changepoint detection (BUILD_SPEC §6.3/§6.4).
 *
 * Two baselines with opposite population rules:
 * - ReferenceBaseline: "what great looks like" — GREAT shots only.
 * - DispersionBaseline: "how scattered am I" — EVERY shot in the bucket.
 *   The UnfilteredBucket brand guarantees the input was never quality-
 *   filtered, and nothing here re-filters it (the cardinal-sin guard).
 *
 * `untagged` buckets are quarantine: baselines return null, certify returns
 * a neutral uncertified result, detectChangepoint returns the all-false
 * result.
 */

/** Runtime list of every metric key. The mapped type makes omitting a key a
    compile error, so this stays in lockstep with InsightMetricKey. */
const METRIC_KEY_RECORD: { [K in InsightMetricKey]: K } = {
  smash: 'smash',
  ballSpeedMs: 'ballSpeedMs',
  clubSpeedMs: 'clubSpeedMs',
  launchDeg: 'launchDeg',
  launchDirDeg: 'launchDirDeg',
  backspinRpm: 'backspinRpm',
  sidespinRpm: 'sidespinRpm',
  carryM: 'carryM',
  offlineM: 'offlineM',
  curveM: 'curveM',
  apexM: 'apexM',
  strikeHMm: 'strikeHMm',
  strikeVMm: 'strikeVMm',
  wristExtTop: 'wristExtTop',
  wristExtImpact: 'wristExtImpact',
  wristExtPeakDown: 'wristExtPeakDown',
};
const METRIC_KEYS: readonly InsightMetricKey[] = Object.values(METRIC_KEY_RECORD);

/** Weighted population sd: sqrt(Σw(x−x̄w)² / Σw) with weighted mean x̄w. */
function weightedSd(
  values: readonly number[],
  weights: readonly number[],
): number {
  const m = weightedMean(values, weights);
  let sw = 0;
  let acc = 0;
  for (let k = 0; k < values.length; k += 1) {
    sw += weights[k];
    acc += weights[k] * (values[k] - m) ** 2;
  }
  return sw === 0 ? 0 : Math.sqrt(acc / sw);
}

/** sessionId → EWMA age: distinct sessions ordered by max shot ts,
    age 0 = most recent session. */
function sessionAges(shots: readonly InsightShot[]): Map<string, number> {
  const maxTs = new Map<string, number>();
  for (const s of shots) {
    const prev = maxTs.get(s.sessionId);
    if (prev === undefined || s.ts > prev) maxTs.set(s.sessionId, s.ts);
  }
  const ordered = [...maxTs.entries()].sort((a, b) => b[1] - a[1]);
  const ages = new Map<string, number>();
  ordered.forEach(([sessionId], index) => ages.set(sessionId, index));
  return ages;
}

/** Non-null carries ordered by shot ts ascending. */
function carryStream(shots: readonly InsightShot[]): number[] {
  const ordered = [...shots].sort((a, b) => a.ts - b.ts);
  const carries: number[] = [];
  for (const s of ordered) {
    if (s.carryM !== null) carries.push(s.carryM);
  }
  return carries;
}

/**
 * Reference baseline over GREAT shots only (§6.3). Null for untagged
 * buckets (quarantine) and when the bucket has zero great shots. A metric
 * enters perMetric only with >= 3 non-null values among the great shots.
 */
export function computeReferenceBaseline(
  bucket: UnfilteredBucket,
  config: InsightsConfig,
): ReferenceBaseline | null {
  if (bucket.key.intent === 'untagged') return null;
  const great = greatShots(bucket, config);
  if (great.length === 0) return null;

  const perMetric: Partial<Record<InsightMetricKey, MetricStat>> = {};
  for (const key of METRIC_KEYS) {
    const values = metricSeries(great, key);
    if (values.length >= 3) {
      perMetric[key] = { n: values.length, median: median(values), iqr: iqr(values) };
    }
  }

  return { kind: 'reference', key: bucket.key, nGreat: great.length, perMetric };
}

/**
 * Dispersion baseline over EVERY shot in the bucket (§6.3) — the brand
 * guarantees the input is unfiltered and no quality filter is applied here.
 * Sigmas are EWMA-recency-weighted by session (weight = ewmaWeight(age,
 * halfLifeSessions)), so the same values in older sessions contribute less.
 * Null for untagged (quarantine) or empty buckets. A metric sigma needs
 * >= 3 non-null values; strikeScatterMm needs >= 5 strike locations.
 */
export function computeDispersionBaseline(
  bucket: UnfilteredBucket,
  config: InsightsConfig,
): DispersionBaseline | null {
  if (bucket.key.intent === 'untagged' || bucket.shots.length === 0) return null;

  const ages = sessionAges(bucket.shots);
  const halfLife = config.ewma.halfLifeSessions;
  const weightOf = (s: InsightShot): number =>
    ewmaWeight(ages.get(s.sessionId) ?? 0, halfLife);

  const perMetric: Partial<Record<InsightMetricKey, number>> = {};
  for (const key of METRIC_KEYS) {
    const values: number[] = [];
    const weights: number[] = [];
    for (const s of bucket.shots) {
      const v = metricValue(s, key);
      if (v !== null) {
        values.push(v);
        weights.push(weightOf(s));
      }
    }
    if (values.length >= 3) perMetric[key] = weightedSd(values, weights);
  }

  const strikeDists: number[] = [];
  const strikeWeights: number[] = [];
  for (const s of bucket.shots) {
    if (s.strikeHMm !== null && s.strikeVMm !== null) {
      strikeDists.push(Math.sqrt(s.strikeHMm ** 2 + s.strikeVMm ** 2));
      strikeWeights.push(weightOf(s));
    }
  }
  const strikeScatterMm =
    strikeDists.length >= 5 ? weightedSd(strikeDists, strikeWeights) : null;

  return {
    kind: 'dispersion',
    key: bucket.key,
    nTotal: bucket.shots.length,
    carrySigma: perMetric.carryM ?? null,
    offlineSigma: perMetric.offlineM ?? null,
    smashSigma: perMetric.smash ?? null,
    strikeScatterMm,
    perMetric,
  };
}

/**
 * Certification gate (§6.4).
 *
 * sigmaStable is testable only once nTotal >= minTotal + sigmaStabilityWindow
 * (null before). It compares plain (unweighted) sample sd of all carries vs
 * the carries excluding the LAST sigmaStabilityWindow of the ts-ordered
 * carry stream: relative change <= sigmaStabilityPct/100 = stable. When the
 * excluded-window sd is 0, stable iff the full-stream sd is also 0.
 *
 * status: 'certified' needs nGreat >= minGreat, nTotal >= minTotal, and
 * sigmaStable === true. 'contact-before-shapes' when nTotal >= sessionCap
 * with nGreat still under minGreat — volume without contact quality. Else
 * 'uncertified'. Untagged buckets are quarantined: neutral uncertified
 * result with null rate/stability.
 */
export function certify(
  bucket: UnfilteredBucket,
  config: InsightsConfig,
): Certification {
  const nTotal = bucket.shots.length;
  if (bucket.key.intent === 'untagged') {
    return {
      key: bucket.key,
      status: 'uncertified',
      nGreat: 0,
      nTotal,
      greatRate: null,
      sigmaStable: null,
    };
  }

  const nGreat = greatShots(bucket, config).length;
  const greatRate = nTotal === 0 ? null : nGreat / nTotal;
  const c = config.certification;

  let sigmaStable: boolean | null = null;
  if (nTotal >= c.minTotal + c.sigmaStabilityWindow) {
    const carries = carryStream(bucket.shots);
    const excluded = carries.slice(0, Math.max(0, carries.length - c.sigmaStabilityWindow));
    const sigmaAll = sampleSd(carries);
    const sigmaExcl = sampleSd(excluded);
    sigmaStable =
      sigmaExcl === 0
        ? sigmaAll === 0
        : Math.abs(sigmaAll - sigmaExcl) / sigmaExcl <= c.sigmaStabilityPct / 100;
  }

  const status: CertificationStatus =
    nGreat >= c.minGreat && nTotal >= c.minTotal && sigmaStable === true
      ? 'certified'
      : nTotal >= c.sessionCap && nGreat < c.minGreat
        ? 'contact-before-shapes'
        : 'uncertified';

  return { key: bucket.key, status, nGreat, nTotal, greatRate, sigmaStable };
}

/**
 * Changepoint detection on the ts-ordered non-null carry stream (§6.4).
 *
 * Baseline mu/sigma come from the FIRST half of the stream; the second half
 * is tested. centerShifted = CUSUM alarm on the second half against the
 * first-half baseline. dispersionSpiked = sd(second) > sd(first) ×
 * dispersionSpikeFactor. Verdict: a pure center shift with dispersion held
 * = 'new-swing' (a real change); a pure dispersion spike = 'bad-day'
 * (noise, not change); both or neither = null. Untagged buckets and streams
 * under minShots return the all-false result.
 */
export function detectChangepoint(
  bucket: UnfilteredBucket,
  config: InsightsConfig,
): ChangepointResult {
  const none: ChangepointResult = {
    key: bucket.key,
    verdict: null,
    centerShifted: false,
    dispersionSpiked: false,
  };
  if (bucket.key.intent === 'untagged') return none;

  const carries = carryStream(bucket.shots);
  if (carries.length < config.changepoint.minShots) return none;

  const half = Math.floor(carries.length / 2);
  const first = carries.slice(0, half);
  const second = carries.slice(half);

  const mu = mean(first);
  const sigma = sampleSd(first);
  const centerShifted =
    cusumAlarm(
      second,
      mu,
      sigma,
      config.changepoint.cusumThresholdSigma,
      config.changepoint.cusumDriftSigma,
    ) !== null;
  const dispersionSpiked =
    sampleSd(second) > sampleSd(first) * config.changepoint.dispersionSpikeFactor;

  let verdict: ChangepointVerdict = null;
  if (centerShifted && !dispersionSpiked) verdict = 'new-swing';
  else if (dispersionSpiked && !centerShifted) verdict = 'bad-day';

  return { key: bucket.key, verdict, centerShifted, dispersionSpiked };
}
