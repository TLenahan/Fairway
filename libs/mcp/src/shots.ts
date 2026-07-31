import { GreatShotResult, InsightShot } from '@golf/insights';
import { ShotIntentSchema, ShotRecord } from '@golf/types';
import { z } from 'zod';

import { loadInsightsView } from './history';
import { defineTool } from './tool';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * One shot, as the engine sees it plus the measured channels the engine has
 * no opinion about.
 *
 * The statistical fields come from the engine's own projection
 * (`InsightShot`), not from the raw record — that is what makes a shot listed
 * here consistent with the baselines and findings computed over it. The wrist
 * angles are the clearest case: the projection prefers the calibrated
 * wrist-coach keyframes and only falls back to raw ones, so reading
 * `shot.wrist` directly here would show different numbers than the ones
 * `flipFlag` was decided from.
 *
 * Units are SI throughout — metres, m/s, degrees, rpm — matching the store,
 * the engine, and the coach payload. There is deliberately no second unit
 * convention in this codebase.
 */
function toShotWire(
  shot: ShotRecord,
  insight: InsightShot | undefined,
  great: GreatShotResult | undefined,
  clubName: string,
): Record<string, unknown> {
  return {
    shot_id: shot.id,
    session_id: shot.sessionId,
    club_id: shot.clubId,
    club_name: clubName,
    captured_at_ms: shot.capturedAt,
    intent: shot.intent,
    warmup: shot.warmup,
    discarded: shot.discarded,

    // Engine verdict. Null — not false — when this shot was never classified:
    // warmup, discarded, and `untagged` shots are outside every bucket, so
    // "was it great?" has no answer rather than a negative one.
    great: great?.great ?? null,
    great_criteria: great?.criteria ?? null,
    low_smash_cause: great?.lowSmashCause ?? null,

    ball_speed_ms: insight?.ballSpeedMs ?? shot.measured.ball.speedMs,
    club_speed_ms: insight?.clubSpeedMs ?? shot.measured.club.speedMs,
    smash: insight?.smash ?? shot.measured.smashFactor,
    launch_deg: insight?.launchDeg ?? shot.measured.ball.launchAngleDeg,
    launch_dir_deg:
      insight?.launchDirDeg ?? shot.measured.ball.launchDirectionDeg,
    backspin_rpm: insight?.backspinRpm ?? shot.measured.ball.backspinRpm,
    sidespin_rpm: insight?.sidespinRpm ?? shot.measured.ball.sidespinRpm,

    // Measured club delivery the engine does not mine — null when the
    // device's assurance for that channel was 0 (never 0-as-a-value).
    club_path_deg: shot.measured.club.pathDeg,
    face_angle_deg: shot.measured.club.faceAngleDeg,
    attack_angle_deg: shot.measured.club.attackAngleDeg,
    strike_h_mm: insight?.strikeHMm ?? shot.measured.club.faceImpactHMm,
    strike_v_mm: insight?.strikeVMm ?? shot.measured.club.faceImpactVMm,

    // Flight is always computed, never sensed (the EYE MINI reports no
    // carry). Null until the flight model has run for this shot.
    carry_m: insight?.carryM ?? shot.flight?.carryM ?? null,
    total_m: insight?.totalM ?? shot.flight?.totalM ?? null,
    apex_m: insight?.apexM ?? shot.flight?.apexM ?? null,
    offline_m: insight?.offlineM ?? shot.flight?.offlineM ?? null,
    curve_m: insight?.curveM ?? shot.flight?.curveM ?? null,
    descent_deg: shot.flight?.descentDeg ?? null,
    rollout_m: shot.flight?.rolloutM ?? null,

    // Wrist mechanics, present only when a swing joined this shot.
    wrist: shot.wrist
      ? {
          flip_flag: insight?.flipFlag ?? null,
          ext_top_deg: insight?.wristExtTop ?? null,
          ext_impact_deg: insight?.wristExtImpact ?? null,
          ext_peak_down_deg: insight?.wristExtPeakDown ?? null,
          calibrated: shot.wrist.calibrated,
          backswing_ms: shot.wrist.backswingMs,
          downswing_ms: shot.wrist.downswingMs,
          top_pause_ms: shot.wrist.topPauseMs,
        }
      : null,
  };
}

export const queryShots = defineTool({
  name: 'query_shots',
  title: 'Query shots',
  description:
    'Individual shots with their measured and computed numbers, filtered by ' +
    'club, intent, session, or time, and annotated with the engine\'s ' +
    'great-shot verdict. Use it to inspect what actually happened — a bad ' +
    'stretch, one session\'s dispersion, the shots behind a finding. All ' +
    'units are SI: metres, m/s, degrees, rpm; convert for display. Warmup ' +
    'and discarded shots are excluded by default because no statistic counts ' +
    'them. Results are newest-first and capped; total_matched reports how ' +
    'many passed the filter before the cap.',
  inputSchema: {
    club_id: z.string().optional(),
    intent: ShotIntentSchema.optional().describe(
      'stock | draw | fade | untagged (untagged is the quarantine bucket — ' +
        'those shots are in no statistic)',
    ),
    session_id: z.string().optional(),
    since_ms: z.number().int().optional().describe('capturedAt >= this epoch ms'),
    until_ms: z.number().int().optional().describe('capturedAt <= this epoch ms'),
    great_only: z
      .boolean()
      .optional()
      .describe("only shots the engine classified great; implies the shot was in a bucket"),
    include_warmup: z.boolean().optional(),
    include_discarded: z.boolean().optional(),
    order: z.enum(['newest', 'oldest']).optional().describe('default newest'),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_LIMIT)
      .optional()
      .describe(`default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}`),
  },
  async run({ data }, args) {
    const view = await loadInsightsView(data);

    const insights = new Map(view.insightShots.map((s) => [s.id, s]));
    const greats = new Map<string, GreatShotResult>();
    for (const bucket of view.report.buckets) {
      for (const result of bucket.greatShots) greats.set(result.shotId, result);
    }

    const matched = view.shots.filter((shot) => {
      if (args.club_id !== undefined && shot.clubId !== args.club_id) return false;
      if (args.intent !== undefined && shot.intent !== args.intent) return false;
      if (args.session_id !== undefined && shot.sessionId !== args.session_id)
        return false;
      if (args.since_ms !== undefined && shot.capturedAt < args.since_ms)
        return false;
      if (args.until_ms !== undefined && shot.capturedAt > args.until_ms)
        return false;
      if (!args.include_warmup && shot.warmup) return false;
      if (!args.include_discarded && shot.discarded) return false;
      if (args.great_only && greats.get(shot.id)?.great !== true) return false;
      return true;
    });

    // Sort a copy: `view.shots` is club-major (one query per club), so its
    // natural order is not chronological at all. Id breaks ties so the order
    // is total — two shots can share a millisecond (a bulk import, or the
    // phone DB arriving), and an arbitrary tiebreak would make a paged read
    // silently skip or repeat one.
    const ordered = [...matched].sort((a, b) => {
      const byTime =
        args.order === 'oldest'
          ? a.capturedAt - b.capturedAt
          : b.capturedAt - a.capturedAt;
      if (byTime !== 0) return byTime;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return {
      total_matched: ordered.length,
      shots: ordered
        .slice(0, args.limit ?? DEFAULT_LIMIT)
        .map((shot) =>
          toShotWire(
            shot,
            insights.get(shot.id),
            greats.get(shot.id),
            view.clubName(shot.clubId),
          ),
        ),
    };
  },
});
