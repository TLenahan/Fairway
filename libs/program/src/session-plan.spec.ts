import {
  BucketInsights,
  Finding,
  InsightShot,
  analyzeShots,
} from '@golf/insights';
import { TrainingBlock } from '@golf/types';

import { findingKey } from './prescribe';
import {
  SessionPlanInput,
  parseFindingKey,
  planTrainingBlocks,
} from './session-plan';

/* ── hand-built fixtures ─────────────────────────────────────────────────── */

/**
 * A wedge shot with every metric pinned to a constant. Fixtures below vary
 * ONE metric at a time, so every median, effect size and correlation the
 * engine computes is reproducible with a pencil.
 */
function shot(over: Partial<InsightShot> = {}): InsightShot {
  return {
    id: 'shot',
    sessionId: 'sess-1',
    clubId: 'sw',
    clubCategory: 'wedge',
    intent: 'stock',
    warmup: false,
    discarded: false,
    ts: 1_000,
    handedness: 'right',
    smash: 1.3, // wedge ceiling 1.25 × 0.96 = 1.20 → great; × 0.9 → no low-smash
    ballSpeedMs: 40,
    clubSpeedMs: 30,
    launchDeg: 30,
    launchDirDeg: 0,
    backspinRpm: 8_000,
    sidespinRpm: 0,
    carryM: 80,
    totalM: 82,
    apexM: 20,
    offlineM: 0,
    curveM: 0,
    strikeHMm: null, // no strike data → the strike criterion is not evaluated
    strikeVMm: null,
    flipFlag: null,
    wristExtTop: null,
    wristExtImpact: null,
    wristExtPeakDown: null,
    ...over,
  };
}

const CATEGORIES = new Map<string, InsightShot['clubCategory']>([
  ['sw', 'wedge'],
  ['gw', 'wedge'],
  ['7i', 'iron'],
]);

function planInput(
  shots: readonly InsightShot[],
  over: Partial<SessionPlanInput> = {},
): SessionPlanInput {
  return {
    report: analyzeShots(shots),
    shots,
    clubCategories: CATEGORIES,
    existing: [],
    now: 5_000,
    ...over,
  };
}

/**
 * One bucket's worth of history: 14 good shots carrying 80 m and 8 short ones
 * carrying 66 m, the short set split across two sessions so it clears the
 * persistence guardrail.
 *
 * The bucket carry median is 80 (the 11th and 12th of 22 sorted carries are
 * both 80), which puts every 80 inside the ±7% great window and every 66
 * below the −8% short threshold. So: 14 great shots, 8 'short' shots, and no
 * other failure mode anywhere in the bucket.
 *
 * `vary` supplies the one metric that separates the two groups — that is the
 * only thing the engine can find, which keeps each bucket to exactly one
 * finding.
 */
function bucketHistory(
  clubId: string,
  vary: (index: number, group: 'good' | 'short') => Partial<InsightShot>,
): InsightShot[] {
  const shots: InsightShot[] = [];
  for (let i = 0; i < 14; i += 1) {
    shots.push(
      shot({
        id: `${clubId}-good-${i}`,
        clubId,
        sessionId: i < 7 ? 'sess-1' : 'sess-2',
        ts: 1_000 + i,
        carryM: 80,
        ...vary(i, 'good'),
      }),
    );
  }
  for (let i = 0; i < 8; i += 1) {
    shots.push(
      shot({
        id: `${clubId}-short-${i}`,
        clubId,
        sessionId: i < 4 ? 'sess-1' : 'sess-2',
        ts: 2_000 + i,
        carryM: 66,
        ...vary(i, 'short'),
      }),
    );
  }
  return shots;
}

/**
 * sw: club speed is what separates short shots from good ones (29/30/31 vs a
 * flat 26), and offline scatter tracks club-speed scatter — |Δ club speed|
 * against |Δ offline| correlates at r ≈ 0.84, well past the 0.4 bar. So
 * clubSpeedMs is a VARIANCE DRIVER and the 'short' finding on it earns a drill.
 */
const VARIANCE_DRIVER_HISTORY = bucketHistory('sw', (i, group) =>
  group === 'good'
    ? { clubSpeedMs: 29 + (i % 3), offlineM: ((i % 3) - 1) * 0.5 }
    : { clubSpeedMs: 26, offlineM: i % 2 === 0 ? 8 : -8 },
);

/**
 * gw: start line is what separates the two groups (1.7/2.0/2.3° vs a flat
 * 3.5°) — a systematic rightward offset, mean 2.53° against sd 0.77°, so
 * launchDirDeg classifies as BIAS. Everything else in the bucket is constant.
 *
 * The finding is just as real as sw's and the baseline would band it cleanly
 * (great-shot launchDirDeg IQR 0.525); §6.6 is the only thing standing between
 * it and a drill. 3.5° also stays inside the push margin (3° + 1°), so 'short'
 * remains the bucket's only failure mode.
 */
const BIAS_HISTORY = bucketHistory('gw', (i, group) =>
  group === 'good'
    ? { launchDirDeg: 2 + ((i % 3) - 1) * 0.3 }
    : { launchDirDeg: 3.5 },
);

