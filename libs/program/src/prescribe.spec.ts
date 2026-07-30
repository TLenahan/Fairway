import {
  BucketKey,
  Finding,
  InsightMetricKey,
  InsightShot,
  ReferenceBaseline,
} from '@golf/insights';
import { TrainingBlock } from '@golf/types';

import { Drill } from './drill-content';
import * as library from './library';
import { drillById } from './library';
import { evaluateBlock, findingKey, prescribe, PrescribeInput } from './prescribe';

/* ── hand-built fixtures ─────────────────────────────────────────────────── */

const SW: BucketKey = { clubId: 'sw', intent: 'stock' };

function finding(over: Partial<Finding> = {}): Finding {
  return {
    key: SW,
    failureMode: 'short',
    metric: 'clubSpeedMs',
    effectSize: -0.9,
    direction: 'lower',
    pApprox: 0.01,
    sessionsSeen: 3,
    counts: { bad: 8, great: 12, badBeyondGreatRange: 6 },
    firstSeenTs: 1_000,
    lastSeenTs: 2_000,
    ...over,
  };
}

function reference(
  perMetric: ReferenceBaseline['perMetric'],
  key: BucketKey = SW,
  nGreat = 12,
): ReferenceBaseline {
  return { kind: 'reference', key, nGreat, perMetric };
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
    remeasureShots: 27,
    status: 'active',
    startedAt: 1_000,
    resolvedAt: null,
    resolutionNote: null,
    createdAt: 1_000,
    ...over,
  };
}

function shot(over: Partial<InsightShot> = {}): InsightShot {
  return {
    id: 'shot-1',
    sessionId: 'sess-1',
    clubId: 'sw',
    clubCategory: 'wedge',
    intent: 'stock',
    warmup: false,
    discarded: false,
    ts: 10_000,
    handedness: 'right',
    smash: 1.3,
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
    strikeHMm: 0,
    strikeVMm: 0,
    flipFlag: null,
    wristExtTop: 24,
    wristExtImpact: 5,
    wristExtPeakDown: 10,
    ...over,
  };
}

/** A library drill, unwrapped — a missing id is a test bug, not a null path. */
function libraryDrill(id: string): Drill {
  const drill = drillById(id);
  if (drill === null) throw new Error(`fixture wants missing drill ${id}`);
  return drill;
}

/** Shots that differ only in club speed, so a hand-computed median is the
    only thing an assertion depends on. */
function clubSpeedShots(values: readonly (number | null)[]): InsightShot[] {
  return values.map((value, index) =>
    shot({ id: `shot-${index}`, clubSpeedMs: value }),
  );
}

/** The standard single-finding input: sw/stock, 'short' on clubSpeedMs, a
    wedge, with a clubSpeedMs baseline of median 30 / IQR 2. Overridable
    per test so each case changes exactly one thing. */
function prescribeInput(over: Partial<PrescribeInput> = {}): PrescribeInput {
  return {
    findings: [finding()],
    references: new Map([
      ['sw|stock', reference({ clubSpeedMs: { n: 12, median: 30, iqr: 2 } })],
    ]),
    varianceDrivers: new Map<string, readonly InsightMetricKey[]>([
      ['sw|stock', ['clubSpeedMs']],
    ]),
    clubCategories: new Map<string, InsightShot['clubCategory']>([
      ['sw', 'wedge'],
    ]),
    existing: [],
    now: 5_000,
    ...over,
  };
}

/* ── findingKey ──────────────────────────────────────────────────────────── */

