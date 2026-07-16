import { DrillOutcome } from '@golf/types';

/**
 * Angle tolerance for judging a rep: 8% of the wedge's full-swing anchor
 * angle, floored at 4° (below the wrist sensor's practical repeatability)
 * and capped at 12° (looser than that stops teaching anything). Judgment
 * call; toleranceFor(0) = 4° doubles as the default before an anchor exists.
 */
export const toleranceFor = (anchorAngleDeg: number): number =>
  Math.min(12, Math.max(4, 0.08 * anchorAngleDeg));

/** Judge one swing against the rung target. Boundary-inclusive: a delta of
    exactly ±toleranceDeg still counts as a match. */
export const classifyRep = (
  topAngleDeg: number,
  targetAngleDeg: number | null,
  toleranceDeg: number,
): DrillOutcome => {
  if (targetAngleDeg === null) return 'calibrating';
  const deltaDeg = topAngleDeg - targetAngleDeg;
  if (deltaDeg > toleranceDeg) return 'over';
  if (deltaDeg < -toleranceDeg) return 'under';
  return 'match';
};
