import { Session, ShotRecord } from '@golf/types';
import { z } from 'zod';

import { defineTool } from './tool';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

/**
 * A session's shape at a glance. `focus_club_id` is the load-bearing field:
 * one session means one club (schema v10), so a session's focus is what its
 * shots are about. Null is legitimate — sessions written before v10, and
 * anything imported from the phone, are genuinely unfocused — and is reported
 * as null rather than guessed at, because a wrong guess here would attribute
 * a range trip to the wrong bucket.
 */
function toSessionWire(
  session: Session,
  shots: readonly ShotRecord[],
  clubName: (id: string) => string,
): Record<string, unknown> {
  const clubIds = [...new Set(shots.map((s) => s.clubId))];
  return {
    session_id: session.id,
    name: session.name,
    notes: session.notes,
    started_at_ms: session.startedAt,
    ended_at_ms: session.endedAt,
    focus_club_id: session.focusClubId,
    focus_club_name:
      session.focusClubId === null ? null : clubName(session.focusClubId),
    default_intent: session.defaultIntent,
    shot_count: shots.length,
    warmup_count: shots.filter((s) => s.warmup).length,
    discarded_count: shots.filter((s) => s.discarded).length,
    clubs_hit: clubIds.map((id) => ({ club_id: id, name: clubName(id) })),
    environment: {
      altitude_m: session.environment.altitudeM,
      temperature_c: session.environment.temperatureC,
      preset_name: session.environment.presetName,
    },
  };
}

export const listSessions = defineTool({
  name: 'list_sessions',
  title: 'List practice sessions',
  description:
    'Practice sessions newest-first: when they ran, the club each was ' +
    'focused on, how many shots they hold, and the conditions. Use it to ' +
    'turn "last Tuesday" or "my last range trip" into a session_id, or to ' +
    'see how recently a club was worked on. A session with a null ' +
    'focus_club_id predates one-club sessions or was imported from the phone.',
  inputSchema: {
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_LIMIT)
      .optional()
      .describe(`newest N sessions; default ${DEFAULT_LIMIT}`),
    club_id: z
      .string()
      .optional()
      .describe('only sessions in which this club was hit'),
  },
  async run({ data }, args) {
    const clubs = await data.listClubs({ includeArchived: true });
    const names = new Map(clubs.map((c) => [c.id, c.name]));
    const clubName = (id: string): string => names.get(id) ?? 'Unknown';

    // Sessions come back newest-first, so the club filter has to run against
    // the shots BEFORE the limit is applied — slicing first would silently
    // return fewer than `limit` matching sessions (or none) whenever the
    // newest sessions were about a different club.
    const sessions = await data.listSessions();
    const withShots = await Promise.all(
      sessions.map(async (session) => ({
        session,
        shots: await data.listShots(session.id),
      })),
    );

    const matched = args.club_id
      ? withShots.filter(({ shots }) =>
          shots.some((s) => s.clubId === args.club_id),
        )
      : withShots;

    return {
      total_matched: matched.length,
      sessions: matched
        .slice(0, args.limit ?? DEFAULT_LIMIT)
        .map(({ session, shots }) => toSessionWire(session, shots, clubName)),
    };
  },
});
