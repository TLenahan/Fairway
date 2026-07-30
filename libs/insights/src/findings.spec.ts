import { DEFAULT_INSIGHTS_CONFIG } from './config';
import { detectFindings, labelFailureModes } from './findings';
import { InsightShot } from './types';

const config = DEFAULT_INSIGHTS_CONFIG;

let counter = 0;

/** A neutral wedge/stock shot that triggers no failure mode by default;
    tests override only the fields under test. */
function buildShot(overrides: Partial<InsightShot> = {}): InsightShot {
  counter += 1;
  return {
    id: `shot-${counter}`,
    sessionId: 'session-1',
    clubId: 'pw',
    clubCategory: 'wedge',
    intent: 'stock',
    warmup: false,
    discarded: false,
    ts: 1000 + counter,
    handedness: 'right',
    smash: 1.3, // above wedge low-smash floor 1.25 * 0.9 = 1.125
    ballSpeedMs: 30,
    clubSpeedMs: 25,
    launchDeg: 30,
    launchDirDeg: 0, // inside stock corridor [-3, 3]
    backspinRpm: 6000,
    sidespinRpm: 0,
    carryM: null,
    totalM: null,
    apexM: null,
    offlineM: null,
    curveM: null,
    strikeHMm: null,
    strikeVMm: null,
    flipFlag: null,
    wristExtTop: null,
    wristExtImpact: null,
    wristExtPeakDown: null,
    ...overrides,
  };
}

describe('labelFailureModes', () => {
  it('pull: start line below corridor lo minus margin (righty stock: < -4)', () => {
    expect(labelFailureModes(buildShot({ launchDirDeg: -4.5 }), null, config)).toEqual(['pull']);
    // within the margin band: corridor edge -3, margin 1
    expect(labelFailureModes(buildShot({ launchDirDeg: -3.5 }), null, config)).toEqual([]);
    // exactly at lo - margin is not beyond it
    expect(labelFailureModes(buildShot({ launchDirDeg: -4 }), null, config)).toEqual([]);
  });

  it('push: start line above corridor hi plus margin (righty stock: > 4)', () => {
    expect(labelFailureModes(buildShot({ launchDirDeg: 4.5 }), null, config)).toEqual(['push']);
    expect(labelFailureModes(buildShot({ launchDirDeg: 4 }), null, config)).toEqual([]);
  });

  it('pull/push mirror through the corridor for left-handers (fade: [-6,-0.5] -> [0.5,6])', () => {
    const lefty = (o: Partial<InsightShot>) =>
      buildShot({ handedness: 'left', intent: 'fade', ...o });
    expect(labelFailureModes(lefty({ launchDirDeg: 7.5 }), null, config)).toEqual(['push']);
    expect(labelFailureModes(lefty({ launchDirDeg: -1 }), null, config)).toEqual(['pull']);
    expect(labelFailureModes(lefty({ launchDirDeg: 3 }), null, config)).toEqual([]);
  });

  it('over-curve: stock (either direction) flags any curve beyond overCurveM', () => {
    expect(labelFailureModes(buildShot({ curveM: 12.5 }), null, config)).toEqual(['over-curve']);
    expect(labelFailureModes(buildShot({ curveM: -12.5 }), null, config)).toEqual(['over-curve']);
    expect(labelFailureModes(buildShot({ curveM: 11 }), null, config)).toEqual([]);
  });

  it('over-curve: shaped intents only flag curve in the intended direction', () => {
    const draw = (o: Partial<InsightShot>) =>
      buildShot({ intent: 'draw', launchDirDeg: 2, ...o });
    expect(labelFailureModes(draw({ curveM: -13 }), null, config)).toEqual(['over-curve']);
    // over-curved the WRONG way is not 'over-curve' (and |13| >= underCurveM)
    expect(labelFailureModes(draw({ curveM: 13 }), null, config)).toEqual([]);
  });

  it('over-curve direction expectation mirrors for left-handers', () => {
    const leftyFade = (o: Partial<InsightShot>) =>
      buildShot({ handedness: 'left', intent: 'fade', launchDirDeg: 2, ...o });
    // righty fade curves right; lefty fade curves left (curveM < 0)
    expect(labelFailureModes(leftyFade({ curveM: -15 }), null, config)).toEqual(['over-curve']);
    expect(labelFailureModes(leftyFade({ curveM: 15 }), null, config)).toEqual([]);
  });

  it('under-curve: draw/fade whose curve magnitude stayed under underCurveM', () => {
    const draw = (o: Partial<InsightShot>) =>
      buildShot({ intent: 'draw', launchDirDeg: 2, ...o });
    expect(labelFailureModes(draw({ curveM: -1 }), null, config)).toEqual(['under-curve']);
    expect(labelFailureModes(draw({ curveM: 1.5 }), null, config)).toEqual(['under-curve']);
    expect(labelFailureModes(draw({ curveM: -5 }), null, config)).toEqual([]);
    // stock never under-curves
    expect(labelFailureModes(buildShot({ curveM: 0 }), null, config)).toEqual([]);
  });

  it('curve modes are skipped entirely when curveM is null', () => {
    const shot = buildShot({ intent: 'draw', launchDirDeg: 2, curveM: null });
    expect(labelFailureModes(shot, null, config)).toEqual([]);
  });

  it('low-smash: below ceiling * lowSmashFactor (wedge: < 1.125)', () => {
    expect(labelFailureModes(buildShot({ smash: 1.12 }), null, config)).toEqual(['low-smash']);
    expect(labelFailureModes(buildShot({ smash: 1.13 }), null, config)).toEqual([]);
    expect(labelFailureModes(buildShot({ smash: null }), null, config)).toEqual([]);
  });

  it('short/long: carry outside +/- carryFraction of the bucket median', () => {
    expect(labelFailureModes(buildShot({ carryM: 91 }), 100, config)).toEqual(['short']);
    expect(labelFailureModes(buildShot({ carryM: 109 }), 100, config)).toEqual(['long']);
    // exactly at the band edge is inside
    expect(labelFailureModes(buildShot({ carryM: 92 }), 100, config)).toEqual([]);
    expect(labelFailureModes(buildShot({ carryM: 108 }), 100, config)).toEqual([]);
    // no median -> no verdict
    expect(labelFailureModes(buildShot({ carryM: 50 }), null, config)).toEqual([]);
  });

  it('untagged intent skips corridor modes but still labels the rest', () => {
    const shot = buildShot({
      intent: 'untagged',
      launchDirDeg: -10,
      curveM: 20,
      smash: 1.0,
      carryM: 80,
    });
    expect(labelFailureModes(shot, 100, config)).toEqual(['low-smash', 'short']);
  });

  it('a shot can carry several modes, in canonical order', () => {
    const shot = buildShot({ launchDirDeg: -6, smash: 1.0, carryM: 80 });
    expect(labelFailureModes(shot, 100, config)).toEqual(['pull', 'low-smash', 'short']);
  });
});

