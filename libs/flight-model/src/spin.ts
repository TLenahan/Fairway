import type { LaunchConditions } from '@golf/types';

import { addScaled, degToRad, scale, vec3 } from './math';
import type { Vec3 } from './math';

export const RPM_TO_RAD_PER_S = (2 * Math.PI) / 60;

/**
 * Spin decay time constant τ (FLIGHT_MODEL.md §5). Exponential decay
 * ω(t) = ω0·e^(−t/τ) with τ = 20 s — the common approximation to the
 * air-resistance spin-down torque; spec allows τ ∈ ~15–25 s.
 */
export const SPIN_DECAY_TAU_S = 20;

/**
 * Initial spin vector ω0 (rad/s) in the flight frame (FLIGHT_MODEL.md §1/§6):
 * x = downrange, y = up, z = lateral (+ = right). x̂ × ŷ = ẑ (right-handed).
 *
 * Sign convention, derived from the Magnus force F ∝ Cl·(ω × v):
 *
 * - Backspin: the axis is horizontal and perpendicular to the horizontal launch
 *   direction d̂ = (cos hla, 0, sin hla). With ω along +ẑ (hla = 0) and v along +x̂,
 *   ω × v = +ŷ·|ω||v| — lift. So positive backspinRpm maps to the axis
 *   d̂ × ŷ = (−sin hla, 0, cos hla), which lifts the ball within its launch plane.
 * - Sidespin: positive sidespinRpm must curve the ball RIGHT (+z). With ω along
 *   −ŷ and v along +x̂, ω × v = (−ŷ) × x̂·|ω||v| = +ẑ·|ω||v| — rightward force.
 *   So positive sidespinRpm maps to the −ŷ axis (clockwise viewed from above,
 *   the right-hander's fade/slice).
 * - Rollspin (rifle spin): about the initial velocity axis v̂0. Its Magnus
 *   contribution is zero while v stays parallel to v̂0 — a documented secondary
 *   effect, included so |ω| (and hence the spin ratio) is honest.
 *
 * Axes are anchored to the launch direction (not the target line) so a shot with
 * zero sidespin stays exactly in its launch vertical plane: offline then comes
 * from HLA alone, matching the §7 curvature checks.
 */
export const initialSpinRadS = (launch: LaunchConditions): Vec3 => {
  const vlaRad = degToRad(launch.launchAngleDeg);
  const hlaRad = degToRad(launch.launchDirectionDeg);
  const backRadS = launch.backspinRpm * RPM_TO_RAD_PER_S;
  const sideRadS = launch.sidespinRpm * RPM_TO_RAD_PER_S;
  const rollRadS = launch.rollspinRpm * RPM_TO_RAD_PER_S;

  const backAxis = vec3(-Math.sin(hlaRad), 0, Math.cos(hlaRad));
  const sideAxis = vec3(0, -1, 0);
  const rollAxis = vec3(
    Math.cos(vlaRad) * Math.cos(hlaRad),
    Math.sin(vlaRad),
    Math.cos(vlaRad) * Math.sin(hlaRad),
  );

  let spin = scale(backAxis, backRadS);
  spin = addScaled(spin, sideAxis, sideRadS);
  spin = addScaled(spin, rollAxis, rollRadS);
  return spin;
};

/** ω(t) = ω0 · e^(−t/τ) — direction fixed, magnitude decays (FLIGHT_MODEL.md §5). */
export const spinAtTime = (spin0RadS: Vec3, tS: number): Vec3 =>
  scale(spin0RadS, Math.exp(-tS / SPIN_DECAY_TAU_S));
