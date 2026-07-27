import { WristCoachResult, WristSwingRecord } from '@golf/types';

import { buildWristSessionExport, WristPairShot } from './wrist-export';

const kf = (
  ext: { setup: number; top: number; impact: number; peakDown: number },
  dev: { setup: number; top: number; impact: number } = {
    setup: -2.5,
    top: -16,
    impact: 19.5,
  },
  rot: { setup: number; top: number; impact: number } = {
    setup: -1,
    top: -34,
    impact: 12.5,
  },
): WristCoachResult => ({
  status: 'ok',
  keyframes: {
    setup: { extensionDeg: ext.setup, deviationDeg: dev.setup, rotationDeg: rot.setup },
    top: { extensionDeg: ext.top, deviationDeg: dev.top, rotationDeg: rot.top },
    impact: { extensionDeg: ext.impact, deviationDeg: dev.impact, rotationDeg: rot.impact },
    peakDownExtensionDeg: ext.peakDown,
  },
});

const GOOD = kf({ setup: 24.04, top: 35.51, impact: 2.04, peakDown: 38.06 });

let nextId = 0;
const swing = (tImpactMs: number, coach: WristCoachResult = GOOD): WristSwingRecord => ({
  id: `swing-${(nextId += 1)}`,
  sessionId: 'session-1',
  tImpactMs,
  coach,
  createdAt: tImpactMs,
});

const shot = (id: string, tMs: number): WristPairShot => ({ id, tMs });

describe('wrist session export — pairing', () => {
  it('pairs one-to-one inside the tolerance window and counts practice swings silently', () => {
    const result = buildWristSessionExport(
      [swing(10_000), swing(60_000), swing(120_000)], // 60s one is practice
      [shot('a', 11_200), shot('b', 121_500)],
      'right',
    );
    expect(Object.keys(result.blocks).sort()).toEqual(['a', 'b']);
    expect(result.coverage).toEqual({
      paired: 2,
      dropped_unpaired: 1,
      dropped_glitch: 0,
      dropped_no_setup: 0,
      dropped_uncalibrated: 0,
    });
  });

  it('any ambiguity pairs NOTHING: two swings near one shot', () => {
    const result = buildWristSessionExport(
      [swing(10_000), swing(12_000)],
      [shot('a', 11_000)],
      'right',
    );
    expect(result.blocks).toEqual({});
    expect(result.coverage.dropped_unpaired).toBe(2);
    expect(result.coverage.paired).toBe(0);
  });

  it('any ambiguity pairs NOTHING: one swing near two shots', () => {
    const result = buildWristSessionExport(
      [swing(10_000)],
      [shot('a', 9_000), shot('b', 11_500)],
      'right',
    );
    expect(result.blocks).toEqual({});
    expect(result.coverage).toEqual({
      paired: 0,
      dropped_unpaired: 1,
      dropped_glitch: 0,
      dropped_no_setup: 0,
      dropped_uncalibrated: 0,
    });
  });

  it('a swing outside every window never pairs, even as nearest neighbour', () => {
    const result = buildWristSessionExport(
      [swing(10_000)],
      [shot('a', 13_500)], // 3.5 s away — outside ±3 s
      'right',
    );
    expect(result.blocks).toEqual({});
    expect(result.coverage.dropped_unpaired).toBe(1);
  });
});