/* ── detectFindings ──
   Scenario construction: great shots have smash null (great via startLine
   only; the smash metric series over greats is then empty, so the
   mode-defining metric can never emit a trivial finding), bad shots have
   smash 1.0 -> labeled 'low-smash'. All always-present metrics are constant
   across both groups, so the ONLY separable metric is the planted one. */

/** wristExtPeakDown base: mean 10, sample variance 2/3, sd sqrt(2/3). */
const WRIST_BASE = [9, 10, 11, 9, 10, 11, 9, 10, 11, 10];

function greatSet(clubId: string, category: InsightShot['clubCategory']): InsightShot[] {
  return WRIST_BASE.map((w, i) =>
    buildShot({
      clubId,
      clubCategory: category,
      sessionId: i < 5 ? 's1' : 's2',
      smash: null,
      wristExtPeakDown: w,
    }),
  );
}

function badSet(
  clubId: string,
  category: InsightShot['clubCategory'],
  wristShift: number,
  opts: { singleSession?: boolean } = {},
): InsightShot[] {
  return WRIST_BASE.map((w, i) =>
    buildShot({
      clubId,
      clubCategory: category,
      sessionId: opts.singleSession || i < 5 ? 's1' : 's2',
      smash: 1.0, // low-smash for wedge (floor 1.125) and iron (floor 1.242)
      ts: 5000 + i,
      wristExtPeakDown: w + wristShift,
    }),
  );
}