function bucketOf(
  buckets: readonly BucketInsights[],
  clubId: string,
): BucketInsights {
  const found = buckets.find((b) => b.key.clubId === clubId);
  if (found === undefined) throw new Error(`fixture has no ${clubId} bucket`);
  return found;
}

function trainingBlock(over: Partial<TrainingBlock> = {}): TrainingBlock {
  return {
    id: 'block-1',
    source: 'finding',
    findingKey: 'sw|stock|short|clubSpeedMs',
    drillId: 'tempo-ladder',
    drillVersion: 1,
    clubId: 'sw',
    intent: 'stock',
    tolerance: { metric: 'clubSpeedMs', center: 30, halfWidth: 2, nGreat: 12 },
    remeasureShots: 5,
    status: 'active',
    startedAt: 1_000,
    resolvedAt: null,
    resolutionNote: null,
    createdAt: 1_000,
    ...over,
  };
}

/**
 * A bucket straddling a block issued at ts 1000: four shots at or before it
 * (two of them short → rate 0.50) and six after (none short → rate 0.00).
 *
 * The 1000 shot is short and sits exactly on the boundary, so treating it as
 * "since" instead of "before" would visibly move both rates. Warmup,
 * discarded and other-club shots are short too and must not count at all.
 * Carry median over the ten qualifying shots is 80 → short below 73.6 m.
 */
const REMEASURE_HISTORY: InsightShot[] = [
  shot({ id: 'before-1', ts: 700, carryM: 60, clubSpeedMs: 26 }),
  shot({ id: 'before-2', ts: 800, carryM: 80, clubSpeedMs: 26 }),
  shot({ id: 'before-3', ts: 900, carryM: 80, clubSpeedMs: 26 }),
  shot({ id: 'before-4', ts: 1_000, carryM: 60, clubSpeedMs: 26 }),
  ...Array.from({ length: 6 }, (_, i) =>
    shot({ id: `since-${i}`, ts: 1_100 + i, carryM: 80, clubSpeedMs: 31 }),
  ),
  shot({ id: 'warmup', ts: 1_200, carryM: 60, clubSpeedMs: 26, warmup: true }),
  shot({ id: 'binned', ts: 1_300, carryM: 60, clubSpeedMs: 26, discarded: true }),
  shot({ id: 'other-club', ts: 1_400, clubId: '7i', clubCategory: 'iron', carryM: 60 }),
];

/* ── parseFindingKey ─────────────────────────────────────────────────────── */

describe('parseFindingKey', () => {
  it('round-trips whatever findingKey produced', () => {
    const finding = (over: Partial<Finding>): Finding => ({
      key: { clubId: '9f8c2b1a-0000-4000-8000-000000000001', intent: 'stock' },
      failureMode: 'short',
      metric: 'clubSpeedMs',
      effectSize: -0.9,
      direction: 'lower',
      pApprox: 0.01,
      sessionsSeen: 2,
      counts: { bad: 8, great: 12, badBeyondGreatRange: 6 },
      firstSeenTs: 1,
      lastSeenTs: 2,
      ...over,
    });

    const cases: Finding[] = [
      finding({}),
      finding({ key: { clubId: 'sw', intent: 'draw' }, failureMode: 'over-curve', metric: 'curveM' }),
      finding({ key: { clubId: 'sw', intent: 'fade' }, failureMode: 'low-smash', metric: 'strikeHMm' }),
      finding({ failureMode: 'under-curve', metric: 'wristExtPeakDown' }),
    ];

    for (const f of cases) {
      expect(parseFindingKey(findingKey(f))).toEqual({
        clubId: f.key.clubId,
        intent: f.key.intent,
        failureMode: f.failureMode,
        metric: f.metric,
      });
    }
  });

  it.each([
    ['too few segments', 'sw|stock|short'],
    ['too many segments', 'sw|stock|short|carryM|extra'],
    ['empty string', ''],
    ['empty clubId', '|stock|short|carryM'],
    ['bad intent', 'sw|chip|short|carryM'],
    ['bad failure mode', 'sw|stock|sliced|carryM'],
    ['bad metric', 'sw|stock|short|carryYards'],
    ['an inherited property name', 'sw|stock|toString|carryM'],
  ])('returns null on %s rather than throwing', (_label, key) => {
    expect(parseFindingKey(key)).toBeNull();
  });
});

/* ── planTrainingBlocks: prescription ────────────────────────────────────── */

