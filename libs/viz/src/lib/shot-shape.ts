import { FlightResult } from '@golf/types';

export type ShotShape =
  'straight' | 'draw' | 'fade' | 'hook' | 'slice' | 'pull' | 'push';

/**
 * Classification thresholds (documented judgment calls, world coords: +z =
 * right of the target line, handedness-neutral):
 * - curvature = `curveM`, the flight model's lateral deviation from the start
 *   line; |curve| < 3 m counts as no curve (measurement noise / tiny gear
 *   effect).
 * - with no curve: |HLA| ≤ 2° = straight, left of that = pull, right = push.
 * - with curve: right curve = fade, left = draw; |curve| > 12 m upgrades to
 *   slice / hook.
 * - a curve that fights the start direction (e.g. starts left, curves right)
 *   is still classified by its curve — that IS the fade/draw pattern.
 */
export const NO_CURVE_THRESHOLD_M = 3;
export const BIG_CURVE_THRESHOLD_M = 12;
export const STRAIGHT_HLA_THRESHOLD_DEG = 2;

export interface ShotShapeInput {
  launchDirectionDeg: number; // HLA, + = right
}

export function classifyShotShape(
  result: FlightResult,
  launch: ShotShapeInput,
): ShotShape {
  const curve = result.curveM;

  if (Math.abs(curve) < NO_CURVE_THRESHOLD_M) {
    if (Math.abs(launch.launchDirectionDeg) <= STRAIGHT_HLA_THRESHOLD_DEG) {
      return 'straight';
    }
    return launch.launchDirectionDeg < 0 ? 'pull' : 'push';
  }
  if (curve > 0) {
    return curve > BIG_CURVE_THRESHOLD_M ? 'slice' : 'fade';
  }
  return -curve > BIG_CURVE_THRESHOLD_M ? 'hook' : 'draw';
}
