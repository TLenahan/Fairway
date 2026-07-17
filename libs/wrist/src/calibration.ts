import { WristCalibration } from '@golf/types';

import {
  columnOf,
  det3,
  identity,
  jacobiEigenSymmetric,
  matMul,
  Matrix,
  transpose,
} from './linalg';
import {
  Mat3,
  markleyAverage,
  qCanonical,
  qConj,
  qMul,
  Quat,
  quatToMatrix,
  quatToRotVec,
  RAD_TO_DEG,
  relativeQuat,
  rotationAngle,
  Vec3,
} from './quaternion';

/**
 * Anatomical-axis calibration. The device ships no calibration protocol, so
 * we recover it host-side. Two procedures produce the same WristCalibration
 * (@golf/types): `calibrateFlatRaise` mirrors the vendor's own two-step flow
 * (flat hold → forearm raise) and is what the app uses; `calibrateAxes`
 * (ported from `analyze.py axes`) needs four labelled single-axis segments
 * and remains for offline capture analysis. The Euler sequence puts deviation
 * (smallest range of motion) in the middle slot, where the gimbal-lock
 * singularity sits, making it unreachable.
 */
export interface AxisFit {
  name: string;
  axis: Vec3; // unit, signed toward the segment's peak motion
  purity: number; // PC1 variance fraction, 0..1; < 0.9 ⇒ mixed segment
  romDeg: number; // range of the projection onto the axis
  crosstalkDeg: number; // max perpendicular excursion
}

const toMatrix = (m: Mat3): Matrix => m.map((row) => [...row]);
const toMat3 = (m: Matrix): Mat3 => [
  [m[0][0], m[0][1], m[0][2]],
  [m[1][0], m[1][1], m[1][2]],
  [m[2][0], m[2][1], m[2][2]],
];

/** PCA on the rotation vectors of one labelled single-axis segment. */
export function fitAxis(name: string, rotvecs: Vec3[]): AxisFit {
  const n = rotvecs.length || 1;
  const mean: [number, number, number] = [0, 0, 0];
  for (const r of rotvecs) {
    mean[0] += r[0];
    mean[1] += r[1];
    mean[2] += r[2];
  }
  mean[0] /= n;
  mean[1] /= n;
  mean[2] /= n;

  const cov: Matrix = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const r of rotvecs) {
    const d = [r[0] - mean[0], r[1] - mean[1], r[2] - mean[2]];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) cov[i][j] += d[i] * d[j];
    }
  }
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) cov[i][j] /= n;
  }

  const eig = jacobiEigenSymmetric(cov);
  const col = columnOf(eig.vectors, 0);
  let axis: Vec3 = [col[0], col[1], col[2]];
  const total = eig.values[0] + eig.values[1] + eig.values[2];
  const purity = total > 0 ? eig.values[0] / total : 0;

  // uncentered projection: ~0 at neutral, full angle at peak
  let minP = Infinity;
  let maxP = -Infinity;
  for (const r of rotvecs) {
    const p = r[0] * axis[0] + r[1] * axis[1] + r[2] * axis[2];
    if (p < minP) minP = p;
    if (p > maxP) maxP = p;
  }
  // point the axis toward the segment's peak motion
  if (Math.abs(minP) > Math.abs(maxP)) {
    axis = [-axis[0], -axis[1], -axis[2]];
    const swap = -minP;
    minP = -maxP;
    maxP = swap;
  }

  let maxPerp = 0;
  for (const r of rotvecs) {
    const p = r[0] * axis[0] + r[1] * axis[1] + r[2] * axis[2];
    const perp = Math.hypot(
      r[0] - p * axis[0],
      r[1] - p * axis[1],
      r[2] - p * axis[2],
    );
    if (perp > maxPerp) maxPerp = perp;
  }

  return {
    name,
    axis,
    purity,
    romDeg: (maxP - minP) * RAD_TO_DEG,
    crosstalkDeg: maxPerp * RAD_TO_DEG,
  };
}

/**
 * Nearest right-handed orthonormal basis (columns) to the measured axes, via
 * the polar decomposition R = A (Aᵀ A)^(−1/2) — symmetric, unlike Gram-Schmidt.
 */
export function nearestRotation(axes: [Vec3, Vec3, Vec3]): Mat3 {
  const a: Matrix = [
    [axes[0][0], axes[1][0], axes[2][0]],
    [axes[0][1], axes[1][1], axes[2][1]],
    [axes[0][2], axes[1][2], axes[2][2]],
  ];
  if (det3(a) < 0) {
    for (let i = 0; i < 3; i += 1) a[i][2] = -a[i][2];
  }
  const s = matMul(transpose(a), a);
  const eig = jacobiEigenSymmetric(s);
  const d = identity(3);
  for (let i = 0; i < 3; i += 1) {
    d[i][i] = 1 / Math.sqrt(Math.max(eig.values[i], 1e-12));
  }
  const sInvHalf = matMul(matMul(eig.vectors, d), transpose(eig.vectors));
  return toMat3(matMul(a, sInvHalf));
}

/** Intrinsic X-Y-Z Euler angles (radians) from a rotation matrix. Y (middle)
    carries the singularity at ±90°. */
export function eulerXyz(m: Mat3): [number, number, number] {
  const beta = Math.asin(Math.min(1, Math.max(-1, m[0][2])));
  const alpha = Math.atan2(-m[1][2], m[2][2]);
  const gamma = Math.atan2(-m[0][1], m[0][0]);
  return [alpha, beta, gamma];
}

/** Decompose a neutral-relative rotation into [extension, deviation, rotation]
    degrees in the anatomical frame. */
