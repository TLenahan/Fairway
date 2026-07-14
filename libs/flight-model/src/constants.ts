/**
 * Physical constants (FLIGHT_MODEL.md §1).
 *
 * Ball values are the R&A/USGA conformance limits for a standard golf ball:
 * maximum mass 45.93 g and minimum diameter 1.680 in (0.04267 m).
 */
export const BALL_MASS_KG = 0.04593;
export const BALL_DIAMETER_M = 0.04267;
export const BALL_RADIUS_M = BALL_DIAMETER_M / 2;
export const BALL_CROSS_SECTION_M2 = Math.PI * BALL_RADIUS_M ** 2;
export const GRAVITY_MS2 = 9.80665;

/** Dynamic viscosity of air (FLIGHT_MODEL.md §4), used for Reynolds number. */
export const AIR_DYNAMIC_VISCOSITY_PA_S = 1.81e-5;
