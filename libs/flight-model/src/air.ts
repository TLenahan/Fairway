import { GRAVITY_MS2 } from './constants';

/**
 * ISA troposphere air density (FLIGHT_MODEL.md §2).
 *
 * International Standard Atmosphere constants — ISO 2533:1975.
 */
const SEA_LEVEL_TEMPERATURE_K = 288.15;
const TEMPERATURE_LAPSE_RATE_K_PER_M = 0.0065;
const SEA_LEVEL_PRESSURE_PA = 101325;
const UNIVERSAL_GAS_CONSTANT_J_PER_MOL_K = 8.31447;
const MOLAR_MASS_AIR_KG_PER_MOL = 0.0289644;
const SPECIFIC_GAS_CONSTANT_DRY_AIR_J_PER_KG_K = 287.058;

/** p(h)/p0 = (T(h)/T0)^(g·M/(R·L)) — barometric formula exponent ≈ 5.256. */
const PRESSURE_EXPONENT =
  (GRAVITY_MS2 * MOLAR_MASS_AIR_KG_PER_MOL) /
  (UNIVERSAL_GAS_CONSTANT_J_PER_MOL_K * TEMPERATURE_LAPSE_RATE_K_PER_M);

/**
 * Dry-air density at `altitudeM` (meters above sea level), ISA troposphere model:
 *
 *   T(h) = T0 − L·h
 *   p(h) = p0 · (T(h)/T0)^(g·M/(R·L))
 *   ρ(h) = p(h) / (Rs · T(h))
 *
 * `temperatureC`, when non-null, overrides the ISA sea-level temperature of the
 * column (T0 = 273.15 + temperatureC), per FLIGHT_MODEL.md §2. A warmer column is
 * less dense at every altitude.
 *
 * Sanity: ρ(0) = 1.2250 kg/m³. At 1850 m the exact ISA value is 1.0217 kg/m³
 * (~17% thinner than sea level) — the spec's quoted "≈1.006" corresponds to a
 * slightly warmer-than-ISA column; the load-bearing fact is the ~17% drop.
 * Valid for the troposphere (h < 11 km); humidity refinement deliberately omitted (v1).
 */
export const airDensityKgM3 = (
  altitudeM: number,
  temperatureC: number | null = null,
): number => {
  const t0K =
    temperatureC === null ? SEA_LEVEL_TEMPERATURE_K : 273.15 + temperatureC;
  const tK = t0K - TEMPERATURE_LAPSE_RATE_K_PER_M * altitudeM;
  const pPa = SEA_LEVEL_PRESSURE_PA * (tK / t0K) ** PRESSURE_EXPONENT;
  return pPa / (SPECIFIC_GAS_CONSTANT_DRY_AIR_J_PER_KG_K * tK);
};
