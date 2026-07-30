import { certify, computeDispersionBaseline } from './baselines';
import { DEFAULT_INSIGHTS_CONFIG } from './config';
import { detectFindings } from './findings';
import { generateSyntheticShots, mulberry32, SyntheticBucketSpec } from './synthetic';
import { collectBucket, InsightShot } from './types';

/**
 * Property tests (BUILD_SPEC §8.4): invariants that must hold regardless of
 * tuning — order invariance, warmup/discard exclusion, untagged quarantine —
 * plus determinism self-tests for the synthetic harness itself.
 */

const config = DEFAULT_INSIGHTS_CONFIG;

const BASE_SPEC: SyntheticBucketSpec = {
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

/** Deterministic Fisher-Yates driven by mulberry32 — same seed, same order. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('synthetic harness determinism', () => {
  it('mulberry32 yields the known sequence for seed 1', () => {
    const rng = mulberry32(1);
    // Reference values of the canonical mulberry32 stream, seed 1.
    expect(rng()).toBeCloseTo(0.6270739405881613, 12);
    expect(rng()).toBeCloseTo(0.002735721180215478, 12);
    expect(rng()).toBeCloseTo(0.5274470399599522, 12);
  });

  it('mulberry32 stays in [0, 1) and is seed-deterministic', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i += 1) {
      const v = a();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(b()).toBe(v);
    }
  });

  it('generateSyntheticShots is byte-identical across runs of one spec', () => {
    expect(generateSyntheticShots(BASE_SPEC)).toEqual(
      generateSyntheticShots(BASE_SPEC),
    );
  });

  it('shots have monotonically increasing ts and session-0..n ids', () => {
    const shots = generateSyntheticShots(BASE_SPEC);
    expect(shots).toHaveLength(500);
    for (let i = 1; i < shots.length; i += 1) {
      expect(shots[i].ts).toBeGreaterThan(shots[i - 1].ts);
    }
    expect(shots[0].sessionId).toBe('session-0');
    expect(shots[shots.length - 1].sessionId).toBe('session-4');
    const sessions = new Set(shots.map((s) => s.sessionId));
    expect(sessions.size).toBe(5);
  });

  it('planted and clean twins differ only on planted shots', () => {
    const planted = generateSyntheticShots(BASE_SPEC);
    const clean = generateSyntheticShots({ ...BASE_SPEC, planted: undefined });
    const differing = planted.filter(
      (s, i) => JSON.stringify(s) !== JSON.stringify(clean[i]),
    );
    // floor(500 × 0.15) plants, evenly spread.
    expect(differing).toHaveLength(75);
    for (const s of differing) {
      // low-smash plant: smash pinned below ceiling × lowSmashFactor.
      const ceiling = config.greatShot.smashCeiling.iron;
      expect(s.smash).not.toBeNull();
      if (s.smash !== null) {
        expect(s.smash).toBeLessThan(
          ceiling * config.failureModes.lowSmashFactor,
        );
      }
    }
  });
});

/** Recursively round every number to 10 significant digits. Findings sums
    metric series in input order, so a shuffle perturbs effect sizes at the
    ~1e-13 relative level (FP summation is not associative). Semantically the
    outputs must be identical; this canonicalization tolerates only that FP
    noise. (Bit-exact invariance would need findings to sort shots by
    (ts, id) before aggregating.) */
function roundDeep(value: unknown): unknown {
  if (typeof value === 'number') return Number(value.toPrecision(10));
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, roundDeep(v)]),
    );
  }
  return value;
}

describe('property: order invariance', () => {
  const shots = generateSyntheticShots(BASE_SPEC);
  const reordered = shuffled(shots, 999);
  const key = { clubId: 'i7', intent: 'stock' as const };

  it('detectFindings is invariant to input order (up to FP noise)', () => {
    expect(roundDeep(detectFindings(reordered, config))).toEqual(
      roundDeep(detectFindings(shots, config)),
    );
  });

  it('certify is invariant to input order', () => {
    expect(certify(collectBucket(reordered, key), config)).toEqual(
      certify(collectBucket(shots, key), config),
    );
  });
});

describe('property: warmup/discard exclusion', () => {
  const clean = generateSyntheticShots({ ...BASE_SPEC, planted: undefined });
  const isNoisy = (i: number): boolean => i % 7 === 0;
  /** Every 7th shot becomes a warmup with wild values — pure noise that
      must be invisible to every downstream computation. */
  const withWarmupNoise: InsightShot[] = clean.map((s, i) =>
    isNoisy(i)
      ? {
          ...s,
          warmup: true,
          smash: 0.6,
          ballSpeedMs: 5,
          offlineM: 80,
          curveM: -60,
          wristExtPeakDown: 55,
        }
      : s,
  );
  const kept = clean.filter((_, i) => !isNoisy(i));
  const key = { clubId: 'i7', intent: 'stock' as const };

  it('collectBucket drops exactly the warmup-flagged shots', () => {
    const bucket = collectBucket(withWarmupNoise, key);
    expect(bucket.shots.map((s) => s.id)).toEqual(kept.map((s) => s.id));
  });

  it('collectBucket drops discarded shots the same way', () => {
    const withDiscards = clean.map((s, i) =>
      isNoisy(i) ? { ...s, discarded: true } : s,
    );
    const bucket = collectBucket(withDiscards, key);
    expect(bucket.shots.map((s) => s.id)).toEqual(kept.map((s) => s.id));
  });

  it('findings ignore warmup noise entirely', () => {
    expect(detectFindings(withWarmupNoise, config)).toEqual(
      detectFindings(kept, config),
    );
  });
});

describe('property: untagged quarantine', () => {
  const UNTAGGED_SPEC: SyntheticBucketSpec = {
    ...BASE_SPEC,
    intent: 'untagged',
    sessions: 3,
    shotsPerSession: 40,
    seed: 5150,
    planted: {
      failureFraction: 0.2,
      failureMode: 'low-smash',
      affectedMetric: 'wristExtPeakDown',
      shiftSigma: 2,
    },
  };
  const shots = generateSyntheticShots(UNTAGGED_SPEC);
  const key = { clubId: 'i7', intent: 'untagged' as const };

  it('untagged shots never surface in any finding — even with a plant', () => {
    expect(detectFindings(shots, config)).toEqual([]);
  });

  it('untagged buckets produce null dispersion baselines', () => {
    const baseline = computeDispersionBaseline(collectBucket(shots, key), config);
    expect(baseline).toBeNull();
  });
});
