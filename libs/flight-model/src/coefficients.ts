import { AIR_DYNAMIC_VISCOSITY_PA_S, BALL_DIAMETER_M } from './constants';

/**
 * Aerodynamic coefficients for a dimpled golf ball (FLIGHT_MODEL.md §4).
 *
 * Cd and Cl are modeled as functions of the spin ratio S = r·|ω| / V, using the
 * spec's closed forms with constants tuned (within the physically plausible
 * envelope of the cited measurements) to the §7 carry validation bands
 * (final: CD_BASE 0.225, CD_SPIN_SLOPE 0.3, CL_MAX 0.42, CL_HALF_S 0.11):
 *
 *   Cd(S) = CD_BASE + CD_SPIN_SLOPE · S      (linear rise with spin)
 *   Cl(S) = CL_MAX · S / (CL_HALF_S + S)     (saturating lift curve, Cl→0 as S→0)
 *
 * Grounding literature:
 * - Bearman, P. W. & Harvey, J. K. (1976), "Golf ball aerodynamics,"
 *   Aeronautical Quarterly 27: dimpled-ball wind-tunnel data showing Cd ≈ 0.24–0.28
 *   rising with spin and Cl rising from ~0 to ~0.25–0.35 and saturating over
 *   S ≈ 0–0.4 in the supercritical regime.
 * - Quintavalla, S. J. (2002), "A generally applicable model for the aerodynamic
 *   behavior of golf balls in flight," USGA: trajectory-model Cd/Cl parameterized
 *   in spin ratio, near-linear Cd(S) and saturating Cl(S) of the same shape.
 *
 * Reynolds-number dependence is intentionally omitted: every real shot here flies
 * supercritical (Re ≈ 0.5–2.2 × 10⁵, see reynoldsNumber), where Bearman & Harvey
 * show Cd/Cl are only weakly Re-dependent, so S alone parameterizes the model.
 *
 * These closed forms are a documented approximation, not a claim of exact
 * launch-monitor equivalence — see FLIGHT_MODEL.md §7. Tuned constants below sit
 * inside the ranges reported by the sources (Cd ≈ 0.21–0.31, Cl ≈ 0–0.35 over the
 * operating range S ≈ 0.05–0.5).
 */
const CD_BASE = 0.225;
const CD_SPIN_SLOPE = 0.3;
const CL_MAX = 0.42;
const CL_HALF_S = 0.11;

/** Spin ratio S = r·|ω| / V (dimensionless). Guarded against V = 0. */
export const spinRatio = (
  radiusM: number,
  spinRadS: number,
  speedMs: number,
): number => (speedMs > 0 ? (radiusM * spinRadS) / speedMs : 0);

/** Drag coefficient Cd(S). */
export const dragCoefficient = (spinRatioS: number): number =>
  CD_BASE + CD_SPIN_SLOPE * spinRatioS;

/** Lift (Magnus) coefficient Cl(S); 0 at zero spin, saturating toward CL_MAX. */
export const liftCoefficient = (spinRatioS: number): number =>
  (CL_MAX * spinRatioS) / (CL_HALF_S + spinRatioS);

/** Re = ρ·V·d / μ — diagnostic only; the coefficient model is S-parameterized. */
export const reynoldsNumber = (
  airDensityKgM3: number,
  speedMs: number,
): number =>
  (airDensityKgM3 * speedMs * BALL_DIAMETER_M) / AIR_DYNAMIC_VISCOSITY_PA_S;
