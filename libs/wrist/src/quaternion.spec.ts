import {
  axisAngleToQuat,
  DEG_TO_RAD,
  markleyAverage,
  qMul,
  Quat,
  quatToRotVec,
  RAD_TO_DEG,
  relativeQuat,
  rotationAngle,
} from './quaternion';

const IDENTITY: Quat = [1, 0, 0, 0];

describe('quaternion math', () => {
  it('multiplies by identity', () => {
    const q = axisAngleToQuat([0, 0, 1], 40 * DEG_TO_RAD);
    expect(qMul(IDENTITY, q)).toEqual(q);
  });

  it('rotation vector of a 90° x-rotation is [π/2, 0, 0]', () => {
    const q = axisAngleToQuat([1, 0, 0], 90 * DEG_TO_RAD);
    const rv = quatToRotVec(q);
    expect(rv[0]).toBeCloseTo(Math.PI / 2, 5);
    expect(rv[1]).toBeCloseTo(0, 6);
    expect(rv[2]).toBeCloseTo(0, 6);
  });

  it('relative quaternion of a pose with itself is identity', () => {
    const q = axisAngleToQuat([0.3, -0.5, 0.8], 55 * DEG_TO_RAD);
    expect(rotationAngle(relativeQuat(q, q)) * RAD_TO_DEG).toBeCloseTo(0, 5);
  });

  it('Markley average is sign-robust (recovers q from q and −q copies)', () => {
    const q = axisAngleToQuat([0.2, 0.9, -0.3], 30 * DEG_TO_RAD);
    const neg: Quat = [-q[0], -q[1], -q[2], -q[3]];
    const avg = markleyAverage([q, neg, q, neg, q]);
    // canonical (w ≥ 0) form of q
    for (let i = 0; i < 4; i += 1) expect(avg[i]).toBeCloseTo(q[i], 5);
  });
});