export function anatomicalAnglesDeg(
  frame: Mat3,
  qAnat: Quat,
): [number, number, number] {
  const b = toMatrix(frame);
  const mAnat = matMul(matMul(transpose(b), toMatrix(quatToMatrix(qAnat))), b);
  const [ext, dev, rot] = eulerXyz(toMat3(mAnat));
  return [ext * RAD_TO_DEG, dev * RAD_TO_DEG, rot * RAD_TO_DEG];
}

/** One sample of the calibration capture: both IMUs' absolute orientations. */
export interface CalibrationPose {
  qA: Quat;
  qB: Quat;
}

export interface FlatRaiseQuality {
  raise: AxisFit; // purity / range of the forearm raise
  raiseVerticalDot: number; // |axis·vertical| — ~0 when the raise stayed level
  neutralSpreadDeg: number; // max wrist wobble during the flat hold
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * The vendor's calibration flow: (1) wrist flat and straight in front of the
 * body, forearm parallel to the ground — the user confirms, and the hold
 * fixes the zero reference q_ref; (2) the forearm is slowly raised ~30–45°
 * with the elbow still and no rotation. The wrist stays rigid during the
 * raise, so the inter-IMU rotation never moves — but each IMU's ABSOLUTE
 * orientation rotates about an axis that is anatomically parallel to the
 * wrist's flexion/extension axis (palm down: both are the level left–right
 * axis). PCA over IMU B's body-frame deltas recovers that axis; gravity
 * (firmware world +z) at the neutral pose supplies the deviation axis (palm
 * down: radial/ulnar deviation swings about vertical); their completion is
 * the pronation/supination axis.
 *
 * Frame space: anatomicalAnglesDeg decomposes qAnat = qRef* ⊗ qRel, whose
 * rotation vectors live in IMU B's body frame at neutral — so both the raise
 * axis and the vertical MUST be measured there (from qB), not from qA; using
 * A would skew every axis by the inter-pod strap offset. Signs: the raise
 * direction is positive flexion-axis rotation, which makes extension
 * (cupping) positive, matching WristAngles.
 */
export function calibrateFlatRaise(
  neutral: CalibrationPose[],
  raise: CalibrationPose[],
): { calibration: WristCalibration; quality: FlatRaiseQuality } {
  const qRef = markleyAverage(neutral.map((p) => relativeQuat(p.qA, p.qB)));
  const qRefConj = qConj(qRef);
  let neutralSpreadDeg = 0;
  for (const p of neutral) {
    const off =
      rotationAngle(qMul(qRefConj, relativeQuat(p.qA, p.qB))) * RAD_TO_DEG;
    if (off > neutralSpreadDeg) neutralSpreadDeg = off;
  }

  const qBRef = markleyAverage(neutral.map((p) => p.qB));
  const qBRefConj = qConj(qBRef);
  const fit = fitAxis(
    'raise',
    raise.map((p) => quatToRotVec(qCanonical(qMul(qBRefConj, p.qB)))),
  );

  // world +z (gravity-up in the firmware's fused frame) in B-body coordinates
  const m = quatToMatrix(qBRef); // body → world
  const vertical: Vec3 = [m[2][0], m[2][1], m[2][2]]; // Rᵀ·ẑ = third row
  const raiseVerticalDot = Math.abs(
    fit.axis[0] * vertical[0] +
      fit.axis[1] * vertical[1] +
      fit.axis[2] * vertical[2],
  );

  const frame = nearestRotation([
    fit.axis,
    vertical,
    cross(fit.axis, vertical),
  ]);
  return {
    calibration: { qRef, frame },
    quality: { raise: fit, raiseVerticalDot, neutralSpreadDeg },
  };
}

/** Human-readable problems with a flat+raise capture; empty = accept. */
export function flatRaiseIssues(quality: FlatRaiseQuality): string[] {
  const issues: string[] = [];
  if (quality.neutralSpreadDeg > 5) {
    issues.push('Hold the flat position still — the wrist moved during it.');
  }
  if (quality.raise.romDeg < 20) {
    issues.push('Raise the forearm further — about 30–45°.');
  }
  if (quality.raise.romDeg > 70) {
    issues.push('Raise the forearm less — about 30–45° is enough.');
  }
  if (quality.raise.purity < 0.85) {
    issues.push('Raise in one smooth motion without wandering.');
  }
  if (quality.raiseVerticalDot > 0.35) {
    issues.push('Keep the forearm level — it rotated during the raise.');
  }
  return issues;
}

/**
 * Full calibration from four labelled segments of relative quaternions (q_rel =
 * qA* ⊗ qB): a still neutral pose plus flexion-only, deviation-only, and
 * rotation-only motion. Mirrors `analyze.py axes`.
 */
export function calibrateAxes(
  neutral: Quat[],
  flex: Quat[],
  dev: Quat[],
  rot: Quat[],
): { calibration: WristCalibration; fits: Record<string, AxisFit> } {
  const qRef = markleyAverage(neutral);
  const qRefConj = qConj(qRef);
  const rotvecsFor = (segment: Quat[]): Vec3[] =>
    segment.map((q) => quatToRotVec(qCanonical(qMul(qRefConj, q))));

  const fits = {
    flexion: fitAxis('flexion', rotvecsFor(flex)),
    deviation: fitAxis('deviation', rotvecsFor(dev)),
    rotation: fitAxis('rotation', rotvecsFor(rot)),
  };
  const frame = nearestRotation([
    fits.flexion.axis,
    fits.deviation.axis,
    fits.rotation.axis,
  ]);
  return { calibration: { qRef, frame }, fits };
}
