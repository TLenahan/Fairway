import {
  certify,
  computeDispersionBaseline,
  computeReferenceBaseline,
  detectChangepoint,
} from './baselines';
import { DEFAULT_INSIGHTS_CONFIG } from './config';
import { BucketKey, collectBucket, InsightShot, UnfilteredBucket } from './types';

const config = DEFAULT_INSIGHTS_CONFIG;

let counter = 0;

/** A fully-specified wedge/stock shot that passes every great criterion by
    construction; tests override only the fields under test. */
function buildShot(overrides: Partial<InsightShot> = {}): InsightShot {
  counter += 1;
  return {
    id: `shot-${counter}`,
    sessionId: 'session-1',
    clubId: 'sw',
    clubCategory: 'wedge',
    intent: 'stock',
    warmup: false,
    discarded: false,
    ts: 1000 + counter,
    handedness: 'right',
    smash: 1.3, // ceiling 1.25 * factor 0.96 = 1.2 -> passes
    ballSpeedMs: 30,
    clubSpeedMs: 25,
    launchDeg: 30,
    launchDirDeg: 0, // inside stock corridor [-3, 3]
    backspinRpm: 6000,
    sidespinRpm: 0,
    carryM: 50,
    totalM: 52,
    apexM: 10,
    offlineM: 0,
    curveM: 0, // 'either' corridor
    strikeHMm: 2,
    strikeVMm: 2, // dist ~= 2.83 <= 12 -> passes
    flipFlag: null,
    wristExtTop: null,
    wristExtImpact: null,
    wristExtPeakDown: null,
    ...overrides,
  };
}

const STOCK_KEY: BucketKey = { clubId: 'sw', intent: 'stock' };

function bucketOf(shots: InsightShot[], key: BucketKey = STOCK_KEY): UnfilteredBucket {
  return collectBucket(shots, key);
}

describe('computeReferenceBaseline', () => {
  it('computes perMetric stats from GREAT shots only — bad shots would move the median', () => {
    // Great carries [50, 50, 50, 51, 52]; bad shots (smash fail) carry 80.
    // Bucket-wide carry median = 51.5, great-only median = 50 — the baseline
    // must report 50.
    const great = [50, 50, 50, 51, 52].map((carryM) => buildShot({ carryM }));
    const bad = [80, 80, 80].map((carryM) => buildShot({ carryM, smash: 1.0 }));
    const result = computeReferenceBaseline(bucketOf([...great, ...bad]), config);

    expect(result).not.toBeNull();
    expect(result?.nGreat).toBe(5);
    // median of [50,50,50,51,52] = 50; iqr = q75(51) - q25(50) = 1
    expect(result?.perMetric.carryM).toEqual({ n: 5, median: 50, iqr: 1 });
    // launchDeg identical across greats: median 30, iqr 0
    expect(result?.perMetric.launchDeg).toEqual({ n: 5, median: 30, iqr: 0 });
  });

  it('omits metrics with fewer than 3 non-null values among great shots', () => {
    const great = [
      buildShot({ wristExtImpact: 10 }),
      buildShot({ wristExtImpact: 12 }),
      buildShot({ wristExtImpact: null }),
    ];
    const result = computeReferenceBaseline(bucketOf(great), config);
    expect(result?.nGreat).toBe(3);
    // only 2 non-null wristExtImpact -> absent
    expect('wristExtImpact' in (result?.perMetric ?? {})).toBe(false);
    // wristExtTop null everywhere -> absent
    expect('wristExtTop' in (result?.perMetric ?? {})).toBe(false);
    // smash present on all 3 -> included
    expect(result?.perMetric.smash).toEqual({ n: 3, median: 1.3, iqr: 0 });
  });

  it('includes a metric once it reaches 3 non-null values among great shots', () => {
    const great = [
      buildShot({ wristExtImpact: 10 }),
      buildShot({ wristExtImpact: 12 }),
      buildShot({ wristExtImpact: 14 }),
    ];
    const result = computeReferenceBaseline(bucketOf(great), config);
    expect(result?.perMetric.wristExtImpact).toEqual({ n: 3, median: 12, iqr: 2 });
  });

  it('returns null when the bucket has zero great shots', () => {
    const shots = [1.0, 1.0, 1.0].map((smash) => buildShot({ smash }));
    expect(computeReferenceBaseline(bucketOf(shots), config)).toBeNull();
  });

  it('returns null for an untagged bucket (quarantine)', () => {
    const key: BucketKey = { clubId: 'sw', intent: 'untagged' };
    const shots = [buildShot({ intent: 'untagged' })];
    expect(computeReferenceBaseline(bucketOf(shots, key), config)).toBeNull();
  });
});