describe('findingKey', () => {
  it('is the four identifying facts, in a fixed order', () => {
    expect(findingKey(finding())).toBe('sw|stock|short|clubSpeedMs');
  });

  it('is stable across rebuilds and ignores the statistics', () => {
    // The engine recomputes effect sizes, p-values and timestamps every pass;
    // a block must still recognise its finding afterwards.
    expect(
      findingKey(
        finding({
          effectSize: -2.4,
          pApprox: 0.0001,
          sessionsSeen: 9,
          counts: { bad: 40, great: 60, badBeyondGreatRange: 33 },
          firstSeenTs: 99,
          lastSeenTs: 999_999,
        }),
      ),
    ).toBe(findingKey(finding()));
  });

  it('separates club, intent, failure mode and metric', () => {
    expect(findingKey(finding({ key: { clubId: '7i', intent: 'stock' } }))).toBe(
      '7i|stock|short|clubSpeedMs',
    );
    expect(findingKey(finding({ key: { clubId: 'sw', intent: 'draw' } }))).toBe(
      'sw|draw|short|clubSpeedMs',
    );
    expect(findingKey(finding({ failureMode: 'long' }))).toBe(
      'sw|stock|long|clubSpeedMs',
    );
    expect(findingKey(finding({ metric: 'smash' }))).toBe(
      'sw|stock|short|smash',
    );
  });
});

/* ── prescribe ───────────────────────────────────────────────────────────── */

