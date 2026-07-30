import { decomposeCarryVariance } from './carry-decomposition';
import { DEFAULT_INSIGHTS_CONFIG, InsightsConfig } from './config';
import { BucketKey, collectBucket, InsightShot } from './types';

let idCounter = 0;
const makeShot = (overrides: Partial<InsightShot> = {}): InsightShot => ({
  id: `shot-${idCounter++}`,
  sessionId: 'session-1',
  clubId: 'club-1',
  clubCategory: 'wedge',
  intent: 'stock',
  warmup: false,
  discarded: false,
  ts: 0,
  handedness: 'right',
  smash: 1.25,
  ballSpeedMs: 30,
  clubSpeedMs: 24,
  launchDeg: 30,
  launchDirDeg: 0,
  backspinRpm: 6000,
  sidespinRpm: 0,
  carryM: 50,
  totalM: 52,
  apexM: 10,
  offlineM: 0,
  curveM: 0,
  strikeHMm: null,
  strikeVMm: null,
  flipFlag: null,
  wristExtTop: null,
  wristExtImpact: null,
  wristExtPeakDown: null,
  ...overrides,
});

const key: BucketKey = { clubId: 'club-1', intent: 'stock' };

describe('decomposeCarryVariance', () => {
  it('is quarantined for untagged buckets', () => {
    const bucket = collectBucket(
      [makeShot({ intent: 'untagged' })],
      { clubId: 'club-1', intent: 'untagged' },
    );
    expect(decomposeCarryVariance(bucket, DEFAULT_INSIGHTS_CONFIG)).toEqual({
      key: { clubId: 'club-1', intent: 'untagged' },
      n: 0,
      r2: null,
      shares: null,
      dominant: null,
    });
  });

  it('returns nulls when there are fewer usable shots than minShots', () => {
    const shots = Array.from({ length: 5 }, () => makeShot());
    const bucket = collectBucket(shots, key);
    // default minShots is 15
    const result = decomposeCarryVariance(bucket, DEFAULT_INSIGHTS_CONFIG);
    expect(result.n).toBe(5);
    expect(result.r2).toBeNull();
    expect(result.shares).toBeNull();
    expect(result.dominant).toBeNull();
  });

  it('returns nulls when two predictors are planted perfectly collinear (singular design)', () => {
    const config: InsightsConfig = {
      ...DEFAULT_INSIGHTS_CONFIG,
      carryDecomposition: { minShots: 6 },
    };
    const clubSpeedMs = [20, 22, 24, 26, 28, 30];
    const smash = clubSpeedMs.map((v) => v / 20); // exact linear function of clubSpeedMs
    const launchDeg = [24, 25, 26, 27, 28, 29];
    const backspinRpm = [5000, 5200, 5400, 5600, 5800, 6000];
    const carryM = [90, 92, 94, 96, 98, 100];
    const shots = clubSpeedMs.map((v, i) =>
      makeShot({
        clubSpeedMs: v,
        smash: smash[i],
        launchDeg: launchDeg[i],
        backspinRpm: backspinRpm[i],
        carryM: carryM[i],
      }),
    );
    const bucket = collectBucket(shots, key);
    const result = decomposeCarryVariance(bucket, config);
    expect(result.n).toBe(6);
    expect(result.r2).toBeNull();
    expect(result.shares).toBeNull();
    expect(result.dominant).toBeNull();
  });

  it('decomposes shares by hand-computed betas over an orthogonal design', () => {
    // 2^3 full-factorial design (coded ±1) over clubSpeedMs/smash/launchDeg,
    // with backspinRpm = clubSpeedMs*smash*launchDeg (coded) so all four
    // predictor columns are pairwise orthogonal. carryM is an EXACT linear
    // combination of the first three coded columns (coefficients 3, 1, 0.5)
    // with zero true weight on backspinRpm, so the fit is perfect (r2 = 1).
    //
    // Because every predictor column has the same sum of squares (8) and
    // carryM has the same sd against every column, each standardized beta
    // reduces to sum(x_i * y) / sum(x_1 * y) ratios of 24 : 8 : 4 : 0, i.e.
    // exactly 6 : 2 : 1 : 0 -> shares 2/3 : 2/9 : 1/9 (launchSpin group folds
    // in the zero backspin contribution).
    const coded: [number, number, number, number][] = [
      [-1, -1, -1, -1],
      [-1, -1, 1, 1],
      [-1, 1, -1, 1],
      [-1, 1, 1, -1],
      [1, -1, -1, 1],
      [1, -1, 1, -1],
      [1, 1, -1, -1],
      [1, 1, 1, 1],
    ];
    const shots = coded.map(([x1, x2, x3, x4]) =>
      makeShot({
        clubSpeedMs: 40 + 2 * x1, // 38 or 42
        smash: 1.25 + 0.05 * x2, // 1.20 or 1.30
        launchDeg: 25 + x3, // 24 or 26
        backspinRpm: 5100 + 100 * x4, // 5000 or 5200
        carryM: 100 + 3 * x1 + 1 * x2 + 0.5 * x3, // exact, no x4 term
      }),
    );
    const config: InsightsConfig = {
      ...DEFAULT_INSIGHTS_CONFIG,
      carryDecomposition: { minShots: 8 },
    };
    const bucket = collectBucket(shots, key);
    const result = decomposeCarryVariance(bucket, config);

    expect(result.n).toBe(8);
    expect(result.r2).toBeCloseTo(1, 5);
    expect(result.shares).not.toBeNull();
    expect(result.shares?.speed).toBeCloseTo(2 / 3, 4);
    expect(result.shares?.smash).toBeCloseTo(2 / 9, 4);
    expect(result.shares?.launchSpin).toBeCloseTo(1 / 9, 4);
    expect(result.dominant).toBe('speed');
  });

  it('excludes shots missing any of the five required fields from n and the fit', () => {
    const coded: [number, number, number, number][] = [
      [-1, -1, -1, -1],
      [-1, -1, 1, 1],
      [-1, 1, -1, 1],
      [-1, 1, 1, -1],
      [1, -1, -1, 1],
      [1, -1, 1, -1],
      [1, 1, -1, -1],
      [1, 1, 1, 1],
    ];
    const goodShots = coded.map(([x1, x2, x3, x4]) =>
      makeShot({
        clubSpeedMs: 40 + 2 * x1,
        smash: 1.25 + 0.05 * x2,
        launchDeg: 25 + x3,
        backspinRpm: 5100 + 100 * x4,
        carryM: 100 + 3 * x1 + 1 * x2 + 0.5 * x3,
      }),
    );
    const incompleteShots = [
      makeShot({ clubSpeedMs: null, carryM: 999 }),
      makeShot({ smash: null, carryM: 999 }),
      makeShot({ carryM: null }),
    ];
    const config: InsightsConfig = {
      ...DEFAULT_INSIGHTS_CONFIG,
      carryDecomposition: { minShots: 8 },
    };
    const bucket = collectBucket([...goodShots, ...incompleteShots], key);
    const result = decomposeCarryVariance(bucket, config);
    expect(result.n).toBe(8);
    expect(result.shares?.speed).toBeCloseTo(2 / 3, 4);
  });
});
