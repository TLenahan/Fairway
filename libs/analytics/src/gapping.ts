import { ClubSummary, GappingEntry } from '@golf/types';

/**
 * Two adjacent clubs on the carry ladder whose mean carries are closer than
 * this are flagged as overlapping — under ~5 m (half a typical club gap) the
 * two clubs cover the same distance and one of them is redundant. Threshold
 * is a documented judgment call.
 */
export const GAP_OVERLAP_THRESHOLD_M = 5;

/**
 * Carry ladder across the bag: clubs ordered by mean COMPUTED carry
 * descending, each entry carrying its gap down to the next club.
 *
 * - Clubs with no carry data (`carryM === null` — no flights attached, e.g.
 *   the putter) are excluded entirely: no carry, no rung.
 * - `gapToNextM` = own carry mean − next entry's carry mean; null for the
 *   last (shortest) club, which has nothing below it.
 * - `overlap` = true when the gap below is < GAP_OVERLAP_THRESHOLD_M; the
 *   last entry is never flagged (its gap is null).
 */
export const computeGapping = (clubs: ClubSummary[]): GappingEntry[] => {
  const ladder = clubs
    .flatMap((club) =>
      club.carryM === null
        ? []
        : [
            {
              clubId: club.clubId,
              clubName: club.clubName,
              carryMeanM: club.carryM.mean,
            },
          ],
    )
    .sort((a, b) => b.carryMeanM - a.carryMeanM);

  return ladder.map((rung, i) => {
    const next = i + 1 < ladder.length ? ladder[i + 1] : null;
    const gapToNextM = next === null ? null : rung.carryMeanM - next.carryMeanM;
    return {
      ...rung,
      gapToNextM,
      overlap: gapToNextM !== null && gapToNextM < GAP_OVERLAP_THRESHOLD_M,
    };
  });
};