describe('wrist session export — omission over garbage', () => {
  it('uncalibrated session exports zero blocks and counts every swing', () => {
    const uncal: WristCoachResult = { status: 'dropped', reason: 'uncalibrated' };
    const result = buildWristSessionExport(
      [swing(10_000, uncal), swing(40_000, uncal), swing(70_000, uncal)],
      [shot('a', 10_500), shot('b', 40_500), shot('c', 70_500)],
      'right',
    );
    expect(result.blocks).toEqual({});
    expect(result.coverage).toEqual({
      paired: 0,
      dropped_unpaired: 0,
      dropped_glitch: 0,
      dropped_no_setup: 0,
      dropped_uncalibrated: 3,
    });
  });

  it('a paired swing with no qualifying pause drops its block; others unaffected', () => {
    const result = buildWristSessionExport(
      [swing(10_000, { status: 'dropped', reason: 'no_setup' }), swing(40_000)],
      [shot('a', 10_500), shot('b', 40_500)],
      'right',
    );
    expect(Object.keys(result.blocks)).toEqual(['b']);
    expect(result.coverage).toEqual({
      paired: 1,
      dropped_unpaired: 0,
      dropped_glitch: 0,
      dropped_no_setup: 1,
      dropped_uncalibrated: 0,
    });
  });

  it('a bounds violation drops the whole block as a glitch — never clamps', () => {
    const wild = kf({ setup: 24, top: 95, impact: 2, peakDown: 96 }); // ext > +80
    const result = buildWristSessionExport(
      [swing(10_000, wild), swing(40_000)],
      [shot('a', 10_500), shot('b', 40_500)],
      'right',
    );
    expect(Object.keys(result.blocks)).toEqual(['b']);
    expect(result.coverage.dropped_glitch).toBe(1);
    expect(result.coverage.paired).toBe(1);
  });

  it('a rotation value outside [-90, +90] is a glitch', () => {
    const wildRot = kf(
      { setup: 24, top: 35, impact: 2, peakDown: 38 },
      undefined,
      { setup: -1, top: -95, impact: 12 },
    );
    const result = buildWristSessionExport(
      [swing(10_000, wildRot)],
      [shot('a', 10_500)],
      'right',
    );
    expect(result.blocks).toEqual({});
    expect(result.coverage.dropped_glitch).toBe(1);
  });

  it('a radial value outside its own asymmetric bounds is a glitch too', () => {
    // right-handed: rad = −deviation, so deviation −44 ⇒ rad +44 > +40
    const wildRad = kf(
      { setup: 24, top: 35, impact: 2, peakDown: 38 },
      { setup: -2, top: -44, impact: 19 },
    );
    const result = buildWristSessionExport(
      [swing(10_000, wildRad)],
      [shot('a', 10_500)],
      'right',
    );
    expect(result.blocks).toEqual({});
    expect(result.coverage.dropped_glitch).toBe(1);
  });
});

describe('wrist session export — wire conventions', () => {
  it('rounds to 0.1° and emits exactly the contract keys', () => {
    const result = buildWristSessionExport(
      [swing(10_000)],
      [shot('a', 10_500)],
      'right',
    );
    expect(result.blocks['a']).toEqual({
      ext_setup: 24,
      ext_top: 35.5,
      ext_impact: 2,
      ext_peak_down: 38.1,
      rad_setup: 2.5,
      rad_top: 16,
      rad_impact: -19.5,
      rot_setup: -1,
      rot_top: -34,
      rot_impact: 12.5,
    });
  });

  it('a bowed impact exports negative ext_impact (extension +, flexion −)', () => {
    const bowed = kf({ setup: 22, top: 30, impact: -8.2, peakDown: 31 });
    const result = buildWristSessionExport(
      [swing(10_000, bowed)],
      [shot('a', 10_500)],
      'right',
    );
    expect(result.blocks['a'].ext_impact).toBe(-8.2);
  });

  it('radial and rotation signs follow handedness', () => {
    // deviation −16 at the top = radial for a right-handed golfer's LEFT
    // lead wrist (thumb-ward is negative about the vertical axis there);
    // rotationDeg is already supination-positive on that wrist
    const right = buildWristSessionExport([swing(10_000)], [shot('a', 10_500)], 'right');
    expect(right.blocks['a'].rad_top).toBe(16);
    expect(right.blocks['a'].rot_top).toBe(-34);
    expect(right.blocks['a'].rot_impact).toBe(12.5);
    const left = buildWristSessionExport([swing(10_000)], [shot('a', 10_500)], 'left');
    expect(left.blocks['a'].rad_top).toBe(-16);
    expect(left.blocks['a'].rot_top).toBe(34);
  });
});

describe('wrist session export — strap drift', () => {
  const drifting = (count: number, stepDeg: number): {
    swings: WristSwingRecord[];
    shots: WristPairShot[];
  } => {
    const swings: WristSwingRecord[] = [];
    const shots: WristPairShot[] = [];
    for (let i = 0; i < count; i += 1) {
      const t = 10_000 + i * 30_000;
      swings.push(
        swing(t, kf({ setup: 24 + i * stepDeg, top: 35, impact: 2, peakDown: 38 })),
      );
      shots.push(shot(`s${i}`, t + 300));
    }
    return { swings, shots };
  };

  it('flags a monotone ext_setup trend beyond the threshold', () => {
    const { swings, shots } = drifting(9, 1); // +8° across the session
    expect(buildWristSessionExport(swings, shots, 'right').strapDrift).toBe(true);
  });

  it('stays quiet for a stable strap and for too few blocks', () => {
    const stable = drifting(9, 0.05);
    expect(buildWristSessionExport(stable.swings, stable.shots, 'right').strapDrift).toBe(false);
    const few = drifting(4, 3);
    expect(buildWristSessionExport(few.swings, few.shots, 'right').strapDrift).toBe(false);
  });
});