describe('prescribe', () => {
  it('issues a block against the drill and the user\'s own band', () => {
    // 'short' + wedge matches wedge-distance-control, flexion-through-impact
    // and tempo-ladder; only tempo-ladder targets clubSpeedMs. Its tolerance
    // is clubSpeedMs at iqrMultiple 1, so halfWidth = 1 * 2 = 2.
    expect(prescribe(prescribeInput())).toEqual([
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
          halfWidth: 2,
          nGreat: 12,
        },
        remeasureShots: 27,
        status: 'active',
        startedAt: 5_000,
        resolvedAt: null,
        resolutionNote: null,
      },
    ]);
  });

  describe('§6.6 — a bias never earns a drill', () => {
    // A 'pull' on launchDirDeg with a real baseline behind it: start-line-gate
    // addresses pull, targets launchDirDeg and would band cleanly. The ONLY
    // thing that decides the outcome here is whether launchDirDeg is a
    // variance driver in that bucket.
    const pull = finding({ failureMode: 'pull', metric: 'launchDirDeg' });
    const refs = new Map([
      ['sw|stock', reference({ launchDirDeg: { n: 12, median: -1.5, iqr: 0.8 } })],
    ]);

    it('skips a systematic offset — that is an aim/setup note', () => {
      const blocks = prescribe(
        prescribeInput({
          findings: [pull],
          references: refs,
          varianceDrivers: new Map<string, readonly InsightMetricKey[]>([
            ['sw|stock', ['clubSpeedMs', 'wristExtTop']],
          ]),
        }),
      );
      expect(blocks).toEqual([]);
    });

    it('prescribes the same finding once the metric drives variance', () => {
      const blocks = prescribe(
        prescribeInput({
          findings: [pull],
          references: refs,
          varianceDrivers: new Map<string, readonly InsightMetricKey[]>([
            ['sw|stock', ['clubSpeedMs', 'launchDirDeg']],
          ]),
        }),
      );
      expect(blocks).toHaveLength(1);
      expect(blocks[0].drillId).toBe('start-line-gate');
      expect(blocks[0].tolerance).toEqual({
        metric: 'launchDirDeg',
        center: -1.5,
        halfWidth: 0.8, // iqrMultiple 1
        nGreat: 12,
      });
    });

    it('skips when the bucket has no variance classification at all', () => {
      expect(
        prescribe(prescribeInput({ varianceDrivers: new Map() })),
      ).toEqual([]);
    });
  });

  describe('never double-prescribes a covered finding', () => {
    it.each(['active', 'graduated', 'escalated'] as const)(
      'skips a finding already carried by a %s block',
      (status) => {
        expect(
          prescribe(
            prescribeInput({ existing: [trainingBlock({ status })] }),
          ),
        ).toEqual([]);
      },
    );

    it('re-prescribes once the covering block is abandoned', () => {
      const blocks = prescribe(
        prescribeInput({
          existing: [trainingBlock({ status: 'abandoned' })],
        }),
      );
      expect(blocks.map((b) => b.findingKey)).toEqual([
        'sw|stock|short|clubSpeedMs',
      ]);
    });

    it('ignores blocks carrying a different finding, and program blocks', () => {
      const blocks = prescribe(
        prescribeInput({
          existing: [
            trainingBlock({ id: 'other', findingKey: 'sw|stock|long|carryM' }),
            trainingBlock({ id: 'program', source: 'program', findingKey: null }),
          ],
        }),
      );
      expect(blocks).toHaveLength(1);
    });

    it('emits one block even when the same finding arrives twice', () => {
      expect(
        prescribe(prescribeInput({ findings: [finding(), finding()] })),
      ).toHaveLength(1);
    });
  });

  it('skips a finding no drill in the library addresses', () => {
    // Every failure mode in the shipped content currently has an all-club
    // drill, so this guard is unreachable against real content — it is stubbed
    // here so a future content edit that orphans a mode cannot slip through
    // as an exception at prescription time.
    const spy = jest
      .spyOn(library, 'drillsForFailureMode')
      .mockReturnValue([]);
    try {
      expect(prescribe(prescribeInput())).toEqual([]);
      expect(spy).toHaveBeenCalledWith('short', 'wedge');
    } finally {
      spy.mockRestore();
    }
  });

  describe('no baseline-derived band means no prescription (§6.10)', () => {
    it('skips when the bucket has no reference baseline', () => {
      expect(prescribe(prescribeInput({ references: new Map() }))).toEqual([]);
    });

    it('skips when the baseline says nothing about the drill\'s band metric', () => {
      // tempo-ladder bands on clubSpeedMs; a carry-only baseline cannot supply
      // that band without inventing a constant.
      expect(
        prescribe(
          prescribeInput({
            references: new Map([
              ['sw|stock', reference({ carryM: { n: 12, median: 80, iqr: 5 } })],
            ]),
          }),
        ),
      ).toEqual([]);
    });

    it('skips on a degenerate IQR rather than issuing a zero-width band', () => {
      expect(
        prescribe(
          prescribeInput({
            references: new Map([
              ['sw|stock', reference({ clubSpeedMs: { n: 12, median: 30, iqr: 0 } })],
            ]),
          }),
        ),
      ).toEqual([]);
    });
  });

  describe('drill choice', () => {
    // 'low-smash' on an iron matches flexion-through-impact, strike-centering
    // and tempo-ladder — all three are all-club drills.
    const lowSmash = (metric: InsightMetricKey): PrescribeInput =>
      prescribeInput({
        findings: [
          finding({
            key: { clubId: '7i', intent: 'stock' },
            failureMode: 'low-smash',
            metric,
          }),
        ],
        references: new Map([
          [
            '7i|stock',
            reference(
              {
                strikeHMm: { n: 12, median: 1, iqr: 4 },
                wristExtPeakDown: { n: 12, median: 10, iqr: 3 },
                clubSpeedMs: { n: 12, median: 33, iqr: 2 },
              },
              { clubId: '7i', intent: 'stock' },
            ),
          ],
        ]),
        varianceDrivers: new Map<string, readonly InsightMetricKey[]>([
          ['7i|stock', ['smash', 'clubSpeedMs', 'launchDeg']],
        ]),
        clubCategories: new Map<string, InsightShot['clubCategory']>([
          ['7i', 'iron'],
        ]),
      });

    it('prefers a drill that targets the finding\'s metric', () => {
      // smash -> strike-centering, even though flexion-through-impact sorts
      // first by id.
      expect(prescribe(lowSmash('smash')).map((b) => b.drillId)).toEqual([
        'strike-centering',
      ]);
      // clubSpeedMs -> tempo-ladder, which sorts last by id.
      expect(prescribe(lowSmash('clubSpeedMs')).map((b) => b.drillId)).toEqual([
        'tempo-ladder',
      ]);
    });

    it('breaks ties on drill id when nothing targets the metric', () => {
      // No low-smash drill targets launchDeg, so id order decides:
      // flexion-through-impact < strike-centering < tempo-ladder.
      const blocks = prescribe(lowSmash('launchDeg'));
      expect(blocks.map((b) => b.drillId)).toEqual(['flexion-through-impact']);
      expect(blocks[0].tolerance).toEqual({
        metric: 'wristExtPeakDown',
        center: 10,
        halfWidth: 3,
        nGreat: 12,
      });
    });
  });

  it('orders output by findingKey, independent of input order', () => {
    const sevenIron = finding({
      key: { clubId: '7i', intent: 'stock' },
      failureMode: 'low-smash',
      metric: 'smash',
    });
    const wedgeDraw = finding({
      key: { clubId: 'sw', intent: 'draw' },
      failureMode: 'under-curve',
      metric: 'clubSpeedMs',
    });
    const wedgeStock = finding();

    const input = (findings: readonly Finding[]): PrescribeInput =>
      prescribeInput({
        findings,
        references: new Map([
          [
            '7i|stock',
            reference(
              { strikeHMm: { n: 12, median: 1, iqr: 4 } },
              { clubId: '7i', intent: 'stock' },
            ),
          ],
          [
            'sw|draw',
            reference(
              { curveM: { n: 10, median: -1, iqr: 2 } },
              { clubId: 'sw', intent: 'draw' },
              10,
            ),
          ],
          ['sw|stock', reference({ clubSpeedMs: { n: 12, median: 30, iqr: 2 } })],
        ]),
        varianceDrivers: new Map<string, readonly InsightMetricKey[]>([
          ['7i|stock', ['smash']],
          ['sw|draw', ['clubSpeedMs']],
          ['sw|stock', ['clubSpeedMs']],
        ]),
        clubCategories: new Map<string, InsightShot['clubCategory']>([
          ['7i', 'iron'],
          ['sw', 'wedge'],
        ]),
      });

    const expected = [
      '7i|stock|low-smash|smash',
      'sw|draw|under-curve|clubSpeedMs',
      'sw|stock|short|clubSpeedMs',
    ];

    expect(
      prescribe(input([wedgeStock, wedgeDraw, sevenIron])).map(
        (b) => b.findingKey,
      ),
    ).toEqual(expected);
    expect(
      prescribe(input([sevenIron, wedgeStock, wedgeDraw])).map(
        (b) => b.findingKey,
      ),
    ).toEqual(expected);
  });
});

