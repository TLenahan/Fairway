import { degToRad } from './math';

/**
 * Rollout after carry (FLIGHT_MODEL.md §6) — simple, documented, isolated.
 *
 *   rollout = K · v_horizontal · cos⁴(descent) / (1 + (spinLand / S0)²)
 *
 * Spin braking matters as much as descent: a 7,000 rpm wedge bites where a
 * 2,000 rpm driver releases. Calibrated 2026-07-13 against two anchors:
 *  - a real 52° shot (29.8 m/s ball, 22.8° launch, 6,960 rpm, flighted pull)
 *    where Uneekor VIEW reported ~5.9 m rollout — our shallow-descent sim
 *    (32°, ~17 m/s landing) must NOT roll it 19 m like the old model did;
 *  - typical mid-fairway driver release (~16–20 m at ~38° descent, ~2k rpm).
 * Solving both gives K ≈ 2.7 s and S0 ≈ 3,367 rpm (quadratic braking term —
 * a linear spin term cannot separate the two anchors).
 * No turf/firmness model — clearly approximate (v1).
 */
const ROLL_FACTOR_S = 2.7;
const SPIN_BRAKE_RPM = 3367;

export const rolloutM = (
  horizontalLandingSpeedMs: number,
  descentDeg: number,
  landingSpinRpm: number,
): number => {
  const cosDescent = Math.cos(degToRad(descentDeg));
  const spinBrake = 1 + (landingSpinRpm / SPIN_BRAKE_RPM) ** 2;
  return Math.max(
    0,
    (ROLL_FACTOR_S * horizontalLandingSpeedMs * cosDescent ** 4) / spinBrake,
  );
};
