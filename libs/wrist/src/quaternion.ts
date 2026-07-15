import { columnOf, jacobiEigenSymmetric, Matrix } from './linalg';

/**
 * Quaternion + rotation helpers, ported from `analyze.py`. Convention: w-first
 * (w, x, y, z), Hamilton product, matching the HackMotion firmware's on-wire
 * quaternions. Angles are radians unless a name says Deg.
 */
export type Quat = readonly [number, number, number, number];
export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly [Vec3, Vec3, Vec3];

export const RAD_TO_DEG = 180 / Math.PI;
export const DEG_TO_RAD = Math.PI / 180;

export function qConj(q: Quat): Quat {
  return [q[0], -q[1], -q[2], -q[3]];
}

export function qMul(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function qNormalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Resolve the q ≡ −q sign ambiguity to w ≥ 0. */
export function qCanonical(q: Quat): Quat {
  return q[0] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

/** Inter-IMU relative rotation q_rel = qA* ⊗ qB (canonical). */
export function relativeQuat(qa: Quat, qb: Quat): Quat {
  return qCanonical(qMul(qConj(qa), qb));
}

/** Rotation vector (axis × angle, radians). Singularity-free. */
export function quatToRotVec(q: Quat): Vec3 {
  const [w, x, y, z] = qCanonical(qNormalize(q));
  const vn = Math.hypot(x, y, z);
  const angle = 2 * Math.atan2(vn, Math.min(1, Math.max(-1, w)));
  const scale = vn < 1e-9 ? 2 : angle / vn;
  return [x * scale, y * scale, z * scale];
}

/** Geodesic rotation angle (radians). */
export function rotationAngle(q: Quat): number {
  const [w, x, y, z] = qCanonical(qNormalize(q));
  const vn = Math.hypot(x, y, z);
  return 2 * Math.atan2(vn, Math.min(1, Math.max(-1, Math.abs(w))));
}

export function axisAngleToQuat(axis: Vec3, angleRad: number): Quat {
  const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const half = angleRad / 2;
  const s = Math.sin(half) / n;
  return [Math.cos(half), axis[0] * s, axis[1] * s, axis[2] * s];
}

export function quatToMatrix(q: Quat): Mat3 {
  const [w, x, y, z] = qNormalize(q);
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

/** Raw roll/pitch/yaw (deg) — a descriptor, not the gimbal-safe anatomical
    decomposition (that needs calibration.ts). */
export function quatRpyDeg(q: Quat): [number, number, number] {
  const [w, x, y, z] = qNormalize(q);
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(Math.min(1, Math.max(-1, 2 * (w * y - z * x))));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return [roll * RAD_TO_DEG, pitch * RAD_TO_DEG, yaw * RAD_TO_DEG];
}

/**
 * Average orientation = principal eigenvector of Σ q qᵀ (Markley). Sign-robust,
 * unlike a component-wise mean. Used to fix the neutral / strap-offset pose.
 */
export function markleyAverage(quats: Quat[]): Quat {
  const m: Matrix = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  for (const q of quats) {
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 4; j += 1) m[i][j] += q[i] * q[j];
    }
  }
  const principal = columnOf(jacobiEigenSymmetric(m).vectors, 0);
  return qCanonical(
    qNormalize([principal[0], principal[1], principal[2], principal[3]]),
  );
}
