import { Dispersion } from '@golf/types';

import { mean, median, sampleSd } from './stats';

/** A computed landing point (`flight.landing`): x = downrange m, z = lateral m (+right). */
export interface LandingPoint {
  x: number;
  z: number;
}

const RAD_TO_DEG = 180 / Math.PI;

const ZERO_DISPERSION: Dispersion = {
  centerX: 0,
  centerZ: 0,
  ellipseSemiMajorM: 0,
  ellipseSemiMinorM: 0,
  ellipseAngleDeg: 0,
  biasLateralM: 0,
  biasDepthM: 0,
  lateralSpreadM: 0,
  depthSpreadM: 0,
};

/**
 * Landing-pattern dispersion geometry from computed landing points
 * (`flight.landing` of shots that have a flight attached).
 *
 * - Center = mean(x), mean(z).
 * - depthSpreadM / lateralSpreadM = sample sd of x / z.
 * - Ellipse: eigen-decomposition of the 2×2 sample covariance matrix of
 *   (x, z). Semi-major/minor axes are the 1σ radii (√eigenvalue) along the
 *   eigenvectors — a deliberate 1σ choice; scale by ~2.45 for a 95% ellipse
 *   if a UI ever wants confidence bounds. `ellipseAngleDeg` is the angle of
 *   the major axis measured from the +x (downrange) axis, in (−90°, 90°].
 * - biasLateralM = center z — the systematic offset from the target line
 *   (z = 0), positive = right.
 * - biasDepthM = mean(x) − median(x) — a SKEW indicator, not an offset: fat
 *   shots drag the mean short of the median, so a negative value signals a
 *   tail of short (fat) shots and a positive value a tail of long ones. This
 *   definition is a judgment call the owner may want to revisit.
 *
 * Degenerate cases: 0 landing points yields the all-zero dispersion; 1 point
 * yields its own center/lateral bias but zero spreads, ellipse, and depth
 * bias (no spread or skew is claimable from a single point).
 */
export const computeDispersion = (landings: LandingPoint[]): Dispersion => {
  if (landings.length === 0) return ZERO_DISPERSION;

  const xs = landings.map((p) => p.x);
  const zs = landings.map((p) => p.z);
  const centerX = mean(xs);
  const centerZ = mean(zs);
  const depthSpreadM = sampleSd(xs);
  const lateralSpreadM = sampleSd(zs);
  const biasLateralM = centerZ;
  const biasDepthM = centerX - median(xs);

  let ellipseSemiMajorM = 0;
  let ellipseSemiMinorM = 0;
  let ellipseAngleDeg = 0;

  if (landings.length >= 2) {
    // Sample covariance matrix [[sxx, sxz], [sxz, szz]] of (x, z).
    const n1 = landings.length - 1;
    let sxx = 0;
    let szz = 0;
    let sxz = 0;
    for (const p of landings) {
      const dx = p.x - centerX;
      const dz = p.z - centerZ;
      sxx += dx * dx;
      szz += dz * dz;
      sxz += dx * dz;
    }
    sxx /= n1;
    szz /= n1;
    sxz /= n1;

    // Eigenvalues of a symmetric 2×2 matrix; clamp tiny negative floating-
    // point residue to 0 before the square root.
    const diff = sxx - szz;
    const disc = Math.sqrt(diff * diff + 4 * sxz * sxz);
    const lambdaMajor = Math.max(0, (sxx + szz + disc) / 2);
    const lambdaMinor = Math.max(0, (sxx + szz - disc) / 2);
    ellipseSemiMajorM = Math.sqrt(lambdaMajor);
    ellipseSemiMinorM = Math.sqrt(lambdaMinor);
    // Principal-axis (max-variance eigenvector) angle from the +x axis;
    // atan2(0, 0) = 0 covers the circular pattern where the angle is
    // undefined.
    ellipseAngleDeg = (Math.atan2(2 * sxz, diff) / 2) * RAD_TO_DEG;
  }

  return {
    centerX,
    centerZ,
    ellipseSemiMajorM,
    ellipseSemiMinorM,
    ellipseAngleDeg,
    biasLateralM,
    biasDepthM,
    lateralSpreadM,
    depthSpreadM,
  };
};
