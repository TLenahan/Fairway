import { degToRad } from './math';

/**
 * Rollout after carry (FLIGHT_MODEL.md §6) — simple, documented, isolated.
 *
 *   raw     = K · v_horizontal · cos(descent) / (1 + (spinLand / S0)²)
 *   rollout = min(raw, CAP · carry)
 *
 * Fit numerically (grid search, mean |err| 0.67 yd) against 19 real-shot
 * anchors where Uneekor VIEW's total−carry served as the rollout reference:
 * 18 sea-level 5/7/9-iron shots (2026-07-13 sequence) + one flighted 52° at
 * 1,849 m. The carry-fraction cap is what tames low-descent bullets (a 3.4°-
 * launch skull rolls ~9% of carry, not 40 yd). No turf/firmness model —
 * clearly approximate (v1).
 */
const ROLL_FACTOR_S = 1.1;
const SPIN_BRAKE_RPM = 13000;
const CARRY_FRACTION_CAP = 0.08;

export const rolloutM = (
  horizontalLandingSpeedMs: number,
  descentDeg: number,
  landingSpinRpm: number,
  carryM: number,
): number => {
  const spinBrake = 1 + (landingSpinRpm / SPIN_BRAKE_RPM) ** 2;
  const raw =
    (ROLL_FACTOR_S *
      horizontalLandingSpeedMs *
      Math.cos(degToRad(descentDeg))) /
    spinBrake;
  return Math.max(0, Math.min(raw, CARRY_FRACTION_CAP * carryM));
};
