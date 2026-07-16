import { WristKeyframe, WristShot } from '@golf/types';

import { swingMetrics } from './swing-metrics';

const keyframe = (
  tMs: number,
  rotVecDeg: [number, number, number] = [0, 0, 0],
  extensionDeg: number | null = null,
): WristKeyframe => ({
  tMs,
  angularSpeedDegS: 120,
  angles: { extensionDeg, deviationDeg: null, rotationDeg: null },
  rotVecDeg,
});

const shot = (over: {
  address?: WristKeyframe;
  top?: WristKeyframe;
  impact?: WristKeyframe;
}): WristShot => {
  const address = over.address ?? keyframe(1000);
  const top = over.top ?? keyframe(1750, [30, 40, 0]);
  const impact = over.impact ?? keyframe(2000);
  return {
    tImpactMs: impact.tMs,
    durationMs: impact.tMs - address.tMs,
    peakAngularSpeedDegS: 900,
    calibrated: false,
    address,
    top,
    impact,
    shock: { tMs: impact.tMs + 5, offsetFromImpactMs: 5, peakAbsLsb: 20000 },
  };
};

describe('swingMetrics', () => {
  it('topAngleDeg is the Euclidean magnitude of top.rotVecDeg', () => {
    expect(swingMetrics(shot({})).topAngleDeg).toBeCloseTo(50); // 3-4-5 × 10
    expect(
      swingMetrics(shot({ top: keyframe(1750, [2, 3, 6]) })).topAngleDeg,
    ).toBeCloseTo(7); // 2-3-6-7 quadruple
    expect(
      swingMetrics(shot({ top: keyframe(1750, [0, 0, 0]) })).topAngleDeg,
    ).toBe(0);
  });

  it('magnitude ignores component signs', () => {
    expect(
      swingMetrics(shot({ top: keyframe(1750, [-30, 40, 0]) })).topAngleDeg,
    ).toBeCloseTo(50);
  });

  it('passes extension through when calibrated, null otherwise', () => {
    expect(
      swingMetrics(shot({ top: keyframe(1750, [30, 40, 0], -12.5) }))
        .topExtensionDeg,
    ).toBe(-12.5);
    expect(swingMetrics(shot({})).topExtensionDeg).toBeNull();
  });

  it('splits tempo at the top keyframe', () => {
    const m = swingMetrics(shot({}));
    expect(m.backswingMs).toBe(750); // 1750 − 1000
    expect(m.downswingMs).toBe(250); // 2000 − 1750
  });

  it('clamps negative phase durations to 0', () => {
    const m = swingMetrics(
      shot({
        address: keyframe(2000),
        top: keyframe(1750, [30, 40, 0]),
        impact: keyframe(1500),
      }),
    );
    expect(m.backswingMs).toBe(0);
    expect(m.downswingMs).toBe(0);
  });
});
