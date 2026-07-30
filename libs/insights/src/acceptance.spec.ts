import { computeDispersionBaseline } from './baselines';
import { DEFAULT_INSIGHTS_CONFIG } from './config';
import { detectFindings } from './findings';
import { sampleSd } from './stats';
import { generateSyntheticShots, SyntheticBucketSpec } from './synthetic';
import { collectBucket, InsightMetricKey } from './types';

/**
 * Phase 4 acceptance gate (BUILD_SPEC §3 Phase 4 / §8.4).
 *
 * The engine passes when: a planted failure is surfaced on exactly the
 * planted mechanism (plus mechanically entailed metrics), a clean run
 * surfaces nothing, and dispersion honesty holds — the baseline σ tracks
 * the generator σ and planted outliers CANNOT be excluded from it.
 *
 * Type-level honesty note: dispersion functions accept only the
 * UnfilteredBucket brand, whose sole constructor (`collectBucket`) filters
 * on bucket membership, warmup, and discarded — never quality. There is no
 * public API through which a caller could hand dispersion math a
 * quality-filtered shot list; the runtime test below demonstrates the same
 * property by construction (planted outliers widen σ).
 */

const config = DEFAULT_INSIGHTS_CONFIG;

/** ~500-shot iron/stock bucket. carrySdM is deliberately tight relative to
    the short/long carryFraction (8% of 150 m = 12 m ≈ 2.7σ) so carry-tail
    failure buckets stay below minBadBucket and the clean run is silent. */
const PLANTED_SPEC: SyntheticBucketSpec = {
  clubId: 'i7',
  clubCategory: 'iron',
  intent: 'stock',
  sessions: 5,
  shotsPerSession: 100,
  carryMeanM: 150,
  carrySdM: 4.5,
  smashMean: 1.35,
  smashSd: 0.02,
  offlineSdM: 6,
  seed: 20260730,
  planted: {
    failureFraction: 0.15,
    failureMode: 'low-smash',
    affectedMetric: 'wristExtPeakDown',
    shiftSigma: 1.5,
  },
};

const CLEAN_SPEC: SyntheticBucketSpec = { ...PLANTED_SPEC, planted: undefined };

describe('acceptance: planted failure detection', () => {
  const shots = generateSyntheticShots(PLANTED_SPEC);
  const findings = detectFindings(shots, config);

  it('surfaces a (low-smash, wristExtPeakDown) finding', () => {
    const hit = findings.find(
      (f) => f.failureMode === 'low-smash' && f.metric === 'wristExtPeakDown',
    );
    expect(hit).toBeDefined();
    if (hit === undefined) return;
    // Plant shifted the metric UP by +1.5σ on bad shots.
    expect(hit.direction).toBe('higher');
    expect(hit.effectSize).toBeGreaterThanOrEqual(config.findings.minEffectSize);
    expect(hit.pApprox).toBeLessThan(config.findings.maxPApprox);
    expect(hit.sessionsSeen).toBeGreaterThanOrEqual(config.findings.minSessions);
    expect(hit.counts.bad).toBeGreaterThanOrEqual(config.findings.minBadBucket);
    expect(hit.key).toEqual({ clubId: 'i7', intent: 'stock' });
  });

  it('surfaces NO finding on uninvolved metrics', () => {
    const uninvolved: readonly InsightMetricKey[] = [
      'launchDeg',
      'launchDirDeg',
      'backspinRpm',
      'sidespinRpm',
      'offlineM',
      'curveM',
      'apexM',
      'wristExtTop',
      'wristExtImpact',
    ];
    for (const f of findings) {
      expect(uninvolved).not.toContain(f.metric);
    }
  });

  it('every surfaced metric is the plant or mechanically entailed by it', () => {
    // low-smash plant: smash forced down, ballSpeed = clubSpeed × smash
    // drops with it; wristExtPeakDown is the planted mechanism.
    const involved: readonly InsightMetricKey[] = [
      'wristExtPeakDown',
      'smash',
      'ballSpeedMs',
    ];
    for (const f of findings) {
      expect(involved).toContain(f.metric);
    }
  });
});

describe('acceptance: negative control', () => {
  it('a clean run (same spec, no plant) surfaces zero findings', () => {
    const shots = generateSyntheticShots(CLEAN_SPEC);
    expect(detectFindings(shots, config)).toEqual([]);
  });
});

describe('acceptance: dispersion honesty', () => {
  const WIDE_SPEC: SyntheticBucketSpec = {
    clubId: 'dr',
    clubCategory: 'driver',
    intent: 'stock',
    sessions: 4,
    shotsPerSession: 60,
    carryMeanM: 230,
    carrySdM: 12,
    smashMean: 1.47,
    smashSd: 0.03,
    offlineSdM: 10,
    seed: 777,
  };
  const key = { clubId: 'dr', intent: 'stock' as const };

  it('baseline σ tracks the generator σ within ±20%', () => {
    const shots = generateSyntheticShots(WIDE_SPEC);
    const baseline = computeDispersionBaseline(collectBucket(shots, key), config);
    if (baseline === null) {
      throw new Error('expected a dispersion baseline for a 240-shot bucket');
    }
    const { carrySigma, offlineSigma } = baseline;
    if (carrySigma === null || offlineSigma === null) {
      throw new Error('expected carry and offline σ to be measurable');
    }
    expect(carrySigma).toBeGreaterThan(WIDE_SPEC.carrySdM * 0.8);
    expect(carrySigma).toBeLessThan(WIDE_SPEC.carrySdM * 1.2);
    expect(offlineSigma).toBeGreaterThan(WIDE_SPEC.offlineSdM * 0.8);
    expect(offlineSigma).toBeLessThan(WIDE_SPEC.offlineSdM * 1.2);
  });

  it('planted outliers are IN the baseline σ — never filtered by quality', () => {
    // Twin runs off the same seed: identical base draws, one adds a +4σ
    // carry shift to 12% of shots. If dispersion math saw only "good"
    // shots the two σ would match; honesty demands the planted σ balloons.
    const plantedShots = generateSyntheticShots({
      ...WIDE_SPEC,
      planted: {
        failureFraction: 0.12,
        failureMode: 'low-smash',
        affectedMetric: 'carryM',
        shiftSigma: 4,
      },
    });
    const cleanShots = generateSyntheticShots(WIDE_SPEC);

    const plantedBaseline = computeDispersionBaseline(
      collectBucket(plantedShots, key),
      config,
    );
    const cleanBaseline = computeDispersionBaseline(
      collectBucket(cleanShots, key),
      config,
    );
    if (plantedBaseline === null || cleanBaseline === null) {
      throw new Error('expected baselines for both twin buckets');
    }
    const plantedSigma = plantedBaseline.carrySigma;
    const cleanSigma = cleanBaseline.carrySigma;
    if (plantedSigma === null || cleanSigma === null) {
      throw new Error('expected carry σ in both twin baselines');
    }
    // Mixture math: σ² × (1 + f(1−f)Δ²) with f=0.12, Δ=4σ → σ ×≈1.64.
    expect(plantedSigma).toBeGreaterThan(cleanSigma * 1.3);

    // Cross-check the raw effect exists in the generated data itself.
    const rawPlanted = plantedShots
      .map((s) => s.carryM)
      .filter((c): c is number => c !== null);
    const rawClean = cleanShots
      .map((s) => s.carryM)
      .filter((c): c is number => c !== null);
    expect(sampleSd(rawPlanted)).toBeGreaterThan(sampleSd(rawClean) * 1.3);
  });
});
