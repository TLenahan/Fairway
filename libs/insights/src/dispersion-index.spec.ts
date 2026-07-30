import { DEFAULT_INSIGHTS_CONFIG, InsightsConfig } from './config';
import { computeDispersionIndex } from './dispersion-index';
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

// carryM: [45,50,55,50,45,55] -> median 50, sample sd sqrt(20) -> carrySigmaPct ≈ 8.944272
// offlineM: [-3,-1,1,3,-3,3] -> sample sd sqrt(7.6) ≈ 2.756810
// smash: [1.2,1.3,1.25,1.2,1.3,1.25] -> sample sd sqrt(0.002) ≈ 0.044721
// strike (h,v) Pythagorean triples over 5 of 6 shots -> scatter [5,10,13,5,15],
//   sample sd sqrt(20.8) ≈ 4.560702
const carryM = [45, 50, 55, 50, 45, 55];
const offlineM = [-3, -1, 1, 3, -3, 3];
const smash = [1.2, 1.3, 1.25, 1.2, 1.3, 1.25];
const strikeHV: Array<[number, number] | null> = [
  [3, 4],
  [6, 8],
  [5, 12],
  [0, 5],
  [9, 12],
  null,
];

const buildFullShots = (): InsightShot[] =>
  carryM.map((c, i) =>
    makeShot({
      carryM: c,
      offlineM: offlineM[i],
      smash: smash[i],
      strikeHMm: strikeHV[i]?.[0] ?? null,
      strikeVMm: strikeHV[i]?.[1] ?? null,
    }),
  );

const configMinShots5: InsightsConfig = {
  ...DEFAULT_INSIGHTS_CONFIG,
  dispersionIndex: { ...DEFAULT_INSIGHTS_CONFIG.dispersionIndex, minShots: 5 },
};

describe('computeDispersionIndex', () => {
  it('is quarantined for untagged buckets', () => {
    const bucket = collectBucket(
      [makeShot({ intent: 'untagged' })],
      { clubId: 'club-1', intent: 'untagged' },
    );
    expect(computeDispersionIndex(bucket, DEFAULT_INSIGHTS_CONFIG)).toEqual({
      key: { clubId: 'club-1', intent: 'untagged' },
      n: 0,
      value: null,
      components: {
        carrySigmaPct: null,
        offlineSigmaM: null,
        smashSigma: null,
        strikeScatterMm: null,
      },
    });
  });

  it('computes all four hand-computed components and their weighted mean', () => {
    const bucket = collectBucket(buildFullShots(), key);
    const result = computeDispersionIndex(bucket, configMinShots5);

    expect(result.n).toBe(6);
    expect(result.components.carrySigmaPct).toBeCloseTo(8.944272, 4);
    expect(result.components.offlineSigmaM).toBeCloseTo(2.756810, 4);
    expect(result.components.smashSigma).toBeCloseTo(0.044721, 4);
    expect(result.components.strikeScatterMm).toBeCloseTo(4.560702, 4);

    // weights sum to 1 already (.35+.30+.20+.15), so no renormalization needed
    const expected =
      8.944272 * 0.35 + 2.756810 * 0.3 + 0.044721 * 0.2 + 4.560702 * 0.15;
    expect(result.value).toBeCloseTo(expected, 3);
  });

  it('renormalizes weights over the available components when strike data is absent', () => {
    const shots = carryM.map((c, i) =>
      makeShot({ carryM: c, offlineM: offlineM[i], smash: smash[i] }),
    ); // no strike data at all
    const bucket = collectBucket(shots, key);
    const result = computeDispersionIndex(bucket, configMinShots5);

    expect(result.components.strikeScatterMm).toBeNull();
    const numerator = 8.944272 * 0.35 + 2.756810 * 0.3 + 0.044721 * 0.2;
    const expected = numerator / (0.35 + 0.3 + 0.2);
    expect(result.value).toBeCloseTo(expected, 3);
  });

  it('requires at least 5 strikes before trusting strikeScatterMm', () => {
    const shots = carryM.map((c, i) =>
      makeShot({
        carryM: c,
        offlineM: offlineM[i],
        smash: smash[i],
        strikeHMm: i < 4 ? strikeHV[i]?.[0] ?? null : null,
        strikeVMm: i < 4 ? strikeHV[i]?.[1] ?? null : null,
      }),
    ); // only 4 shots carry strike data
    const bucket = collectBucket(shots, key);
    const result = computeDispersionIndex(bucket, configMinShots5);
    expect(result.components.strikeScatterMm).toBeNull();
  });

  it('nulls carrySigmaPct rather than dividing by a zero median', () => {
    const values = [-5, 5, -3, 3, 0, 0]; // median 0
    const shots = values.map((c) => makeShot({ carryM: c }));
    const bucket = collectBucket(shots, key);
    const result = computeDispersionIndex(bucket, configMinShots5);
    expect(result.components.carrySigmaPct).toBeNull();
    expect(result.value).not.toBeNull(); // still averages offline/smash/strike
  });

  it('nulls the composite value below minShots even though components are computable', () => {
    const shots = buildFullShots(); // n = 6
    const bucket = collectBucket(shots, key);
    // default minShots is 10
    const result = computeDispersionIndex(bucket, DEFAULT_INSIGHTS_CONFIG);
    expect(result.n).toBe(6);
    expect(result.value).toBeNull();
    expect(result.components.carrySigmaPct).toBeCloseTo(8.944272, 4);
  });

  it('nulls every component and the value when no shots carry any data', () => {
    const shots = [makeShot(), makeShot(), makeShot(), makeShot(), makeShot()].map((s) => ({
      ...s,
      carryM: null,
      offlineM: null,
      smash: null,
    }));
    const bucket = collectBucket(shots, key);
    const result = computeDispersionIndex(bucket, configMinShots5);
    expect(result.components).toEqual({
      carrySigmaPct: null,
      offlineSigmaM: null,
      smashSigma: null,
      strikeScatterMm: null,
    });
    expect(result.value).toBeNull();
  });
});
