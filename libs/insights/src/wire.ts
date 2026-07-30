import { Club, ShotIntent, ShotRecord } from '@golf/types';

import { DEFAULT_INSIGHTS_CONFIG, InsightsConfig } from './config';
import { analyzeShots } from './engine';
import { toInsightShot } from './projection';
import {
  CertificationStatus,
  ChangepointVerdict,
  FailureMode,
  InsightMetricKey,
  InsightShot,
} from './types';

/**
 * The engine's serializable output — the ONE shape that leaves this lib.
 *
 * Consumed by (a) the Reform Coach daily payload and (b) the hub UI. Per
 * BUILD_SPEC §6.12 rule 2 the coach CONSUMES these numbers and never
 * recomputes them, and per §8.3 only derived numeric metrics ever leave the
 * machine — this shape is deliberately narrow: counts, classifications, and
 * windowed statistics, never raw shots.
 *
 * snake_case because it is an LLM wire payload; the UI reads the same shape
 * so there is exactly one contract to keep in sync.
 */

export interface FindingWire {
  club_id: string;
  club_name: string;
  intent: ShotIntent;
  failure_mode: FailureMode;
  metric: InsightMetricKey;
  /** Cohen's d, bad relative to great. */
  effect_size: number;
  /** whether the bad bucket sits higher or lower on this metric */
  direction: 'higher' | 'lower';
  sessions_seen: number;
  counts: {
    bad: number;
    great: number;
    /** the "14 of your last 18" number: bad shots outside the great IQR */
    bad_beyond_great_range: number;
  };
}

export interface BucketStatusWire {
  club_id: string;
  club_name: string;
  intent: ShotIntent;
  n_total: number;
  n_great: number;
  great_rate: number | null;
  certification: CertificationStatus;
  /** windowed composite; never a per-swing number */
  dispersion_index: number | null;
  carry_sigma_m: number | null;
  offline_sigma_m: number | null;
  changepoint: ChangepointVerdict;
  /** systematic offsets — aim/setup/fitting notes, explicitly NOT drills */
  bias: { metric: InsightMetricKey; mean_offset: number }[];
  /** metrics whose variance tracks outcome variance — the drill candidates */
  variance_drivers: InsightMetricKey[];
  carry_variance_dominant: 'speed' | 'smash' | 'launchSpin' | null;
}

export interface InsightsWire {
  findings: FindingWire[];
  buckets: BucketStatusWire[];
}

const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Project persisted shots into engine shots, dropping unknown clubs. */
export function toInsightShots(
  shots: readonly ShotRecord[],
  clubs: readonly Club[],
): InsightShot[] {
  const category = new Map(clubs.map((c) => [c.id, c.category]));
  const out: InsightShot[] = [];
  for (const shot of shots) {
    const cat = category.get(shot.clubId);
    if (cat === undefined) continue;
    out.push(toInsightShot(shot, cat));
  }
  return out;
}

/**
 * Run the engine over a shot history and serialize it. `shots` should be the
 * full history for the clubs in play — findings and baselines are
 * cross-session by definition; a single session is not enough to certify or
 * to clear the persistence guardrail.
 */
export function buildInsightsWire(
  shots: readonly ShotRecord[],
  clubs: readonly Club[],
  config: InsightsConfig = DEFAULT_INSIGHTS_CONFIG,
): InsightsWire {
  const name = new Map(clubs.map((c) => [c.id, c.name]));
  const report = analyzeShots(toInsightShots(shots, clubs), config);

  return {
    findings: report.findings.map((f) => ({
      club_id: f.key.clubId,
      club_name: name.get(f.key.clubId) ?? 'Unknown',
      intent: f.key.intent,
      failure_mode: f.failureMode,
      metric: f.metric,
      effect_size: round(f.effectSize, 2),
      direction: f.direction,
      sessions_seen: f.sessionsSeen,
      counts: {
        bad: f.counts.bad,
        great: f.counts.great,
        bad_beyond_great_range: f.counts.badBeyondGreatRange,
      },
    })),
    buckets: report.buckets.map((b) => ({
      club_id: b.key.clubId,
      club_name: name.get(b.key.clubId) ?? 'Unknown',
      intent: b.key.intent,
      n_total: b.nTotal,
      n_great: b.certification.nGreat,
      great_rate:
        b.certification.greatRate === null
          ? null
          : round(b.certification.greatRate, 3),
      certification: b.certification.status,
      dispersion_index:
        b.dispersionIndex.value === null
          ? null
          : round(b.dispersionIndex.value, 2),
      carry_sigma_m:
        b.dispersion?.carrySigma == null ? null : round(b.dispersion.carrySigma, 1),
      offline_sigma_m:
        b.dispersion?.offlineSigma == null
          ? null
          : round(b.dispersion.offlineSigma, 1),
      changepoint: b.changepoint.verdict,
      bias: b.biasVariance
        .filter((e) => e.classification === 'bias' && e.meanOffset !== null)
        .map((e) => ({
          metric: e.metric,
          mean_offset: round(e.meanOffset ?? 0, 2),
        })),
      variance_drivers: b.biasVariance
        .filter((e) => e.classification === 'variance-driver')
        .map((e) => e.metric),
      carry_variance_dominant: b.carryDecomposition.dominant,
    })),
  };
}
