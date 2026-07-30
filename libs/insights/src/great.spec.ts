import { DEFAULT_INSIGHTS_CONFIG } from './config';
import { classifyGreatShots, greatShots } from './great';
import { BucketKey, collectBucket, InsightShot } from './types';

const config = DEFAULT_INSIGHTS_CONFIG;

let counter = 0;

/** A fully-specified wedge/stock shot that passes every criterion by
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
    curveM: 0, // 'either' corridor, curve irrelevant
    strikeHMm: 2,
    strikeVMm: 2, // sqrt(8) ~= 2.83 <= 12 -> passes
    flipFlag: null,
    wristExtTop: null,
    wristExtImpact: null,
    wristExtPeakDown: null,
    ...overrides,
  };
}

function bucketOf(shots: InsightShot[], key: BucketKey = { clubId: 'sw', intent: 'stock' }) {
  // collectBucket filters by clubId/intent/warmup/discarded, so make sure
  // synthetic shots line up with the key by default.
  return collectBucket(shots, key);
}

describe('classifyGreatShots', () => {
  it('smash: passes exactly at the ceiling*factor threshold', () => {
    const shot = buildShot({ smash: 1.25 * 0.96 });
    const [result] = classifyGreatShots(bucketOf([shot]), config);
    expect(result.criteria.smash).toBe(true);
  });

  it('smash: fails below the ceiling*factor threshold', () => {
    const shot = buildShot({ smash: 1.19 });
    const [result] = classifyGreatShots(bucketOf([shot]), config);
    expect(result.criteria.smash).toBe(false);
    expect(result.great).toBe(false);
  });

  it('smash: absent from criteria when smash is null (missing data, not a failure)', () => {
    const shot = buildShot({ smash: null });
    const [result] = classifyGreatShots(bucketOf([shot]), config);
    expect(result.criteria.smash).toBeUndefined();
    expect('smash' in result.criteria).toBe(false);
  });

  it('smash: is an absolute floor, not relative to the bucket', () => {
    // Every shot in the bucket has a mediocre smash; none should get a pass
    // just because they're all equally mediocre.
    const shots = [
      buildShot({ smash: 1.0 }),
      buildShot({ smash: 1.0 }),
      buildShot({ smash: 1.0 }),
    ];
    const results = classifyGreatShots(bucketOf(shots), config);
    for (const r of results) expect(r.criteria.smash).toBe(false);
  });

  it('strike: passes within the radius', () => {
    const shot = buildShot({ strikeHMm: 3, strikeVMm: 4 }); // dist = 5 <= 12
    const [result] = classifyGreatShots(bucketOf([shot]), config);
    expect(result.criteria.strike).toBe(true);
  });

  it('strike: fails beyond the radius', () => {
    const shot = buildShot({ strikeHMm: 9, strikeVMm: 9 }); // dist ~= 12.73 > 12
    const [result] = classifyGreatShots(bucketOf([shot]), config);
    expect(result.criteria.strike).toBe(false);
    expect(result.great).toBe(false);
  });

  it('strike: absent when strike location is missing', () => {
    const shot = buildShot({ strikeHMm: null, strikeVMm: null });
    const [result] = classifyGreatShots(bucketOf([shot]), config);
    expect('strike' in result.criteria).toBe(false);
  });

  it('startLine: passes inside the stock corridor', () => {
    const shot = buildShot({ launchDirDeg: 2.9, intent: 'stock' });
    const [result] = classifyGreatShots(bucketOf([shot]), config);
    expect(result.criteria.startLine).toBe(true);
  });

  it('startLine: fails outside the stock corridor', () => {
    const shot = buildShot({ launchDirDeg: 4, intent: 'stock' });
    const [result] = classifyGreatShots(bucketOf([shot]), config);
    expect(result.criteria.startLine).toBe(false);
    expect(result.great).toBe(false);
  });

  it('curveDirection: draw corridor requires curveM < 0', () => {
    const key: BucketKey = { clubId: 'sw', intent: 'draw' };
    const pass = buildShot({ intent: 'draw', launchDirDeg: 3, curveM: -5 });
    const fail = buildShot({ intent: 'draw', launchDirDeg: 3, curveM: 5 });
    const results = classifyGreatShots(bucketOf([pass, fail], key), config);
    expect(results[0].criteria.curveDirection).toBe(true);
    expect(results[0].criteria.startLine).toBe(true);
    expect(results[1].criteria.curveDirection).toBe(false);
  });

  it('curveDirection: fade corridor requires curveM > 0', () => {
    const key: BucketKey = { clubId: 'sw', intent: 'fade' };
    const pass = buildShot({ intent: 'fade', launchDirDeg: -3, curveM: 5 });
    const fail = buildShot({ intent: 'fade', launchDirDeg: -3, curveM: -5 });
    const results = classifyGreatShots(bucketOf([pass, fail], key), config);
    expect(results[0].criteria.curveDirection).toBe(true);
    expect(results[1].criteria.curveDirection).toBe(false);
  });

  it("curveDirection: 'either' (stock) always passes regardless of sign", () => {
    const shot = buildShot({ intent: 'stock', curveM: 500 });
    const [result] = classifyGreatShots(bucketOf([shot]), config);
    expect(result.criteria.curveDirection).toBe(true);
  });

  it('curveDirection: absent when curveM is null', () => {
    const shot = buildShot({ curveM: null });
    const [result] = classifyGreatShots(bucketOf([shot]), config);
    expect('curveDirection' in result.criteria).toBe(false);
  });

  it('carryWindow: absent when bucket has fewer than 5 non-null carries', () => {
    const shots = [buildShot({ carryM: 50 }), buildShot({ carryM: 50 })];
    const results = classifyGreatShots(bucketOf(shots), config);
    for (const r of results) expect('carryWindow' in r.criteria).toBe(false);
  });

  it('carryWindow: passes within ±carryWindowPct of the bucket median', () => {
    // median of [48, 49, 50, 51, 52] = 50; window = 50 * 0.07 = 3.5 -> [46.5, 53.5]
    const shots = [48, 49, 50, 51, 52].map((carryM) => buildShot({ carryM }));
    const results = classifyGreatShots(bucketOf(shots), config);
    for (const r of results) expect(r.criteria.carryWindow).toBe(true);
  });

  it('carryWindow: fails outside ±carryWindowPct of the bucket median', () => {
    const shots = [48, 49, 50, 51, 60].map((carryM) => buildShot({ carryM }));
    const results = classifyGreatShots(bucketOf(shots), config);
    // median is 50; 60 is outside [46.5, 53.5]
    expect(results[4].criteria.carryWindow).toBe(false);
    expect(results[4].great).toBe(false);
  });

  it('carryWindow: absent for a shot missing its own carryM even if the bucket qualifies', () => {
    const shots = [
      buildShot({ carryM: 48 }),
      buildShot({ carryM: 49 }),
      buildShot({ carryM: 50 }),
      buildShot({ carryM: 51 }),
      buildShot({ carryM: null }),
    ];
    const results = classifyGreatShots(bucketOf(shots), config);
    expect('carryWindow' in results[4].criteria).toBe(false);
  });

  it('lefty mirroring: draw corridor [0.5, 6] mirrors to [-6, -0.5] and direction flips to right', () => {
    const key: BucketKey = { clubId: 'sw', intent: 'draw' };
    const shot = buildShot({
      intent: 'draw',
      handedness: 'left',
      launchDirDeg: -3, // inside mirrored [-6, -0.5]
      curveM: 5, // mirrored direction is 'right' -> curveM > 0 passes
    });
    const [result] = classifyGreatShots(bucketOf([shot], key), config);
    expect(result.criteria.startLine).toBe(true);
    expect(result.criteria.curveDirection).toBe(true);
  });

  it('lefty mirroring: fade corridor [-6, -0.5] mirrors to [0.5, 6] and direction flips to left', () => {
    const key: BucketKey = { clubId: 'sw', intent: 'fade' };
    const shot = buildShot({
      intent: 'fade',
      handedness: 'left',
      launchDirDeg: 3, // inside mirrored [0.5, 6]
      curveM: -5, // mirrored direction is 'left' -> curveM < 0 passes
    });
    const [result] = classifyGreatShots(bucketOf([shot], key), config);
    expect(result.criteria.startLine).toBe(true);
    expect(result.criteria.curveDirection).toBe(true);
  });

  it('lefty mirroring: a right-handed-corridor pass becomes a fail for a lefty at the same raw angle', () => {
    const key: BucketKey = { clubId: 'sw', intent: 'draw' };
    // +3 deg is inside the RH draw corridor [0.5, 6] but outside the mirrored
    // LH corridor [-6, -0.5].
    const shot = buildShot({ intent: 'draw', handedness: 'left', launchDirDeg: 3 });
    const [result] = classifyGreatShots(bucketOf([shot], key), config);
    expect(result.criteria.startLine).toBe(false);
  });

  it('putter: never great, criteria empty, regardless of otherwise-perfect stats', () => {
    const shot = buildShot({ clubCategory: 'putter', clubId: 'putter' });
    const key: BucketKey = { clubId: 'putter', intent: 'stock' };
    const [result] = classifyGreatShots(bucketOf([shot], key), config);
    expect(result.great).toBe(false);
    expect(result.criteria).toEqual({});
    expect(result.lowSmashCause).toBeNull();
  });

  it('untagged bucket: quarantined -- every shot great=false with empty criteria', () => {
    const key: BucketKey = { clubId: 'sw', intent: 'untagged' };
    const shots = [
      buildShot({ intent: 'untagged' }),
      buildShot({ intent: 'untagged', smash: 0.1, launchDirDeg: 90 }),
    ];
    const results = classifyGreatShots(bucketOf(shots, key), config);
    for (const r of results) {
      expect(r.great).toBe(false);
      expect(r.criteria).toEqual({});
      expect(r.lowSmashCause).toBeNull();
    }
  });

  describe('lowSmashCause', () => {
    it("'contact': strike available and off-center beyond strikeContactMm", () => {
      const shot = buildShot({
        smash: 1.0, // fails
        strikeHMm: 12,
        strikeVMm: 12, // dist ~= 16.97 > strikeContactMm (15)
        flipFlag: true,
      });
      const [result] = classifyGreatShots(bucketOf([shot]), config);
      expect(result.criteria.smash).toBe(false);
      expect(result.lowSmashCause).toBe('contact');
    });

    it("'delivery': strike available, centered, and flipFlag true", () => {
      const shot = buildShot({
        smash: 1.0,
        strikeHMm: 2,
        strikeVMm: 2, // dist ~= 2.83 <= 15, centered
        flipFlag: true,
      });
      const [result] = classifyGreatShots(bucketOf([shot]), config);
      expect(result.lowSmashCause).toBe('delivery');
    });

    it("'ambiguous': strike available, centered, flipFlag not true", () => {
      const shot = buildShot({
        smash: 1.0,
        strikeHMm: 2,
        strikeVMm: 2,
        flipFlag: false,
      });
      const [result] = classifyGreatShots(bucketOf([shot]), config);
      expect(result.lowSmashCause).toBe('ambiguous');
    });

    it("'ambiguous': strike unavailable entirely", () => {
      const shot = buildShot({
        smash: 1.0,
        strikeHMm: null,
        strikeVMm: null,
        flipFlag: true,
      });
      const [result] = classifyGreatShots(bucketOf([shot]), config);
      expect(result.lowSmashCause).toBe('ambiguous');
    });

    it('is null when smash is not evaluable (missing data)', () => {
      const shot = buildShot({ smash: null, strikeHMm: 20, strikeVMm: 20 });
      const [result] = classifyGreatShots(bucketOf([shot]), config);
      expect(result.lowSmashCause).toBeNull();
    });

    it('is null when smash passes', () => {
      const shot = buildShot({ smash: 1.3, strikeHMm: 20, strikeVMm: 20 });
      const [result] = classifyGreatShots(bucketOf([shot]), config);
      expect(result.criteria.smash).toBe(true);
      expect(result.lowSmashCause).toBeNull();
    });
  });
});

describe('greatShots', () => {
  it('returns only the shots classified as great, preserving bucket order', () => {
    const shots = [
      buildShot({ smash: 1.3 }), // great
      buildShot({ smash: 0.5 }), // fails smash
      buildShot({ smash: 1.3 }), // great
    ];
    const result = greatShots(bucketOf(shots), config);
    expect(result.map((s) => s.id)).toEqual([shots[0].id, shots[2].id]);
  });

  it('returns an empty array for an untagged bucket', () => {
    const key: BucketKey = { clubId: 'sw', intent: 'untagged' };
    const shots = [buildShot({ intent: 'untagged' })];
    expect(greatShots(bucketOf(shots, key), config)).toEqual([]);
  });

  it('never includes putter shots', () => {
    const key: BucketKey = { clubId: 'putter', intent: 'stock' };
    const shots = [buildShot({ clubCategory: 'putter', clubId: 'putter' })];
    expect(greatShots(bucketOf(shots, key), config)).toEqual([]);
  });
});