describe('computeDispersionBaseline', () => {
  it('includes bad shots — sigma reflects them (the cardinal-sin guard)', () => {
    // Single session, equal weights: carries [50, 50, 80, 80], two of them
    // smash-fail shots. Great-only sigma would be 0; unfiltered weighted sd
    // = population sd: mean 65, sqrt(4*225/4) = 15.
    const shots = [
      buildShot({ carryM: 50 }),
      buildShot({ carryM: 50 }),
      buildShot({ carryM: 80, smash: 1.0 }),
      buildShot({ carryM: 80, smash: 1.0 }),
    ];
    const result = computeDispersionBaseline(bucketOf(shots), config);
    expect(result?.nTotal).toBe(4);
    expect(result?.carrySigma).toBeCloseTo(15, 10);
    // smash [1.3, 1.3, 1.0, 1.0]: mean 1.15, sd 0.15
    expect(result?.smashSigma).toBeCloseTo(0.15, 10);
    expect(result?.perMetric.carryM).toBeCloseTo(15, 10);
    // 4 strike locations < 5 -> null
    expect(result?.strikeScatterMm).toBeNull();
  });

  it('EWMA: the same spread weighs less in an older session than a recent one', () => {
    // Two sessions, halfLife 5 -> older weight w = 0.5^(1/5) ~= 0.8705506.
    // Case A: spread [40, 60] in the OLD session, tight [50, 50] recent.
    // Case B: spread [40, 60] in the RECENT session, tight [50, 50] old.
    // Both have weighted mean 50. Sw = 2 + 2w = 3.7411011.
    // sigmaA = sqrt(w*200 / Sw) = sqrt(46.53980) ~= 6.8220
    // sigmaB = sqrt(1*200 / Sw) = sqrt(53.46029) ~= 7.3117
    const caseA = [
      buildShot({ sessionId: 'old', ts: 1000, carryM: 40 }),
      buildShot({ sessionId: 'old', ts: 1001, carryM: 60 }),
      buildShot({ sessionId: 'new', ts: 2000, carryM: 50 }),
      buildShot({ sessionId: 'new', ts: 2001, carryM: 50 }),
    ];
    const caseB = [
      buildShot({ sessionId: 'old', ts: 1000, carryM: 50 }),
      buildShot({ sessionId: 'old', ts: 1001, carryM: 50 }),
      buildShot({ sessionId: 'new', ts: 2000, carryM: 40 }),
      buildShot({ sessionId: 'new', ts: 2001, carryM: 60 }),
    ];
    const sigmaA = computeDispersionBaseline(bucketOf(caseA), config)?.carrySigma;
    const sigmaB = computeDispersionBaseline(bucketOf(caseB), config)?.carrySigma;
    expect(sigmaA).toBeCloseTo(6.8220, 3);
    expect(sigmaB).toBeCloseTo(7.3117, 3);
    expect(sigmaB ?? 0).toBeGreaterThan(sigmaA ?? 0);
  });

  it('strikeScatterMm: weighted sd of strike distance with >= 5 strikes', () => {
    // Distances: (3,4) -> 5 four times, (6,8) -> 10 once. Equal weights:
    // mean 6, sd = sqrt((4*1 + 16)/5) = 2.
    const shots = [
      buildShot({ strikeHMm: 3, strikeVMm: 4 }),
      buildShot({ strikeHMm: 3, strikeVMm: 4 }),
      buildShot({ strikeHMm: 3, strikeVMm: 4 }),
      buildShot({ strikeHMm: 3, strikeVMm: 4 }),
      buildShot({ strikeHMm: 6, strikeVMm: 8 }),
    ];
    const result = computeDispersionBaseline(bucketOf(shots), config);
    expect(result?.strikeScatterMm).toBeCloseTo(2, 10);
  });

  it('strikeScatterMm: null when fewer than 5 shots have strike locations', () => {
    const shots = [
      buildShot(),
      buildShot(),
      buildShot(),
      buildShot(),
      buildShot({ strikeHMm: null, strikeVMm: null }),
    ];
    const result = computeDispersionBaseline(bucketOf(shots), config);
    expect(result?.strikeScatterMm).toBeNull();
  });

  it('omits metrics with fewer than 3 non-null values', () => {
    const shots = [
      buildShot({ wristExtImpact: 10 }),
      buildShot({ wristExtImpact: 12 }),
      buildShot(),
      buildShot(),
    ];
    const result = computeDispersionBaseline(bucketOf(shots), config);
    expect('wristExtImpact' in (result?.perMetric ?? {})).toBe(false);
  });

  it('returns null for an empty bucket', () => {
    expect(computeDispersionBaseline(bucketOf([]), config)).toBeNull();
  });

  it('returns null for an untagged bucket (quarantine)', () => {
    const key: BucketKey = { clubId: 'sw', intent: 'untagged' };
    const shots = [buildShot({ intent: 'untagged' })];
    expect(computeDispersionBaseline(bucketOf(shots, key), config)).toBeNull();
  });
});

