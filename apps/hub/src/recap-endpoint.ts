import { drillById } from '@golf/program';
import { AnalysisVerdict, DataStore } from '@golf/types';

import { RecapWire, RecapsPayload } from './shared/protocol';

/**
 * The coach references drills by id so a recap stays linked to the drill
 * library and the re-measure loop; resolve the display names here, where the
 * library is already loaded, rather than shipping it to the browser.
 */
function resolveDrillNames(verdict: AnalysisVerdict): Record<string, string> {
  const names: Record<string, string> = {};
  for (const drill of verdict.drills) {
    const found = drillById(drill.name);
    if (found) names[drill.name] = found.name;
  }
  return names;
}

/**
 * Reading side of the Reform Coach: the recaps it persists to the analyses
 * table, plus whether one is being written at this moment.
 */

export interface RecapTracker {
  begin(sessionId: string): void;
  succeed(): void;
  fail(message: string): void;
  snapshot(): { status: RecapsPayload['status']; error: string | null };
}

/**
 * In-memory only, and deliberately so: this tracks a single in-flight coach
 * run inside the hub process, and a run cannot survive a restart anyway —
 * persisting its state would only let a stale 'running' outlive the run.
 *
 * A failure sticks until the next `begin` so the UI reports it instead of
 * falling back to silence, which is indistinguishable from "no session yet".
 */
export function createRecapTracker(): RecapTracker {
  let status: RecapsPayload['status'] = 'idle';
  let error: string | null = null;

  return {
    begin() {
      status = 'running';
      error = null;
    },
    succeed() {
      status = 'idle';
      error = null;
    },
    fail(message) {
      status = 'error';
      error = message;
    },
    snapshot: () => ({ status, error }),
  };
}

/**
 * The `limit` newest recaps. Sessions come back newest-first, so only that
 * many need their analyses read — a session can hold more than one recap, but
 * never enough for an older session to displace a newer one's worth of them.
 */
export async function loadRecaps(
  data: DataStore,
  limit: number,
): Promise<RecapWire[]> {
  const sessions = (await data.listSessions()).slice(0, limit);
  const perSession = await Promise.all(
    sessions.map(async (session): Promise<RecapWire[]> => {
      const analyses = await data.listAnalyses(session.id);
      return analyses.map((analysis) => ({
        session_id: session.id,
        session_started_at_ms: session.startedAt,
        created_at_ms: analysis.createdAt,
        model: analysis.model,
        narrative: analysis.narrative,
        verdict: analysis.verdict,
        drill_names: resolveDrillNames(analysis.verdict),
      }));
    }),
  );
  return perSession
    .flat()
    .sort((a, b) => b.created_at_ms - a.created_at_ms)
    .slice(0, limit);
}