describe('planTrainingBlocks — prescription', () => {
  it('prescribes against the finding whose metric drives variance', () => {
    const plan = planTrainingBlocks(planInput(VARIANCE_DRIVER_HISTORY));

    // Great-shot clubSpeedMs is 29×5, 30×5, 31×4 → median 30, IQR 1.75.
    // tempo-ladder is the only 'short' drill targeting clubSpeedMs, and bands
    // on it at iqrMultiple 1.
    expect(plan.prescribe).toEqual([
      {
        source: 'finding',
        findingKey: 'sw|stock|short|clubSpeedMs',
        drillId: 'tempo-ladder',
        drillVersion: 1,
        clubId: 'sw',
        intent: 'stock',
        tolerance: {
          metric: 'clubSpeedMs',
          center: 30,
          halfWidth: 1.75,
          nGreat: 14,
        },
        remeasureShots: 27,
        status: 'active',
        startedAt: 5_000,
        resolvedAt: null,
        resolutionNote: null,
      },
    ]);
    expect(plan.verdicts).toEqual([]);
  });

  describe('§6.6 — a pure bias never earns a drill', () => {
    const plan = planTrainingBlocks(planInput(BIAS_HISTORY));
    const report = analyzeShots(BIAS_HISTORY);

    it('finds the bias and bands it, but prescribes nothing', () => {
      // The finding is real and the baseline could band it — the ONLY reason
      // no block comes out is that launchDirDeg is a systematic offset.
      expect(report.findings.map(findingKey)).toEqual([
        'gw|stock|short|launchDirDeg',
      ]);
      const bucket = bucketOf(report.buckets, 'gw');
      expect(
        bucket.biasVariance.find((e) => e.metric === 'launchDirDeg')
          ?.classification,
      ).toBe('bias');
      expect(bucket.reference?.perMetric.launchDirDeg?.iqr).toBeGreaterThan(0);

      expect(plan.prescribe).toEqual([]);
    });
  });

  it('keeps the two apart in one pass over a mixed history', () => {
    const shots = [...VARIANCE_DRIVER_HISTORY, ...BIAS_HISTORY];
    const plan = planTrainingBlocks(planInput(shots));

    // Both findings reach prescribe(); only the variance-driven one survives.
    expect(analyzeShots(shots).findings.map(findingKey)).toEqual([
      'gw|stock|short|launchDirDeg',
      'sw|stock|short|clubSpeedMs',
    ]);
    expect(plan.prescribe.map((b) => b.findingKey)).toEqual([
      'sw|stock|short|clubSpeedMs',
    ]);
  });

  it('does not re-prescribe a finding an existing block already carries', () => {
    const plan = planTrainingBlocks(
      planInput(VARIANCE_DRIVER_HISTORY, {
        existing: [trainingBlock({ remeasureShots: 27 })],
      }),
    );
    expect(plan.prescribe).toEqual([]);
  });
});

/* ── planTrainingBlocks: verdicts ────────────────────────────────────────── */

describe('planTrainingBlocks — verdicts', () => {
  const judge = (block: TrainingBlock) =>
    planTrainingBlocks(
      planInput(REMEASURE_HISTORY, { existing: [block] }),
    ).verdicts;

  it('splits the bucket at the block\'s issue time and judges both windows', () => {
    const verdicts = judge(trainingBlock());
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].block.id).toBe('block-1');

    const verdict = verdicts[0].verdict;
    // Six shots since issue clear the 5-shot window; their clubSpeedMs median
    // of 31 sits inside the band [28, 32].
    expect(verdict.status).toBe('graduated');
    expect(verdict.note).toContain('clubSpeedMs median 31.00');
    expect(verdict.note).toContain('band [28.00, 32.00]');
    // 2 short of 4 before (the boundary shot at ts 1000 counts as before),
    // 0 of 6 after — warmup, discarded and other-club shots excluded.
    expect(verdict.note).toContain(
      'failure-mode rate 0.50 -> 0.00 — 1.00 closed, 0.25 required',
    );
  });

  it('reports an open window as active rather than judging it early', () => {
    const verdict = judge(trainingBlock({ remeasureShots: 20 }))[0].verdict;
    expect(verdict.status).toBe('active');
    expect(verdict.note).toContain('6 of 20 qualifying shots');
  });

  it('orders verdicts by block id, independent of input order', () => {
    const blocks = [
      trainingBlock({ id: 'z-block' }),
      trainingBlock({
        id: 'a-block',
        findingKey: 'sw|stock|low-smash|clubSpeedMs',
      }),
    ];
    const verdicts = planTrainingBlocks(
      planInput(REMEASURE_HISTORY, { existing: blocks }),
    ).verdicts;
    expect(verdicts.map((v) => v.block.id)).toEqual(['a-block', 'z-block']);
  });

  it('judges only live blocks', () => {
    for (const status of ['graduated', 'escalated', 'abandoned'] as const) {
      expect(judge(trainingBlock({ status }))).toEqual([]);
    }
  });

  describe('a block it cannot understand is left alone, not escalated', () => {
    it.each([
      ['a malformed findingKey', trainingBlock({ findingKey: 'sw|stock|short' })],
      ['a legacy findingKey', trainingBlock({ findingKey: 'sw|stock|thin|carryYards' })],
      ['no findingKey at all', trainingBlock({ source: 'program', findingKey: null })],
      ['a drill the library has retired', trainingBlock({ drillId: 'gone-drill' })],
      ['no bucket to re-measure', trainingBlock({ clubId: null, intent: null })],
    ])('skips %s without throwing', (_label, block) => {
      expect(() => judge(block)).not.toThrow();
      expect(judge(block)).toEqual([]);
    });
  });

  it('carries the block through untouched alongside its verdict', () => {
    const block = trainingBlock();
    expect(judge(block)[0].block).toBe(block);
  });
});