describe('certify', () => {
  // Defaults: minGreat 20, minTotal 30, sigmaStabilityPct 10,
  // sigmaStabilityWindow 10, sessionCap 80. Stability testable at
  // nTotal >= 40.

  function shotsWith(greatCount: number, badCount: number): InsightShot[] {
    const shots: InsightShot[] = [];
    for (let i = 0; i < greatCount; i += 1) shots.push(buildShot({ smash: 1.3 }));
    for (let i = 0; i < badCount; i += 1) shots.push(buildShot({ smash: 1.0 }));
    return shots;
  }

  it('certified at exactly minGreat/minTotal with stable sigma', () => {
    // 20 great + 20 bad, all carries 50 -> sigma 0 both windows -> stable.
    const result = certify(bucketOf(shotsWith(20, 20)), config);
    expect(result.nGreat).toBe(20);
    expect(result.nTotal).toBe(40);
    expect(result.greatRate).toBeCloseTo(0.5, 10);
    expect(result.sigmaStable).toBe(true);
    expect(result.status).toBe('certified');
  });

  it('uncertified at 19 great — one short of the minGreat gate', () => {
    const result = certify(bucketOf(shotsWith(19, 21)), config);
    expect(result.nGreat).toBe(19);
    expect(result.sigmaStable).toBe(true);
    expect(result.status).toBe('uncertified');
  });

  it('sigmaStable is null (and status uncertified) below minTotal + stability window', () => {
    // 39 total < 30 + 10 even though 20 great.
    const result = certify(bucketOf(shotsWith(20, 19)), config);
    expect(result.nTotal).toBe(39);
    expect(result.sigmaStable).toBeNull();
    expect(result.status).toBe('uncertified');
  });

  it('sigma instability blocks certification; the last window is taken by ts', () => {
    // First 30 carries alternate 45/55: sd = sqrt(750/29) ~= 5.085.
    // Last 10 (by ts) alternate 20/80: full-stream sd = sqrt(9750/39)
    // ~= 15.81 -> relative change ~2.1 >> 0.10 -> unstable.
    const shots: InsightShot[] = [];
    for (let i = 0; i < 30; i += 1) {
      shots.push(buildShot({ ts: 1000 + i, carryM: i % 2 === 0 ? 45 : 55 }));
    }
    for (let i = 0; i < 10; i += 1) {
      shots.push(buildShot({ ts: 2000 + i, carryM: i % 2 === 0 ? 20 : 80 }));
    }
    // Reverse the array: ts ordering, not array order, must govern which
    // shots count as "the last window".
    const result = certify(bucketOf([...shots].reverse()), config);
    expect(result.sigmaStable).toBe(false);
    expect(result.status).toBe('uncertified');
  });

  it('contact-before-shapes past the session cap with too few great shots', () => {
    // 80 shots, all smash-fail: volume without contact quality.
    const result = certify(bucketOf(shotsWith(0, 80)), config);
    expect(result.nGreat).toBe(0);
    expect(result.nTotal).toBe(80);
    expect(result.status).toBe('contact-before-shapes');
  });

  it('empty bucket: greatRate null, sigmaStable null, uncertified', () => {
    const result = certify(bucketOf([]), config);
    expect(result.nTotal).toBe(0);
    expect(result.greatRate).toBeNull();
    expect(result.sigmaStable).toBeNull();
    expect(result.status).toBe('uncertified');
  });

  it('untagged bucket: quarantined neutral result', () => {
    const key: BucketKey = { clubId: 'sw', intent: 'untagged' };
    const shots = Array.from({ length: 80 }, () => buildShot({ intent: 'untagged' }));
    const result = certify(bucketOf(shots, key), config);
    expect(result.status).toBe('uncertified');
    expect(result.nGreat).toBe(0);
    expect(result.greatRate).toBeNull();
    expect(result.sigmaStable).toBeNull();
  });
});

