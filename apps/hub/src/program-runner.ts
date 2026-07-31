import { loadShotHistory } from '@golf/data';
import { analyzeShots, serializeReport, toInsightShots } from '@golf/insights';
import {
  TrainingBlockWire,
  planTrainingBlocks,
  resolveBlockWire,
} from '@golf/program';
import { Club, DataStore, TrainingBlock } from '@golf/types';

import { HubInsightsPayload } from './shared/protocol';

/**
 * The hub's driver for the §6.10 prescription loop.
 *
 * The planner in @golf/program is pure — `planTrainingBlocks` decides what to
 * prescribe and what to judge but touches nothing. This module is the one place
 * that turns that decision into persisted rows, so there is exactly one answer to
 * "when does a block get written?" and every caller (the insights endpoint,
 * the nightly coach recap) gets the same one.
 *
 * IDEMPOTENT BY CONSTRUCTION, which is what makes it safe to run from a GET:
 * - `prescribe` skips any finding a non-abandoned block already covers, so a
 *   second run over unchanged history writes no new blocks;
 * - `evaluateBlock` returns 'active' while a re-measure window is still open,
 *   and this function only persists a verdict that is NOT 'active' — a block
 *   whose window has not filled is left exactly as it was.
 * Running it twice in a row therefore leaves the store in the same state as
 * running it once. That property is load-bearing, not incidental: it is
 * asserted directly in program-runner.spec.ts.
 *
 * `now` is a parameter rather than a `Date.now()` call so the loop stays
 * testable and so a prescription's `startedAt` and a resolution's
 * `resolvedAt` come from one instant, not from two clock reads.
 */
export async function runProgramLoop(
  data: DataStore,
  now: number,
): Promise<{
  payload: HubInsightsPayload;
  prescribed: TrainingBlock[];
  resolved: TrainingBlock[];
}> {
  const { shots, clubs } = await loadShotHistory(data);
  const insightShots = toInsightShots(shots, clubs);
  const report = analyzeShots(insightShots);

  const clubCategories = new Map(
    clubs.map((club): [string, Club['category']] => [club.id, club.category]),
  );
  const existing = await data.listTrainingBlocks();

  const plan = planTrainingBlocks({
    report,
    shots: insightShots,
    clubCategories,
    existing,
    now,
  });

  // Sequential rather than Promise.all: these are writes against one SQLite
  // connection, and the insert order is the plan's order, which is stable.
  const prescribed: TrainingBlock[] = [];
  for (const block of plan.prescribe) {
    prescribed.push(await data.insertTrainingBlock(block));
  }

  const resolved: TrainingBlock[] = [];
  for (const { block, verdict } of plan.verdicts) {
    // An 'active' verdict is progress, not a change — the window is still
    // open (or the evidence is missing). Writing it would churn the row and
    // break the idempotence the endpoint depends on.
    if (verdict.status === 'active') continue;
    await data.updateTrainingBlockStatus(
      block.id,
      verdict.status,
      now,
      verdict.note,
    );
    resolved.push({
      ...block,
      status: verdict.status,
      resolvedAt: now,
      resolutionNote: verdict.note,
    });
  }

  // Re-read rather than patching the in-memory list: the store is the truth
  // about what was actually written, including the ids and createdAt stamps
  // it minted for the new blocks.
  const current = await data.listTrainingBlocks();
  const blocks = current
    // Abandoned blocks are dismissed work. They stay on file (an abandoned
    // block frees its finding to be prescribed again) but have nothing to
    // say to a UI or a coach.
    .filter((block) => block.status !== 'abandoned')
    .map(resolveBlockWire)
    .sort(compareBlocks);

  // The same `report` the plan was built from is what gets serialized —
  // `serializeReport` is the only projection of a report onto the wire, so
  // the payload cannot describe a different engine run than the one that
  // decided these prescriptions.
  return {
    payload: { ...serializeReport(report, clubs), blocks },
    prescribed,
    resolved,
  };
}

/**
 * Active first, then most recently started. Live work is what a golfer acts
 * on; resolved blocks are history and read newest-first. Ties break on id so
 * two blocks issued in the same `now` never swap places between runs.
 */
function compareBlocks(a: TrainingBlockWire, b: TrainingBlockWire): number {
  const aActive = a.status === 'active' ? 0 : 1;
  const bActive = b.status === 'active' ? 0 : 1;
  if (aActive !== bActive) return aActive - bActive;
  if (a.started_at_ms !== b.started_at_ms) return b.started_at_ms - a.started_at_ms;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
