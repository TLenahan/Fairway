import { AIR_DYNAMIC_VISCOSITY_PA_S, BALL_DIAMETER_M } from './constants';

/**
 * Aerodynamic coefficients for a dimpled golf ball (FLIGHT_MODEL.md §4).
 *
 * Cd and Cl are modeled as functions of the spin ratio S = r·|ω| / V:
 *
 *   Cd(S) = CD_BASE + CD_SPIN_SLOPE · S      (linear rise with spin)
 *   Cl(S) = CL_MAX · S / (CL_HALF_S + S)     (saturating lift curve, Cl→0 as S→0)
 *
 * Constants fitted 2026-07-17 against external truth (aero-calibration.spec.ts,
 * fixtures/, handoff/FLIGHT_HANDOFF.md): 7,938 cleaned TrackMan shots
 * (fixtures/trackman-driver.csv) scored on carry + apex + descent angle +
 * flight time jointly (arc-weighted Huber loss, 2/3 fit / 1/3 holdout),
 * cross-checked against TrackMan tour averages (carry bias < +2%) and the
 * FlightScope oracle (altitude scaling within ~0.4 pp for driver/mid-iron).
 * Holdout after the fit: carry −0.2% mean / 6.3 yd RMS, apex ±3.3 ft RMS,
 * descent −0.5° mean / 2.1° RMS, flight-time bias ~0 (was: −1.0%/8.8 yd,
 * +5.2 ft, +1.3°/3.0°, +0.18 s).
 *
 * The fitted curves stay inside the measured envelopes at every operating S
 * (free-flight, LES, and wind-tunnel data; envelope details in the handoff):
 * Cd 0.19→0.31 and Cl 0→0.33 over S ∈ [0, 0.5] — vs bounds from Bearman &
 * Harvey 1976, Smits & Smith 1994, Quintavalla 2002 (USGA), Li 2017 (LES),
 * Crabill et al. 2018 (LES), Lyu/Kensrud/Smith 2018 (free-flight). The S = 0
 * intercept (0.19) sits at the free-flight fleet minimum; no real shot flies
 * below S ≈ 0.03.
 *
 * Reynolds-number dependence is intentionally omitted: every real shot here flies
 * supercritical (Re ≈ 0.5–2.2 × 10⁵, see reynoldsNumber), where Bearman & Harvey
 * show Cd/Cl are only weakly Re-dependent, so S alone parameterizes the model.
 */
export interface AeroCoefficients {
  cdBase: number;
  cdSpinSlope: number;
  clMax: number;
  clHalfS: number;
}

export const DEFAULT_AERO: AeroCoefficients = {
  cdBase: 0.19,
  cdSpinSlope: 0.397,
  clMax: 0.428,
  clHalfS: 0.143,
};

/** Spin ratio S = r·|ω| / V (dimensionless). Guarded against V = 0. */
export const spinRatio = (
  radiusM: number,
  spinRadS: number,
  speedMs: number,
): number => (speedMs > 0 ? (radiusM * spinRadS) / speedMs : 0);

/** Drag coefficient Cd(S). */
export const dragCoefficient = (
  spinRatioS: number,
  aero: AeroCoefficients = DEFAULT_AERO,
): number => aero.cdBase + aero.cdSpinSlope * spinRatioS;

/** Lift (Magnus) coefficient Cl(S); 0 at zero spin, saturating toward CL_MAX. */
export const liftCoefficient = (
  spinRatioS: number,
  aero: AeroCoefficients = DEFAULT_AERO,
): number => (aero.clMax * spinRatioS) / (aero.clHalfS + spinRatioS);

/** Re = ρ·V·d / μ — diagnostic only; the coefficient model is S-parameterized. */
export const reynoldsNumber = (
  airDensityKgM3: number,
  speedMs: number,
): number =>
  (airDensityKgM3 * speedMs * BALL_DIAMETER_M) / AIR_DYNAMIC_VISCOSITY_PA_S;