describe('detectChangepoint', () => {
  // Defaults: cusumThresholdSigma 4, cusumDriftSigma 0.5,
  // dispersionSpikeFactor 1.5, minShots 20.

  function carryShots(carries: readonly number[], tsStart = 1000): InsightShot[] {
    return carries.map((carryM, i) => buildShot({ carryM, ts: tsStart + i }));
  }

  it('planted mean shift with held dispersion -> new-swing (ts order governs, not array order)', () => {
    // First half: 20 carries alternating 49/51 -> mu 50, sd ~= 1.026.
    // Second half: 20 carries at 58 -> z ~= 7.8 per shot, CUSUM alarms
    // immediately; sd(second) = 0, no spike.
    const first = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 49 : 51));
    const second = Array.from({ length: 20 }, () => 58);
    const shots = carryShots([...first, ...second]);
    const result = detectChangepoint(bucketOf([...shots].reverse()), config);
    expect(result.centerShifted).toBe(true);
    expect(result.dispersionSpiked).toBe(false);
    expect(result.verdict).toBe('new-swing');
  });

  it('planted variance spike with held center -> bad-day', () => {
    // First half alternating 45/55: mu 50, sd = sqrt(500/19) ~= 5.130.
    // Second half alternating 60/40: sd ~= 10.26 > 5.130 * 1.5 = 7.695.
    // CUSUM: |z| ~= 1.949, alternating signs reset both sides
    // (max side value 1.449 < 4) -> no alarm.
    const first = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 45 : 55));
    const second = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 60 : 40));
    const result = detectChangepoint(bucketOf(carryShots([...first, ...second])), config);
    expect(result.centerShifted).toBe(false);
    expect(result.dispersionSpiked).toBe(true);
    expect(result.verdict).toBe('bad-day');
  });

  it('mean shift AND variance spike together -> ambiguous, verdict null', () => {
    // First half alternating 45/55. Second half alternating 50/70:
    // mean 60, sd ~= 10.26 (spiked) and one-sided CUSUM accumulates
    // (0, 3.399, 2.899, 6.297 > 4 -> alarm).
    const first = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 45 : 55));
    const second = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 50 : 70));
    const result = detectChangepoint(bucketOf(carryShots([...first, ...second])), config);
    expect(result.centerShifted).toBe(true);
    expect(result.dispersionSpiked).toBe(true);
    expect(result.verdict).toBeNull();
  });

  it('clean stream -> no flags, verdict null', () => {
    const carries = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 49 : 51));
    const result = detectChangepoint(bucketOf(carryShots(carries)), config);
    expect(result.centerShifted).toBe(false);
    expect(result.dispersionSpiked).toBe(false);
    expect(result.verdict).toBeNull();
  });

  it('below minShots (null carries excluded from the stream) -> all-false result', () => {
    // 19 carry-bearing shots + 6 null-carry shots: stream length 19 < 20.
    const withCarry = carryShots(
      Array.from({ length: 19 }, (_, i) => (i % 2 === 0 ? 40 : 80)),
    );
    const noCarry = Array.from({ length: 6 }, () => buildShot({ carryM: null }));
    const result = detectChangepoint(bucketOf([...withCarry, ...noCarry]), config);
    expect(result.centerShifted).toBe(false);
    expect(result.dispersionSpiked).toBe(false);
    expect(result.verdict).toBeNull();
  });

  it('untagged bucket -> all-false result (quarantine)', () => {
    const key: BucketKey = { clubId: 'sw', intent: 'untagged' };
    const shots = Array.from({ length: 40 }, (_, i) =>
      buildShot({ intent: 'untagged', ts: 1000 + i, carryM: i < 20 ? 50 : 90 }),
    );
    const result = detectChangepoint(bucketOf(shots, key), config);
    expect(result.centerShifted).toBe(false);
    expect(result.dispersionSpiked).toBe(false);
    expect(result.verdict).toBeNull();
  });
});
