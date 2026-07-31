import { Club, DataStore, ShotRecord } from '@golf/types';

/**
 * Every shot ever recorded, plus the clubs to resolve them against.
 *
 * The analytics engine's findings and baselines are cross-session by
 * definition — one session can never clear the persistence guardrail — so
 * this deliberately asks for the all-time history (no `sinceSessionId`)
 * rather than any single session's shots. Archived clubs are included: a club
 * retired last month still owns the shots it hit, and dropping them would
 * silently rewrite history.
 *
 * Lives here rather than at a call site because three separate loops need the
 * exact same history — the coach recap, the prescription loop, and the MCP
 * query surface — and a second definition that quietly differed in scope
 * would put them on different data while agreeing on the numbers.
 */
export async function loadShotHistory(
  data: DataStore,
): Promise<{ shots: ShotRecord[]; clubs: Club[] }> {
  const clubs = await data.listClubs({ includeArchived: true });
  const perClub = await Promise.all(
    clubs.map((club) => data.listShotsByClub(club.id)),
  );
  return { shots: perClub.flat(), clubs };
}
