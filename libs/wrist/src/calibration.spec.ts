import { anatomicalAnglesDeg, calibrateAxes } from './calibration';
import {
  axisAngleToQuat,
  DEG_TO_RAD,
  Mat3,
  qMul,
  Quat,
  quatToMatrix,
  Vec3,
} from './quaternion';

const col = (m: Mat3, j: number): Vec3 => [m[0][j], m[1][j], m[2][j]];
const absCos = (a: Vec3, b: Vec3): number =>
  Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);

/**
 * Port of `analyze.py selftest`: synthesize labelled single-axis motion with a
 * known anatomical frame and strap offset, then confirm the calibration
 * recovers the axes exactly.
 */
describe('calibration selftest', () => {
  // ground-truth anatomical frame: 25° about (1,1,1)
  const frameTrue = quatToMatrix(axisAngleToQuat([1, 1, 1], 25 * DEG_TO_RAD));
  const xAxis = col(frameTrue, 0);
  const yAxis = col(frameTrue, 1);
  const zAxis = col(frameTrue, 2);
  // non-trivial strap offset (~30° roll)
  const qRefTrue = axisAngleToQuat([1, 0.2, -0.1], -30 * DEG_TO_RAD);

  const seg = (axis: Vec3, ampDeg: number, count: number): Quat[] =>
    Array.from({ length: count }, (_, i) => {
      const sweep = ampDeg * Math.sin((2 * Math.PI * i) / (count - 1));
      return qMul(qRefTrue, axisAngleToQuat(axis, sweep * DEG_TO_RAD));
    });

  const neutral: Quat[] = Array.from({ length: 60 }, () => qRefTrue);
  const { calibration, fits } = calibrateAxes(
    neutral,
    seg(xAxis, 60, 120),
    seg(yAxis, 25, 120),
    seg(zAxis, 45, 120),
  );

  it('recovers each anatomical axis exactly', () => {
    expect(absCos(fits.flexion.axis, xAxis)).toBeGreaterThan(0.999);
    expect(absCos(fits.deviation.axis, yAxis)).toBeGreaterThan(0.999);
    expect(absCos(fits.rotation.axis, zAxis)).toBeGreaterThan(0.999);
  });

  it('reports ~100% purity and sub-degree cross-talk', () => {
    for (const key of Object.keys(fits)) {
      expect(fits[key].purity).toBeGreaterThan(0.99);
      expect(fits[key].crosstalkDeg).toBeLessThan(1);
    }
  });

  it('decomposes a pure flexion pose onto the extension channel', () => {
    const qAnat = axisAngleToQuat(xAxis, 40 * DEG_TO_RAD);
    const [ext, dev, rot] = anatomicalAnglesDeg(calibration.frame, qAnat);
    expect(Math.abs(ext)).toBeGreaterThan(35);
    expect(Math.abs(dev)).toBeLessThan(2);
    expect(Math.abs(rot)).toBeLessThan(2);
  });
});
