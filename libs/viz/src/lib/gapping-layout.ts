import { GappingEntry } from '@golf/types';

/**
 * Carry-ladder layout (BUILD_SPEC §10.2). Bars scale against the longest
 * club; a gap below larger than OVERSIZED_GAP_M flags a hole in the bag
 * (documented judgment call — a full club gap is ~10–15 m, so > 25 m means
 * a missing yardage).
 */
export const OVERSIZED_GAP_M = 25;

export interface GappingRow {
  clubId: string;
  clubName: string;
  carryMeanM: number;
  /** 0..1 relative to the longest carry in the ladder */
  barFraction: number;
  gapToNextM: number | null;
  overlap: boolean;
  oversizedGap: boolean;
}

export function buildGappingRows(entries: GappingEntry[]): GappingRow[] {
  const maxCarry = entries.reduce((m, e) => Math.max(m, e.carryMeanM), 0);
  return entries.map((entry) => ({
    clubId: entry.clubId,
    clubName: entry.clubName,
    carryMeanM: entry.carryMeanM,
    barFraction: maxCarry > 0 ? entry.carryMeanM / maxCarry : 0,
    gapToNextM: entry.gapToNextM,
    overlap: entry.overlap,
    oversizedGap:
      entry.gapToNextM !== null && entry.gapToNextM > OVERSIZED_GAP_M,
  }));
}
