import { buildWristSessionExport, WristSessionExport } from '@golf/analytics';
import {
  Club,
  Handedness,
  Session,
  ShotIntent,
  ShotRecord,
  WristCoachBlock,
  WristCoachCoverage,
  WristSwingRecord,
} from '@golf/types';
import { z } from 'zod';

/**
 * Daily session-JSON export, contract v3 — the payload the Reform Coach
 * agent consumes. Extends the wrist portion (libs/analytics/wrist-export,
 * the tools/wrist-coach-export.ts CLI shape) with the launch/flight portion:
 * per-shot measured + flight-model numbers, intent/warmup tags, and the
 * session's club table. Pure assembly: no statistics beyond what the
 * underlying builders already compute, snake_case wire keys, and
 * omission-over-garbage — a null measurement is omitted, never zero-filled.
 * Derived numeric metrics only; raw sensor streams and video never ride
 * this payload (BUILD_SPEC §8.3).
 */

type Handed = z.infer<typeof Handedness>;

export const EXPORT_CONTRACT_VERSION = 3;

export interface ExportShotRow {
  shot_guid: string;
  club_id: string;
  intent: ShotIntent;
  warmup: boolean;
  discarded: boolean;
  t_ms: number;
  ball_speed_ms?: number;
  club_speed_ms?: number;
  smash?: number;
  launch_deg?: number;
  launch_dir_deg?: number;
  backspin_rpm?: number;
  sidespin_rpm?: number;
  carry_m?: number;
  total_m?: number;
  apex_m?: number;
  offline_m?: number;
  curve_m?: number;
  wrist?: WristCoachBlock;
}

export interface ExportClubRow {
  id: string;
  name: string;
  category: Club['category'];
  loft_deg: number | null;
}

export interface DailySessionExport {
  contract: number;
  session_id: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  default_intent: ShotIntent;
  handedness: Handed;
  environment: { altitude_m: number; temperature_c: number | null };
  clubs: ExportClubRow[];
  shots: ExportShotRow[];
  wrist_coverage: WristCoachCoverage;
  wrist_strap_drift: boolean;
}

const round = (value: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** spread-fragment for a nullable measurement — omission over garbage */
const opt = <K extends keyof ExportShotRow>(
  key: K,
  value: number | null,
  digits: number,
): Partial<ExportShotRow> =>
  value === null ? {} : { [key]: round(value, digits) };

export function buildDailySessionExport(
  session: Session,
  shots: ShotRecord[],
  wristSwings: WristSwingRecord[],
  clubs: Club[],
  handedness: Handed,
): DailySessionExport {
  const ordered = [...shots].sort((a, b) => a.capturedAt - b.capturedAt);
  const wrist: WristSessionExport = buildWristSessionExport(
    wristSwings,
    ordered.map((s) => ({ id: s.id, tMs: s.capturedAt })),
    handedness,
  );

  const usedClubIds = new Set(ordered.map((s) => s.clubId));
  const clubRows: ExportClubRow[] = clubs
    .filter((c) => usedClubIds.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      loft_deg: c.loftDeg,
    }));

  const shotRows = ordered.map((shot): ExportShotRow => {
    const { ball, club, smashFactor } = shot.measured;
    const block = wrist.blocks[shot.id];
    return {
      shot_guid: shot.shotGuid,
      club_id: shot.clubId,
      intent: shot.intent,
      warmup: shot.warmup,
      discarded: shot.discarded,
      t_ms: shot.capturedAt,
      ball_speed_ms: round(ball.speedMs, 2),
      launch_deg: round(ball.launchAngleDeg, 1),
      launch_dir_deg: round(ball.launchDirectionDeg, 1),
      backspin_rpm: round(ball.backspinRpm, 0),
      sidespin_rpm: round(ball.sidespinRpm, 0),
      ...opt('club_speed_ms', club.speedMs, 2),
      ...opt('smash', smashFactor, 3),
      ...opt('carry_m', shot.flight?.carryM ?? null, 1),
      ...opt('total_m', shot.flight?.totalM ?? null, 1),
      ...opt('apex_m', shot.flight?.apexM ?? null, 1),
      ...opt('offline_m', shot.flight?.offlineM ?? null, 1),
      ...opt('curve_m', shot.flight?.curveM ?? null, 1),
      ...(block !== undefined ? { wrist: block } : {}),
    };
  });

  return {
    contract: EXPORT_CONTRACT_VERSION,
    session_id: session.id,
    started_at_ms: session.startedAt,
    ended_at_ms: session.endedAt,
    default_intent: session.defaultIntent,
    handedness,
    environment: {
      altitude_m: session.environment.altitudeM,
      temperature_c: session.environment.temperatureC,
    },
    clubs: clubRows,
    shots: shotRows,
    wrist_coverage: wrist.coverage,
    wrist_strap_drift: wrist.strapDrift,
  };
}