/* ── evaluateBlock ───────────────────────────────────────────────────────── */

describe('evaluateBlock', () => {
  // tempo-ladder: remeasureShots 27, metricGapClosed 0.5, outcomeImprovement
  // 0.25, banded on clubSpeedMs. Block band: centre 30 ± 2 -> [28, 32], so a
  // median may sit at most 2 * (1 - 0.5) = 1.00 outside an edge.
  const tempoLadder = libraryDrill('tempo-ladder');
  const block = trainingBlock();

  const evaluate = (
    values: readonly (number | null)[],
    before: number,
    after: number,
  ) =>
    evaluateBlock({
      block,
      shotsSince: clubSpeedShots(values),
      failureModeRateBefore: before,
      failureModeRateAfter: after,
      drill: tempoLadder,
    });

  const repeat = (value: number | null, n: number): (number | null)[] =>
    Array.from({ length: n }, () => value);

  it('stays active while the re-measure window is still open', () => {
    const verdict = evaluate(repeat(31, 26), 0.4, 0.4);
    expect(verdict.status).toBe('active');
    expect(verdict.note).toContain('26 of 27');
  });

  it('graduates when the metric is in the band and the outcome improved', () => {
    // median 31 -> inside [28, 32], gap 0. Rate 0.40 -> 0.20 is 0.50 closed,
    // clear of the 0.25 required.
    const verdict = evaluate(repeat(31, 27), 0.4, 0.2);
    expect(verdict.status).toBe('graduated');
    expect(verdict.note).toContain('clubSpeedMs median 31.00');
    expect(verdict.note).toContain('band [28.00, 32.00]');
    expect(verdict.note).toContain('gap 0.00, allowed 1.00');
    expect(verdict.note).toContain('0.40 -> 0.20 — 0.50 closed, 0.25 required');
  });

  it('graduates on a partially closed gap that clears the allowance', () => {
    // median 32.5 -> 0.50 outside the upper edge, within the 1.00 allowed.
    const verdict = evaluate(repeat(32.5, 27), 0.4, 0.1);
    expect(verdict.status).toBe('graduated');
    expect(verdict.note).toContain('gap 0.50, allowed 1.00');
  });

  it('escalates when the metric moved but the outcome did not', () => {
    // median 31 (gap 0), but 0.40 -> 0.35 closes only 0.125 of the rate.
    const verdict = evaluate(repeat(31, 27), 0.4, 0.35);
    expect(verdict.status).toBe('escalated');
    expect(verdict.note).toContain('Escalated (outcome did not improve)');
    expect(verdict.note).toContain('0.40 -> 0.35 — 0.13 closed, 0.25 required');
  });

  it('escalates when the outcome improved but the metric did not', () => {
    // median 34 -> 2.00 outside the upper edge, twice the 1.00 allowed, even
    // though the rate went to zero.
    const verdict = evaluate(repeat(34, 27), 0.4, 0);
    expect(verdict.status).toBe('escalated');
    expect(verdict.note).toContain('Escalated (metric did not move)');
    expect(verdict.note).toContain('gap 2.00, allowed 1.00');
  });

  it('names both conditions when neither held', () => {
    const verdict = evaluate(repeat(25, 27), 0.4, 0.4);
    expect(verdict.status).toBe('escalated');
    expect(verdict.note).toContain(
      'metric did not move and outcome did not improve',
    );
    // median 25 -> 3.00 below the lower edge 28.
    expect(verdict.note).toContain('gap 3.00, allowed 1.00');
  });

  describe('a zero rate at issue', () => {
    it('counts as improved only while the mode stays absent', () => {
      expect(evaluate(repeat(31, 27), 0, 0).status).toBe('graduated');
    });

    it('is not improved when the mode appeared', () => {
      const verdict = evaluate(repeat(31, 27), 0, 0.1);
      expect(verdict.status).toBe('escalated');
      expect(verdict.note).toContain('no rate at issue');
    });
  });

  describe('missing evidence never escalates', () => {
    it('stays active with fewer than three values of the target metric', () => {
      const values = [30, 31, ...repeat(null, 25)];
      const verdict = evaluate(values, 0.4, 0.4);
      expect(verdict.status).toBe('active');
      expect(verdict.note).toContain(
        'clubSpeedMs has 2 value(s) in the 27 shots since issue (need 3)',
      );
    });

    it('stays active when the block carries no band', () => {
      const verdict = evaluateBlock({
        block: trainingBlock({ tolerance: null }),
        shotsSince: clubSpeedShots(repeat(31, 27)),
        failureModeRateBefore: 0.4,
        failureModeRateAfter: 0,
        drill: tempoLadder,
      });
      expect(verdict.status).toBe('active');
      expect(verdict.note).toContain('no tolerance band');
    });

    it('stays active when the drill is banded on another metric', () => {
      const verdict = evaluateBlock({
        block,
        shotsSince: clubSpeedShots(repeat(31, 27)),
        failureModeRateBefore: 0.4,
        failureModeRateAfter: 0,
        drill: libraryDrill('strike-centering'),
      });
      expect(verdict.status).toBe('active');
      expect(verdict.note).toContain('banded on strikeHMm');
    });
  });

  it('uses the block\'s own remeasure window, not the drill\'s', () => {
    // A block issued against an older drill version keeps the window it was
    // issued with; 10 shots close a 10-shot window even though tempo-ladder
    // now asks for 27.
    const verdict = evaluateBlock({
      block: trainingBlock({ remeasureShots: 10 }),
      shotsSince: clubSpeedShots(repeat(31, 10)),
      failureModeRateBefore: 0.4,
      failureModeRateAfter: 0.1,
      drill: tempoLadder,
    });
    expect(verdict.status).toBe('graduated');
  });
});
