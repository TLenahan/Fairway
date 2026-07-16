import {
  DRILL_FLOOR_CARRY_M,
  MIN_RUNG_GAP_M,
  PARTIAL_MAX_FRACTION,
} from './constants';

/** A wedge whose full-swing carry anchor is known (median of joined fulls). */
export interface WedgeFullAnchor {
  clubId: string;
  fullCarryM: number;
}

/** The two partial-rung carry targets the ladder assigns one wedge. */
export interface PartialCarries {
  midM: number;
  lowM: number;
}

/**
 * Global carry ladder: place the 3n stock shots (n wedges × full/mid/low) so
 * they cover [floorM, longest full carry] evenly. The algorithm is a
 * judgment call, in order of intent:
 *
 * 1. An even grid of 3n points over the span is the coverage ideal.
 * 2. The fulls ARE rungs, but their carries are measured, not chosen — each
 *    full (longest first) claims its nearest unclaimed grid slot. The real
 *    carry stays the target; claiming only removes the slot from the pool.
 * 3. The 2n unclaimed grid values, ascending, pair up (low, mid) per wedge
 *    ascending by full carry: the loftiest wedge covers the shortest
 *    distances, where its proportionally bigger swings are more repeatable.
 * 4. Feasibility clamps per wedge keep mid meaningfully below the full
 *    (≤ PARTIAL_MAX_FRACTION·full) and low ≥ MIN_RUNG_GAP_M under mid —
 *    feasibility beats floor coverage when the two conflict.
 *
 * Degenerate F0 ≤ floorM (even the longest full is under the floor): no grid
 * spans the range, so every wedge falls back to the pure clamp fractions.
 * Works for any n ≥ 1; an empty input yields an empty map.
 */
export const buildCarryLadder = (
  fulls: WedgeFullAnchor[],
  floorM = DRILL_FLOOR_CARRY_M,
): Map<string, PartialCarries> => {
  const ladder = new Map<string, PartialCarries>();
  if (fulls.length === 0) return ladder;

  const desc = [...fulls].sort((a, b) => b.fullCarryM - a.fullCarryM);
  const maxCarryM = desc[0].fullCarryM;

  if (maxCarryM <= floorM) {
    for (const f of desc) {
      const midM = PARTIAL_MAX_FRACTION * f.fullCarryM;
      ladder.set(f.clubId, { midM, lowM: midM - MIN_RUNG_GAP_M });
    }
    return ladder;
  }

  const rungCount = 3 * desc.length;
  const grid: number[] = [];
  for (let i = 0; i < rungCount; i++) {
    grid.push(floorM + (i * (maxCarryM - floorM)) / (rungCount - 1));
  }

  const claimed = new Set<number>();
  for (const f of desc) {
    let best = -1;
    for (let i = 0; i < grid.length; i++) {
      if (claimed.has(i)) continue;
      if (
        best === -1 ||
        Math.abs(grid[i] - f.fullCarryM) < Math.abs(grid[best] - f.fullCarryM)
      ) {
        best = i;
      }
    }
    claimed.add(best);
  }

  const open = grid.filter((_, i) => !claimed.has(i)); // still ascending
  const asc = [...desc].reverse();
  asc.forEach((f, k) => {
    const midM = Math.min(open[2 * k + 1], PARTIAL_MAX_FRACTION * f.fullCarryM);
    const lowM = Math.min(open[2 * k], midM - MIN_RUNG_GAP_M);
    ladder.set(f.clubId, { midM, lowM });
  });
  return ladder;
};
