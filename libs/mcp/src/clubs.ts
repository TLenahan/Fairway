import { loadShotHistory } from '@golf/data';
import { z } from 'zod';

import { defineTool } from './tool';

/**
 * The entry point of the whole surface: every other tool keys on `club_id`,
 * and those ids are opaque (`newId()`), so a model has no way to name a club
 * without calling this first. Shot counts ride along because "which clubs do
 * I actually have data for" is the same question in practice — a club with
 * four shots has no baseline and no findings, and knowing that up front
 * saves three empty tool calls.
 */
export const listClubs = defineTool({
  name: 'list_clubs',
  title: 'List clubs',
  description:
    'The clubs in the bag, with the club_id every other tool takes, plus how ' +
    'many shots each has on record and when it was last hit. Call this first ' +
    'to resolve a club name a golfer used ("7 iron", "60° half swing") into ' +
    'an id. Archived clubs are excluded unless asked for.',
  inputSchema: {
    include_archived: z
      .boolean()
      .optional()
      .describe('include clubs retired from the bag; default false'),
  },
  async run({ data }, args) {
    // The history is read unfiltered and the archived clubs dropped after,
    // rather than asking the DAO for the filtered set: a shot's club may be
    // archived, and counting only live clubs' shots would still be correct
    // but would run a second query to find that out.
    const { shots, clubs } = await loadShotHistory(data);

    const counts = new Map<string, { n: number; last: number }>();
    for (const shot of shots) {
      const entry = counts.get(shot.clubId);
      if (entry) {
        entry.n += 1;
        entry.last = Math.max(entry.last, shot.capturedAt);
      } else {
        counts.set(shot.clubId, { n: 1, last: shot.capturedAt });
      }
    }

    const includeArchived = args.include_archived ?? false;
    return {
      clubs: clubs
        .filter((club) => includeArchived || !club.archived)
        .map((club) => ({
          club_id: club.id,
          name: club.name,
          category: club.category,
          loft_deg: club.loftDeg,
          swing_tag: club.swingTag,
          focus_note: club.focusNote,
          archived: club.archived,
          shot_count: counts.get(club.id)?.n ?? 0,
          last_shot_at_ms: counts.get(club.id)?.last ?? null,
        })),
    };
  },
});
