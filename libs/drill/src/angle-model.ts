import { mean } from '@golf/analytics';

/** The wedge's full-swing anchor: median top angle + median joined carry. */
export interface WedgeAnchor {
  angleDeg: number;
  carryM: number;
}

/** One rep with a joined carry — any rung; more spread = better slope. */
export interface CarrySample {
  topAngleDeg: number;
  carryM: number;
}

// The least-squares slope counts as learned only when the data can support
// it: enough points, enough angle spread to be identifiable, and a value
// that isn't a degenerate fit (near-flat, negative, or wildly steep).
export const MIN_LSQ_SAMPLES = 4;
const MIN_ANGLE_SPREAD_DEG = 12;
const SLOPE_GUARD = [0.3, 3] as const; // accepted band, × the anchor ratio
const ANGLE_CLAMP = [0.25, 1.05] as const; // returned angle, × anchor angle

/**
 * The lead-wrist top angle predicted to carry `targetCarryM` with this wedge,
 * or null while no such prediction has been LEARNED. Targets are never
 * assumed (the drill's binding rule): only the least-squares slope of carry
 * on angle over the wedge's joined reps qualifies, and only once it is
 * identifiable — enough samples, real angle spread, and a slope inside a
 * sanity band scaled by the anchor's carry/angle ratio (the ratio is a
 * guard reference, never a target source). Until then the rung calibrates:
 * the golfer chases the carry number and every joined rep feeds this fit.
 * A learned result is clamped to a sane fraction of the anchor angle.
 */
export const targetAngleForCarry = (
  samples: CarrySample[],
  anchor: WedgeAnchor,
  targetCarryM: number,
): number | null => {
  if (samples.length < MIN_LSQ_SAMPLES) return null;
  const angles = samples.map((s) => s.topAngleDeg).sort((a, b) => a - b);
  // the spread must survive losing either extreme — otherwise one fat/thin
  // strike far from the cluster single-handedly sets the slope (a chunked
  // mid rep would define the "learned" line)
  const n = angles.length;
  if (
    angles[n - 1] - angles[1] < MIN_ANGLE_SPREAD_DEG ||
    angles[n - 2] - angles[0] < MIN_ANGLE_SPREAD_DEG
  ) {
    return null;
  }

  const angleMean = mean(angles);
  const carryMean = mean(samples.map((s) => s.carryM));
  let num = 0;
  let den = 0;
  for (const s of samples) {
    num += (s.topAngleDeg - angleMean) * (s.carryM - carryMean);
    den += (s.topAngleDeg - angleMean) * (s.topAngleDeg - angleMean);
  }
  const slope = num / den;
  const guardScale = anchor.carryM / anchor.angleDeg; // m per degree
  if (slope < SLOPE_GUARD[0] * guardScale || slope > SLOPE_GUARD[1] * guardScale) {
    return null;
  }

  const raw = anchor.angleDeg + (targetCarryM - anchor.carryM) / slope;
  return Math.min(
    ANGLE_CLAMP[1] * anchor.angleDeg,
    Math.max(ANGLE_CLAMP[0] * anchor.angleDeg, raw),
  );
};
