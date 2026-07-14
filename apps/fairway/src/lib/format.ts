import { DistanceUnit, SpeedUnit } from '@golf/types';
import { z } from 'zod';

/**
 * Display-only unit conversion + formatting. Stored data is always SI
 * (BUILD_SPEC rule #3); a null in = "not measured" and stays null out
 * (rule #4 — the UI renders it as an em dash, never 0).
 */
export const MS_TO_MPH = 2.2369362920544;
export const M_TO_YD = 1.0936132983377078;

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

export function formatDegrees(
  deg: number | null,
  decimals = 1,
): string | null {
  if (deg === null) return null;
  return `${deg.toFixed(decimals)}°`;
}

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
