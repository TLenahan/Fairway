import { degToRad } from './math';

/**
 * Rollout after carry (FLIGHT_MODEL.md §6) — deliberately simple, documented,
 * and isolated so it can be replaced by a bounce/turf model later.
 *
 *   rollout = K · v_horizontal · cos²(descent)
 *
 * Rationale: roll grows with the horizontal speed the ball lands with and
 * shrinks rapidly as the descent steepens (steep + slow ≈ drop-and-stop).
 * K = 1.5 s is tuned to typical mid-fairway behavior: a driver landing at
 * ~22 m/s horizontal with a ~38° descent rolls ~20 m; a wedge at ~8 m/s and
 * ~52° rolls ~4 m. No spin-based suck-back — clearly approximate (v1).
 */
const ROLL_FACTOR_S = 1.5;

export const rolloutM = (
  horizontalLandingSpeedMs: number,
  descentDeg: number,
): number => {
  const cosDescent = Math.cos(degToRad(descentDeg));
  return Math.max(
    0,
    ROLL_FACTOR_S * horizontalLandingSpeedMs * cosDescent * cosDescent,
  );
};
