/**
 * DISPLAY-ONLY conversions for axis labels and readouts. Stored data is
 * always SI (BUILD_SPEC rule #3); nothing here writes back.
 */
export const M_TO_YD = 1.0936132983377078;
export const MS_TO_MPH = 2.2369362920544;

export const metersToYards = (m: number): number => m * M_TO_YD;
export const msToMph = (ms: number): number => ms * MS_TO_MPH;

export type VizDistanceUnit = 'yards' | 'meters';

export const formatDistanceLabel = (
  m: number,
  unit: VizDistanceUnit,
  decimals = 0,
): string =>
  unit === 'yards'
    ? `${metersToYards(m).toFixed(decimals)} yd`
    : `${m.toFixed(decimals)} m`;