describe('detectFindings', () => {
  it('planted +8 deg wristExtPeakDown shift emits exactly that finding', () => {
    const shots = [...greatSet('pw', 'wedge'), ...badSet('pw', 'wedge', 8)];
    const findings = detectFindings(shots, config);

    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f.key).toEqual({ clubId: 'pw', intent: 'stock' });
    expect(f.failureMode).toBe('low-smash');
    expect(f.metric).toBe('wristExtPeakDown');
    // d = shift / pooled sd = 8 / sqrt(2/3) — both groups share variance 2/3
    expect(f.effectSize).toBeCloseTo(8 / Math.sqrt(2 / 3), 10);
    expect(f.direction).toBe('higher');
    // complete separation, n=10 vs 10: |z| = 50/sqrt(175) ~ 3.78
    expect(f.pApprox).toBeGreaterThan(0);
    expect(f.pApprox).toBeLessThan(0.001);
    expect(f.sessionsSeen).toBe(2);
    // great IQR is [9.25, 10.75]; every bad value (17..19) is beyond it
    expect(f.counts).toEqual({ bad: 10, great: 10, badBeyondGreatRange: 10 });
    expect(f.firstSeenTs).toBe(5000);
    expect(f.lastSeenTs).toBe(5009);
  });

  it('guardrail: |d| just under minEffectSize (0.49) emits nothing', () => {
    const shift = 0.49 * Math.sqrt(2 / 3); // d = shift / sd = 0.49 exactly
    const shots = [...greatSet('pw', 'wedge'), ...badSet('pw', 'wedge', shift)];
    expect(detectFindings(shots, config)).toEqual([]);
  });

  it('guardrail: a single-session bad set emits nothing', () => {
    const shots = [
      ...greatSet('pw', 'wedge'),
      ...badSet('pw', 'wedge', 8, { singleSession: true }),
    ];
    expect(detectFindings(shots, config)).toEqual([]);
  });

  it('guardrail: leave-one-session-out kills an effect carried by one session', () => {
    // Great: 12 shots, wrist mean 10, sample var 5/11.
    const greatWrist = [9, 9, 9.5, 9.5, 10, 10, 10, 10, 10.5, 10.5, 11, 11];
    const great = greatWrist.map((w) =>
      buildShot({ smash: null, wristExtPeakDown: w }),
    );
    // Bad: session sA carries the whole effect (+8..+10); session sB matches
    // the great distribution exactly. Full set: d ~ 1.38, p ~ 0.048 — both
    // gates pass — but removing sA leaves d = 0, so LOSO must kill it.
    const badA = [18, 18.5, 19, 19.5, 20].map((w, i) =>
      buildShot({ sessionId: 'sA', smash: 1.0, ts: 6000 + i, wristExtPeakDown: w }),
    );
    const badB = [9, 9.5, 10, 10.5, 11].map((w, i) =>
      buildShot({ sessionId: 'sB', smash: 1.0, ts: 7000 + i, wristExtPeakDown: w }),
    );
    expect(detectFindings([...great, ...badA, ...badB], config)).toEqual([]);
  });

  it('negative control: no planted difference emits zero findings', () => {
    const shots = [...greatSet('pw', 'wedge'), ...badSet('pw', 'wedge', 0)];
    expect(detectFindings(shots, config)).toEqual([]);
  });

  it('untagged shots are quarantined even with extreme values', () => {
    const shots = [
      ...greatSet('pw', 'wedge'),
      ...badSet('pw', 'wedge', 8),
    ].map((s) => ({ ...s, intent: 'untagged' as const }));
    expect(detectFindings(shots, config)).toEqual([]);
  });

  it('warmup and discarded shots never enter a bucket', () => {
    const shots = [
      ...greatSet('pw', 'wedge'),
      ...badSet('pw', 'wedge', 8).map((s) => ({ ...s, warmup: true })),
    ];
    expect(detectFindings(shots, config)).toEqual([]);
  });

  it('is deterministic under input shuffle and sorted by clubId', () => {
    const shots = [
      ...greatSet('pw', 'wedge'),
      ...badSet('pw', 'wedge', 8),
      ...greatSet('7i', 'iron'),
      ...badSet('7i', 'iron', 8),
    ];
    const baseline = detectFindings(shots, config);
    expect(baseline).toHaveLength(2);
    expect(baseline[0].key.clubId).toBe('7i');
    expect(baseline[1].key.clubId).toBe('pw');

    // fixed reordering: rotate by 13 then reverse
    const shuffled = [...shots.slice(13), ...shots.slice(0, 13)].reverse();
    expect(detectFindings(shuffled, config)).toEqual(baseline);
  });
});
