import { degToRad } from './math';

/**
 * Rollout after carry (FLIGHT_MODEL.md §6) — simple, documented, isolated.
 *
 *   raw     = K · v_horizontal · cos(descent) / (1 + (spinLand / S0)²)
 *   rollout = min(raw, CAP · carry)
 *
 * Refit 2026-07-17 on the recalibrated arc (the aero refit changed landing
 * speed/descent/spin, so the old constants no longer matched): grid + local
 * search against the same 19 Uneekor VIEW total−carry anchors (18 sea-level
 * 5/7/9-iron shots, 2026-07-13, + one flighted 52° at 1,849 m), mean |err|
 * 0.69 yd, bias −0.03 yd. The carry-fraction cap still tames low-descent
 * bullets (the 3.4°-launch skull rolls ~9% of carry, not 40 yd).
 *
 * Known vendor split (FLIGHT_HANDOFF.md): TrackMan's flat-ground "normal"
 * turf rolls drivers ~19 yd median (total−carry in fixtures/trackman-driver.csv),
 * ~6 yd more than this Uneekor-anchored model predicts. Totals here follow the
 * product's own reference monitor (EYE MINI/VIEW). No turf/firmness model —
 * clearly approximate (v1).
 */
export interface RolloutParams {
  rollFactorS: number;
  spinBrakeRpm: number;
  carryFractionCap: number;
}

export const DEFAULT_ROLLOUT: RolloutParams = {
  rollFactorS: 1.05,
  spinBrakeRpm: 23000,
  carryFractionCap: 0.09,
};

export const rolloutM = (
  horizontalLandingSpeedMs: number,
  descentDeg: number,
  landingSpinRpm: number,
  carryM: number,
  params: RolloutParams = DEFAULT_ROLLOUT,
): number => {
  const spinBrake = 1 + (landingSpinRpm / params.spinBrakeRpm) ** 2;
  const raw =
    (params.rollFactorS *
      horizontalLandingSpeedMs *
      Math.cos(degToRad(descentDeg))) /
    spinBrake;
  return Math.max(0, Math.min(raw, params.carryFractionCap * carryM));
};
