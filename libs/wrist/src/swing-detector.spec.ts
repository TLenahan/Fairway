import {
  axisAngleToQuat,
  DEG_TO_RAD,
  Quat,
  quatToMatrix,
  Vec3,
} from './quaternion';
import { detectSwings, SwingSample } from './swing-detector';

const IDENTITY_Q: Quat = [1, 0, 0, 0];
const Z_AXIS: Vec3 = [0, 0, 1];

/** quiet hold → one triangular-speed swing → quiet, timed on the device clock. */
function buildLog(): SwingSample[] {
  const samples: SwingSample[] = [];
  let cumDeg = 0;
  let tsa = 0;
  let tMs = 1_000_000;
  const push = (deltaDeg: number, dtsa: number, shock: number): void => {
    cumDeg += deltaDeg;
    tsa = (tsa + dtsa) % 65536;
    tMs += 12;
    samples.push({
      tMs,
      tsa,
      qRel: axisAngleToQuat(Z_AXIS, cumDeg * DEG_TO_RAD),
      shock,
    });
  };
  for (let i = 0; i < 30; i += 1) push(0, 2560, 20); // rest at address
  for (let i = 0; i < 40; i += 1) {
    const frac = i < 20 ? i / 20 : (40 - i) / 20;
    push(0.2 + frac * 2.8, 640, 200 + frac * 4000); // motion burst
  }
  for (let i = 0; i < 30; i += 1) push(0, 2560, 20); // settle
  return samples;
}

describe('detectSwings', () => {
  it('detects a single swing and locates its keyframes', () => {
    const swings = detectSwings(buildLog());
    expect(swings).toHaveLength(1);
    const s = swings[0];
    expect(s.peakAngularSpeedDegS).toBeGreaterThan(200);
    expect(s.calibrated).toBe(false);
    expect(s.impact.angles.extensionDeg).toBeNull();
    expect(s.address.tMs).toBeLessThan(s.impact.tMs);
    expect(s.impact.angularSpeedDegS).toBeGreaterThanOrEqual(
      s.top.angularSpeedDegS,
    );
    expect(s.durationMs).toBeGreaterThan(250);
    // shock magnitude peaks during the swing
    expect(s.shock.peakAbsLsb).toBeGreaterThan(1000);
  });

  it('finds nothing in a still hold', () => {
    const samples: SwingSample[] = [];
    let tsa = 0;
    let tMs = 0;
    for (let i = 0; i < 80; i += 1) {
      tsa = (tsa + 2560) % 65536;
      tMs += 40;
      samples.push({ tMs, tsa, qRel: IDENTITY_Q, shock: 5 });
    }
    expect(detectSwings(samples)).toHaveLength(0);
  });

  it('attaches anatomical angles when calibrated', () => {
    const swings = detectSwings(buildLog(), {
      calibration: { qRef: IDENTITY_Q, frame: quatToMatrix(IDENTITY_Q) },
    });
    expect(swings).toHaveLength(1);
    expect(swings[0].calibrated).toBe(true);
    expect(swings[0].impact.angles.rotationDeg).not.toBeNull();
  });
});
