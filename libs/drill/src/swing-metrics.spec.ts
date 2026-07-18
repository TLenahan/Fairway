import { WristKeyframe, WristShot } from '@golf/types';

import { swingMetrics } from './swing-metrics';

const keyframe = (
  tMs: number,
  rotVecFromAddressDeg: [number, number, number] = [0, 0, 0],
  extensionDeg: number | null = null,
): WristKeyframe => ({
  tMs,
  tDevS: tMs / 1000,
  angularSpeedDegS: 120,
  angles: { extensionDeg, deviationDeg: null, rotationDeg: null },
  rotVecDeg: [11, -47, 3], // raw pose — must NOT leak into the drill metric
  rotVecFromAddressDeg,
});

const shot = (over: {
  top?: WristKeyframe;
  backswingMs?: number;
  downswingMs?: number;
}): WristShot => {
  const address = keyframe(1000);
  const top = over.top ?? keyframe(1750, [30, 40, 0]);
  const impact = keyframe(2000);
  return {
    tImpactMs: impact.tMs,
    durationMs: 1400,
    peakAngularSpeedDegS: 900,
    calibrated: false,
    addressHeldMs: 1800,
    backswingMs: over.backswingMs ?? 705,
    topPauseMs: 0,
    downswingMs: over.downswingMs ?? 245,
    address,
    top,
    impact,
    shock: { tMs: impact.tMs + 5, offsetFromImpactMs: 5, peakAbsLsb: 20000 },
  };
};

describe('swingMetrics', () => {
  it('topAngleDeg is the magnitude of the FROM-ADDRESS rotation, not the raw pose', () => {
    expect(swingMetrics(shot({})).topAngleDeg).toBeCloseTo(50); // 3-4-5 × 10
    expect(
      swingMetrics(shot({ top: keyframe(1750, [2, 3, 6]) })).topAngleDeg,
    ).toBeCloseTo(7); // 2-3-6-7 quadruple
    expect(
      swingMetrics(shot({ top: keyframe(1750, [0, 0, 0]) })).topAngleDeg,
    ).toBe(0); // lag-held swing: wrist never left its setup angle
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

  it('tempo comes from the detector’s device-clock phase durations', () => {
    const m = swingMetrics(shot({ backswingMs: 640, downswingMs: 210 }));
    expect(m.backswingMs).toBe(640);
    expect(m.downswingMs).toBe(210);
  });
});
