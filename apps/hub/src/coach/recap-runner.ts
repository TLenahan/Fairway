import { randomUUID } from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';
import { buildDailySessionExport, parseCoachRecap } from '@golf/coach';
import { AnalysisVerdict, DataStore, Handedness } from '@golf/types';
import { z } from 'zod';

import { ensureCoachResources, runCoachSession } from './coach-agent';

const COACH_MODEL = 'claude-opus-5';

export interface CoachRunnerConfig {
  client: Anthropic;
  data: DataStore;
  dataDir: string;
  handedness: z.infer<typeof Handedness>;
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

  const payload = buildDailySessionExport(
    session,
    shots,
    swings,
    clubs,
    config.handedness,
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
