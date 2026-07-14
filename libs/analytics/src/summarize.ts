import {
  AnalyticsEngine,
  Baseline,
  BaselineGap,
  Club,
  ClubSummary,
  Environment,
  MetricStat,
  SessionSummary,
  ShotRecord,
} from '@golf/types';

import { computeContact } from './contact';
import { computeDispersion, LandingPoint } from './dispersion';
import { computeGapping } from './gapping';
import { METRIC_KEYS, MetricKey, metricValue } from './metric-keys';
import { computeMetricStat, mean } from './stats';

export interface SummarizeClubOptions {
  /**
   * Curated, cited reference numbers for this club's category/level. When
   * provided, `baselineGap.perMetricDelta` = golfer mean − baseline value
   * over the metric keys present on BOTH sides; otherwise `baselineGap` is
   * null. Baselines are never generated here.
   */
  baseline?: Baseline;
}

const measuredValues = (shots: ShotRecord[], key: MetricKey): number[] =>
  shots.flatMap((shot) => {
    const value = metricValue(shot, key);
    return value === null ? [] : [value];
  });

/**
 * mean(faceAngleDeg) − mean(clubPathDeg) — the curvature driver — computed
 * ONLY over shots where BOTH angles were measured, so a shot missing one of
 * them can't skew the other side of the subtraction. Null when no shot
 * measured both.
 */
const computePathFaceGap = (shots: ShotRecord[]): number | null => {
  const pairs = shots.flatMap((shot) => {
    const face = shot.measured.club.faceAngleDeg;
    const path = shot.measured.club.pathDeg;
    return face === null || path === null ? [] : [{ face, path }];
  });
  if (pairs.length === 0) return null;
  return mean(pairs.map((p) => p.face)) - mean(pairs.map((p) => p.path));
};

const computeBaselineGap = (
  metrics: Record<string, MetricStat>,
  baseline: Baseline,
): BaselineGap => {
  const perMetricDelta: Record<string, number> = {};
  for (const [key, baselineValue] of Object.entries(baseline.metrics)) {
    const stat: MetricStat | undefined = metrics[key];
    if (stat !== undefined) perMetricDelta[key] = stat.mean - baselineValue;
  }
  return { source: baseline.source, level: baseline.level, perMetricDelta };
};

/** Core per-club aggregation over shots already filtered to non-discarded. */
const buildClubSummary = (
  clubId: string,
  clubName: string,
  shots: ShotRecord[],
  baseline: Baseline | undefined,
  focusNote: string | null = null,
): ClubSummary => {
  const metrics: Record<string, MetricStat> = {};
  for (const key of METRIC_KEYS) {
    const stat = computeMetricStat(measuredValues(shots, key));
    // Null rule: a metric no shot measured is omitted entirely — no fake
    // zero-stats. When present, stat.n is the measured count, which may be
    // smaller than shotCount.
    if (stat !== null) metrics[key] = stat;
  }

  const landings: LandingPoint[] = shots.flatMap((shot) =>
    shot.flight === null ? [] : [shot.flight.landing],
  );

  const carryM: MetricStat | null = metrics['carryM'] ?? null;

  return {
    clubId,
    clubName,
    focusNote,
    shotCount: shots.length,
    metrics,
    dispersion: computeDispersion(landings),
    contact: computeContact(shots),
    pathFaceGapDeg: computePathFaceGap(shots),
    carryM,
    baselineGap:
      baseline === undefined ? null : computeBaselineGap(metrics, baseline),
  };
};

/**
 * Summarize one club's shots. Discarded shots are excluded from every stat.
 *
 * `clubName` falls back to the clubId — `ShotRecord` carries no club name;
 * `summarizeSession` resolves real names via its `clubs` parameter (the app
 * always passes it).
 */
export const summarizeClub = (
  shots: ShotRecord[],
  opts?: SummarizeClubOptions,
): ClubSummary => {
  const clubId = shots.length > 0 ? shots[0].clubId : '';
  const active = shots.filter((shot) => !shot.discarded);
  return buildClubSummary(clubId, clubId, active, opts?.baseline);
};

/**
 * Summarize a whole session. Discarded shots are excluded from everything:
 * `shotCount` is the non-discarded total across all clubs, `clubs` holds one
 * ClubSummary per club (in order of first appearance), and `gapping` is the
 * carry ladder over clubs that have computed carry data.
 *
 * `clubs` (optional third parameter — the app always passes it) resolves club
 * ids to display names; unknown ids fall back to the id itself.
 */
export const summarizeSession = (
  shots: ShotRecord[],
  env: Environment,
  clubs?: Club[],
): SessionSummary => {
  const sessionId = shots.length > 0 ? shots[0].sessionId : '';
  const active = shots.filter((shot) => !shot.discarded);

  const clubById = new Map<string, Club>(
    (clubs ?? []).map((club) => [club.id, club]),
  );

  const byClub = new Map<string, ShotRecord[]>();
  for (const shot of active) {
    const group = byClub.get(shot.clubId);
    if (group === undefined) byClub.set(shot.clubId, [shot]);
    else group.push(shot);
  }

  const clubSummaries = [...byClub.entries()].map(([clubId, clubShots]) =>
    buildClubSummary(
      clubId,
      clubById.get(clubId)?.name ?? clubId,
      clubShots,
      undefined,
      clubById.get(clubId)?.focusNote ?? null,
    ),
  );

  return {
    sessionId,
    environment: env,
    shotCount: active.length,
    clubs: clubSummaries,
    gapping: computeGapping(clubSummaries),
  };
};

/** The lib's `AnalyticsEngine` implementation — pure, local, deterministic. */
export const analyticsEngine: AnalyticsEngine = {
  summarizeSession,
  summarizeClub,
};
