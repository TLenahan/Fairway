import { randomUUID } from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';
import { buildDailySessionExport, parseCoachRecap } from '@golf/coach';
import {
  AnalysisVerdict,
  Club,
  DataStore,
  Handedness,
  ShotRecord,
} from '@golf/types';
import { z } from 'zod';

import { runProgramLoop } from '../program-runner';
import { ensureCoachResources, runCoachSession } from './coach-agent';

const COACH_MODEL = 'claude-opus-5';

export interface CoachRunnerConfig {
  client: Anthropic;
  data: DataStore;
  dataDir: string;
  handedness: z.infer<typeof Handedness>;
}

/**
 * Every shot ever recorded, plus the clubs to resolve them against. The
 * engine's findings and baselines are cross-session by definition — one
 * session can never clear the persistence guardrail — so this deliberately
 * asks for the all-time history (no `sinceSessionId`) rather than the
 * session the recap is about.
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

/**
 * The Phase 1 reform-program handoff: after a session ends, assemble the
 * daily export from the hub DB, run the Reform Coach managed agent, and
 * persist the recap to the analyses table (the same shape the phone app
 * already renders).
 */
export async function runDailyCoachRecap(
  config: CoachRunnerConfig,
  sessionId: string,
): Promise<void> {
  const { client, data } = config;
  const session = await data.getSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);

  const [shots, swings, clubs] = await Promise.all([
    data.listShots(sessionId),
    data.listWristSwings(sessionId),
    data.listClubs({ includeArchived: true }),
  ]);
  if (shots.length === 0) return; // nothing to coach

  // End of session is when this session's shots first reach the engine, so
  // it is also when a new finding earns its block and a filled re-measure
  // window gets judged — hence the loop runs here rather than only serving.
  // Its payload carries the engine wire AND the blocks in flight, so the
  // coach can see that a finding is already being worked instead of
  // re-prescribing it in prose.
  const { payload: insights } = await runProgramLoop(data, Date.now());

  // The coach consumes these numbers and never recomputes them (§6.12 rule 2).
  const payload = buildDailySessionExport(
    session,
    shots,
    swings,
    clubs,
    config.handedness,
    insights,
  );

  const resources = await ensureCoachResources(client, config.dataDir);
  const text = await runCoachSession(
    client,
    resources,
    JSON.stringify(payload),
    `Recap ${new Date(session.startedAt).toISOString().slice(0, 10)}`,
  );

  const recap = parseCoachRecap(text);
  const verdict: AnalysisVerdict = recap.verdict ?? {
    headline: recap.narrative.split('\n')[0]?.slice(0, 120) ?? 'Session recap',
    issues: [],
    strengths: [],
    drills: [],
    caveats: ['coach verdict JSON missing — narrative only'],
  };

  await data.saveAnalysis({
    id: randomUUID(),
    sessionId,
    scope: 'session',
    model: COACH_MODEL,
    createdAt: Date.now(),
    verdict,
    narrative: recap.narrative,
    inputSummary: payload,
  });
}
