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

// The least-squares slope replaces the prior only when the data can support
// it: enough points, enough angle spread to be identifiable, and a value
// that isn't a degenerate fit (near-flat, negative, or wildly steep).
const MIN_LSQ_SAMPLES = 4;
const MIN_ANGLE_SPREAD_DEG = 12;
const SLOPE_GUARD = [0.3, 3] as const; // accepted band, × prior
const ANGLE_CLAMP = [0.25, 1.05] as const; // returned angle, × anchor angle

/**
 * The lead-wrist top angle predicted to carry `targetCarryM` with this wedge.
 * Bootstrap prior: carry proportional to top angle through the origin
 * (slope = anchor.carryM / anchor.angleDeg) — crude, but it needs zero
 * partial-swing data and self-corrects as joined reps accumulate. Once the
 * wedge's samples have real spread, the least-squares slope of carry on
 * angle takes over (guarded against degenerate fits). The result is clamped
 * to a sane fraction of the full-swing anchor angle.
 */
export const targetAngleForCarry = (
  samples: CarrySample[],
  anchor: WedgeAnchor,
  targetCarryM: number,
): number => {
  const prior = anchor.carryM / anchor.angleDeg; // m per degree
  let slope = prior;

  if (samples.length >= MIN_LSQ_SAMPLES) {
    const angles = samples.map((s) => s.topAngleDeg);
    const spread = Math.max(...angles) - Math.min(...angles);
    if (spread >= MIN_ANGLE_SPREAD_DEG) {
      const angleMean = mean(angles);
      const carryMean = mean(samples.map((s) => s.carryM));
      let num = 0;
      let den = 0;
      for (const s of samples) {
        num += (s.topAngleDeg - angleMean) * (s.carryM - carryMean);
        den += (s.topAngleDeg - angleMean) * (s.topAngleDeg - angleMean);
      }
      const lsq = num / den;
      if (lsq >= SLOPE_GUARD[0] * prior && lsq <= SLOPE_GUARD[1] * prior) {
        slope = lsq;
      }
    }
  }

  const raw = anchor.angleDeg + (targetCarryM - anchor.carryM) / slope;
  return Math.min(
    ANGLE_CLAMP[1] * anchor.angleDeg,
    Math.max(ANGLE_CLAMP[0] * anchor.angleDeg, raw),
  );
};
