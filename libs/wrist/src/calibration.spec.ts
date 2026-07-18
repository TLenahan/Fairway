import {
  anatomicalAnglesDeg,
  calibrateAxes,
  calibrateFlatRaise,
  CalibrationPose,
  flatRaiseIssues,
} from './calibration';
import {
  axisAngleToQuat,
  DEG_TO_RAD,
  Mat3,
  qConj,
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

/**
 * The vendor's flat+raise flow against synthetic ground truth. World frame:
 * z up, forearm pointing +x at the flat pose, palm down. Raising the forearm
 * (elbow still) rotates BOTH pods about world −y… — here +uWorld is chosen so
 * the raise is a positive rotation. Both pods carry arbitrary strap offsets;
 * the wrist stays rigid through the raise (qRel constant), exactly like a
 * real calibration.
 */
describe('calibrateFlatRaise', () => {
  const uWorld: Vec3 = [0, -1, 0]; // raise axis: level, left–right
  const qA0 = axisAngleToQuat([0.3, 1, 0.2], 40 * DEG_TO_RAD); // forearm strap
  const qB0 = axisAngleToQuat([1, -0.5, 0.1], -35 * DEG_TO_RAD); // hand strap

  const neutral: CalibrationPose[] = Array.from({ length: 60 }, () => ({
    qA: qA0,
    qB: qB0,
  }));
  const raise: CalibrationPose[] = Array.from({ length: 80 }, (_, i) => {
    const w = axisAngleToQuat(uWorld, ((38 * (i + 1)) / 80) * DEG_TO_RAD);
    return { qA: qMul(w, qA0), qB: qMul(w, qB0) };
  });
  const { calibration, quality } = calibrateFlatRaise(neutral, raise);

  // ground-truth axes in the decomposition space (B-body at neutral)
  const bodyOf = (v: Vec3): Vec3 => {
    const m = quatToMatrix(qB0); // body → world; world → body is the transpose
    return [
      m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
      m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
      m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
    ];
  };
  const flexTrue = bodyOf(uWorld);
  const vertTrue = bodyOf([0, 0, 1]);

  it('recovers qRef as the strap offset between the pods', () => {
    const qRefTrue = qMul(qConj(qA0), qB0);
    // compare up to sign via the geodesic angle between them
    const dot = Math.abs(
      calibration.qRef[0] * qRefTrue[0] +
        calibration.qRef[1] * qRefTrue[1] +
        calibration.qRef[2] * qRefTrue[2] +
        calibration.qRef[3] * qRefTrue[3],
    );
    expect(dot).toBeGreaterThan(0.9999);
  });

  it('recovers flexion from the raise and deviation from gravity', () => {
    expect(absCos(col(calibration.frame, 0), flexTrue)).toBeGreaterThan(0.999);
    expect(absCos(col(calibration.frame, 1), vertTrue)).toBeGreaterThan(0.999);
  });

  it('the raise direction reads as POSITIVE extension', () => {
    // cupping: the hand rotates about the same world axis, same sense
    const qRelCupped = qMul(
      qConj(qA0),
      qMul(axisAngleToQuat(uWorld, 25 * DEG_TO_RAD), qB0),
    );
    const qAnat = qMul(qConj(calibration.qRef), qRelCupped);
    const [ext, dev, rot] = anatomicalAnglesDeg(calibration.frame, qAnat);
    expect(ext).toBeGreaterThan(20);
    expect(Math.abs(dev)).toBeLessThan(3);
    expect(Math.abs(rot)).toBeLessThan(3);
  });

  it('deviation motion lands on the deviation channel', () => {
    const qRelDeviated = qMul(
      qConj(qA0),
      qMul(axisAngleToQuat([0, 0, 1], 15 * DEG_TO_RAD), qB0),
    );
    const qAnat = qMul(qConj(calibration.qRef), qRelDeviated);
    const [ext, dev, rot] = anatomicalAnglesDeg(calibration.frame, qAnat);
    expect(Math.abs(dev)).toBeGreaterThan(13);
    expect(Math.abs(ext)).toBeLessThan(2);
    expect(Math.abs(rot)).toBeLessThan(2);
  });

  it('reports a clean capture and accepts it', () => {
    expect(quality.raise.purity).toBeGreaterThan(0.99);
    expect(quality.raise.romDeg).toBeGreaterThan(30);
    expect(quality.raiseVerticalDot).toBeLessThan(0.05);
    expect(quality.neutralSpreadDeg).toBeLessThan(0.1);
    expect(flatRaiseIssues(quality)).toEqual([]);
  });

  it('flags a raise that is too small or rotated', () => {
    const tiny = raise.slice(0, 20); // only ~9.5° of lift
    const small = calibrateFlatRaise(neutral, tiny);
    expect(flatRaiseIssues(small.quality)).not.toEqual([]);
  });
});
