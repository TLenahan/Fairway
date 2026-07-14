import {
  AnalysisRecord,
  AnalysisScope,
  Baseline,
  BaselineSet,
  Environment,
  SessionSummary,
} from '@golf/types';
import { z } from 'zod';

import { SCOPE_INSTRUCTIONS } from './prompts';

type Scope = z.infer<typeof AnalysisScope>;

export interface AnalysisInput {
  current: SessionSummary;
  priorSummaries?: SessionSummary[];
  priorAnalyses?: AnalysisRecord[];
  environment: Environment;
}

/**
 * The exact object sent to Claude (also persisted as the auditable
 * inputSummary). COMPUTED aggregates only — never raw shot rows; the model
 * interprets, it does not do arithmetic (BUILD_SPEC §10.5).
 */
export interface AnalysisPayload {
  scope: Scope;
  instruction: string;
  environment: Environment;
  /** metric keys whose values are flight-model estimates, not sensor data */
  computedMetricKeys: string[];
  current: SessionSummary;
  priorSummaries?: SessionSummary[];
  /** prior verdicts only (headline/issues/drills) — continuity, not re-diagnosis */
  priorVerdicts?: {
    createdAt: number;
    scope: Scope;
    headline: string;
    issues: AnalysisRecord['verdict']['issues'];
    drills: AnalysisRecord['verdict']['drills'];
  }[];
  baselines: Baseline[];
}

export const COMPUTED_METRIC_KEYS = ['carryM', 'totalM', 'apexM', 'offlineM'];

/** Baselines for the club categories present in the summary — never invented. */
function relevantBaselines(
  summary: SessionSummary,
  baselineSet: BaselineSet,
): Baseline[] {
  // ClubSummary doesn't carry the category; offer the full curated set (it is
  // tiny and cited) and let the model match clubs by name/level.
  void summary;
  return baselineSet.list();
}

export function buildAnalysisPayload(
  scope: Scope,
  input: AnalysisInput,
  baselineSet: BaselineSet,
): AnalysisPayload {
  const wantsPriors = scope === 'trend' || scope === 'compare';
  return {
    scope,
    instruction: SCOPE_INSTRUCTIONS[scope],
    environment: input.environment,
    computedMetricKeys: COMPUTED_METRIC_KEYS,
    current: input.current,
    ...(wantsPriors && input.priorSummaries?.length
      ? { priorSummaries: input.priorSummaries }
      : {}),
    ...(input.priorAnalyses?.length
      ? {
          priorVerdicts: input.priorAnalyses.map((a) => ({
            createdAt: a.createdAt,
            scope: a.scope,
            headline: a.verdict.headline,
            issues: a.verdict.issues,
            drills: a.verdict.drills,
          })),
        }
      : {}),
    baselines: relevantBaselines(input.current, baselineSet),
  };
}

export function payloadToUserMessage(payload: AnalysisPayload): string {
  return [
    payload.instruction,
    '',
    'Computed data payload (JSON):',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}
