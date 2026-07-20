import { DistanceUnit, SpeedUnit } from '@golf/types';
import { z } from 'zod';

/**
 * Display-only unit conversion + formatting. Stored data is always SI
 * (BUILD_SPEC rule #3); a null in = "not measured" and stays null out
 * (rule #4 — the UI renders it as an em dash, never 0).
 */
export const MS_TO_MPH = 2.2369362920544;
export const M_TO_YD = 1.0936132983377078;
export const M_TO_FT = 3.280839895;

type Speed = z.infer<typeof SpeedUnit>;
type Distance = z.infer<typeof DistanceUnit>;

export function formatSpeed(
  ms: number | null,
  unit: Speed,
  decimals = 1,
): string | null {
  if (ms === null) return null;
  const value = unit === 'mph' ? ms * MS_TO_MPH : ms;
  return value.toFixed(decimals);
}

export function formatDistance(
  m: number | null,
  unit: Distance,
  decimals = 0,
): string | null {
  if (m === null) return null;
  const value = unit === 'yards' ? m * M_TO_YD : m;
  return value.toFixed(decimals);
}

/**
 * Signed lateral distance (offlineM/curveM, + = right) → "8R" / "4L"; a value
 * that rounds to zero reads "0" with no letter. Unit follows formatDistance.
 */
export function formatLateral(
  m: number | null,
  unit: Distance,
  decimals = 0,
): string | null {
  if (m === null) return null;
  const value = unit === 'yards' ? m * M_TO_YD : m;
  const magnitude = Math.abs(value).toFixed(decimals);
  if (Number(magnitude) === 0) return '0';
  return `${magnitude}${value < 0 ? 'L' : 'R'}`;
}

export function formatDegrees(deg: number | null, decimals = 1): string | null {
  if (deg === null) return null;
  return `${deg.toFixed(decimals)}°`;
}

/** apex reads in feet for imperial users (TrackMan convention), meters otherwise */
export function formatApexHeight(
  m: number | null,
  unit: Distance,
): string | null {
  if (m === null) return null;
  return unit === 'yards' ? (m * M_TO_FT).toFixed(0) : m.toFixed(1);
}

export const apexUnitLabel: Record<Distance, string> = {
  yards: 'ft',
  meters: 'm',
};

export function formatSpin(rpm: number | null): string | null {
  if (rpm === null) return null;
  return Math.round(rpm).toLocaleString();
}

export function formatSmash(smash: number | null): string | null {
  if (smash === null) return null;
  return smash.toFixed(2);
}

export const speedUnitLabel: Record<Speed, string> = {
  mph: 'mph',
  ms: 'm/s',
};

export const distanceUnitLabel: Record<Distance, string> = {
  yards: 'yd',
  meters: 'm',
};
