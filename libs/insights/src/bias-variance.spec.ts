import { classifyBiasVariance } from './bias-variance';
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

// Lower minShots so small hand-computed datasets clear the gate.
const config: InsightsConfig = {
  ...DEFAULT_INSIGHTS_CONFIG,
  biasVariance: { ...DEFAULT_INSIGHTS_CONFIG.biasVariance, minShots: 5 },
};

describe('classifyBiasVariance', () => {
  it('is quarantined for untagged buckets', () => {
    const bucket = collectBucket(
      [makeShot({ intent: 'untagged' })],
      { clubId: 'club-1', intent: 'untagged' },
    );
    expect(classifyBiasVariance(bucket, config)).toEqual([]);
  });

  it('classifies a systematic outcome offset as bias', () => {
    // mean = 4, sample sd = sqrt(0.8) ≈ 0.8944 -> ratio ≈ 4.47 >= biasOffsetSigma(1)
    const values = [3, 4, 5, 4, 3, 5];
    const shots = values.map((v) => makeShot({ launchDirDeg: v }));
    const bucket = collectBucket(shots, key);
    const entry = classifyBiasVariance(bucket, config).find((e) => e.metric === 'launchDirDeg');
    expect(entry?.classification).toBe('bias');
    expect(entry?.meanOffset).toBeCloseTo(4, 5);
    expect(entry?.sigma).toBeCloseTo(Math.sqrt(0.8), 5);
    expect(entry?.outcomeCorrelation).toBeNull();
  });

  it('classifies an outcome metric centered near zero as neutral', () => {
    const values = [-2, 3, -1, 2, -3, 1]; // mean = 0
    const shots = values.map((v) => makeShot({ launchDirDeg: v }));
    const bucket = collectBucket(shots, key);
    const entry = classifyBiasVariance(bucket, config).find((e) => e.metric === 'launchDirDeg');
    expect(entry?.classification).toBe('neutral');
    expect(entry?.meanOffset).toBeNull();
    expect(entry?.sigma).toBeNull();
  });

  it('treats an under-minShots outcome metric as neutral even with a huge offset', () => {
    const shots = [makeShot({ launchDirDeg: 30 }), makeShot({ launchDirDeg: 30 })]; // n=2 < minShots(5)
    const bucket = collectBucket(shots, key);
    const entry = classifyBiasVariance(bucket, config).find((e) => e.metric === 'launchDirDeg');
    expect(entry?.classification).toBe('neutral');
  });

  it('treats a zero-sd non-zero offset as maximal bias without dividing by zero', () => {
    const shots = Array.from({ length: 5 }, () => makeShot({ launchDirDeg: 6 }));
    const bucket = collectBucket(shots, key);
    const entry = classifyBiasVariance(bucket, config).find((e) => e.metric === 'launchDirDeg');
    expect(entry?.classification).toBe('bias');
    expect(entry?.meanOffset).toBe(6);
    expect(entry?.sigma).toBe(0);
  });

  it('classifies a delivery metric whose deviations track offline deviations as a variance-driver', () => {
    // |clubSpeedMs - median| reproduces |offlineM - median| exactly -> pearson = 1
    const clubSpeed = [30, 32, 34, 36, 38, 40]; // median 35, sd sqrt(14)
    const offline = [-5, -3, -1, 1, 3, 5]; // median 0
    const shots = clubSpeed.map((v, i) => makeShot({ clubSpeedMs: v, offlineM: offline[i] }));
    const bucket = collectBucket(shots, key);
    const entry = classifyBiasVariance(bucket, config).find((e) => e.metric === 'clubSpeedMs');
    expect(entry?.classification).toBe('variance-driver');
    expect(entry?.outcomeCorrelation).toBeCloseTo(1, 5);
    expect(entry?.sigma).toBeCloseTo(Math.sqrt(14), 5);
    expect(entry?.meanOffset).toBeNull();
  });

  it('classifies a constant delivery metric (zero correlation, undefined direction) as neutral', () => {
    const offline = [-5, -3, -1, 1, 3, 5];
    const shots = offline.map((o) => makeShot({ backspinRpm: 6000, offlineM: o }));
    const bucket = collectBucket(shots, key);
    const entry = classifyBiasVariance(bucket, config).find((e) => e.metric === 'backspinRpm');
    expect(entry?.classification).toBe('neutral');
    expect(entry?.outcomeCorrelation).toBeNull();
    expect(entry?.sigma).toBeNull();
  });

  it('drops pairs where offlineM is null before correlating a delivery metric', () => {
    const clubSpeed = [30, 32, 34, 36, 38, 40];
    const offline: (number | null)[] = [-5, -3, -1, 1, 3, null];
    const shots = clubSpeed.map((v, i) => makeShot({ clubSpeedMs: v, offlineM: offline[i] }));
    const bucket = collectBucket(shots, key);
    // only 5 non-null pairs remain, still >= minShots(5)
    const entry = classifyBiasVariance(bucket, config).find((e) => e.metric === 'clubSpeedMs');
    expect(entry?.classification).not.toBeUndefined();
  });

  it('never classifies an outcome metric as variance-driver, nor a delivery metric as bias', () => {
    const shots = Array.from({ length: 20 }, (_, i) =>
      makeShot({
        launchDirDeg: i % 2 === 0 ? 5 : -5,
        clubSpeedMs: 24 + i,
        offlineM: i - 10,
      }),
    );
    const bucket = collectBucket(shots, key);
    const entries = classifyBiasVariance(bucket, config);
    expect(entries).toHaveLength(10); // 3 outcome + 7 delivery
    const outcomeKeys = new Set(['launchDirDeg', 'offlineM', 'curveM']);
    for (const entry of entries) {
      if (outcomeKeys.has(entry.metric)) {
        expect(entry.classification).not.toBe('variance-driver');
      } else {
        expect(entry.classification).not.toBe('bias');
      }
    }
  });
});
