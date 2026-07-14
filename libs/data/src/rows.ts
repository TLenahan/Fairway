import {
  AnalysisRecord,
  AnalysisRecordSchema,
  Club,
  ClubSchema,
  Session,
  SessionSchema,
  ShotRecord,
  ShotRecordSchema,
} from '@golf/types';

/**
 * Raw SQLite row shapes (schema v1, migrations.ts) and the pure mapping
 * functions to the `@golf/types` domain objects. Every read is validated
 * through the contract Zod schema so a corrupt row fails loudly instead of
 * leaking bad data — and NULL columns stay `null`, never 0.
 */

export interface ClubRow {
  id: string;
  name: string;
  category: string;
  sensor_mode: string;
  swing_tag: string | null;
  loft_deg: number | null;
  notes: string | null;
  archived: number;
  created_at: number;
}

export function mapClubRow(row: ClubRow): Club {
  return ClubSchema.parse({
    id: row.id,
    name: row.name,
    category: row.category,
    sensorMode: row.sensor_mode,
    swingTag: row.swing_tag,
    loftDeg: row.loft_deg,
    notes: row.notes,
    archived: row.archived === 1,
    createdAt: row.created_at,
  });
}

export interface SessionRow {
  id: string;
  name: string | null;
  notes: string | null;
  started_at: number;
  ended_at: number | null;
  altitude_m: number;
  temperature_c: number | null;
  env_preset: string | null;
  created_at: number;
}

export function mapSessionRow(row: SessionRow): Session {
  return SessionSchema.parse({
    id: row.id,
    name: row.name,
    notes: row.notes,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    environment: {
      altitudeM: row.altitude_m,
      temperatureC: row.temperature_c,
      presetName: row.env_preset,
    },
    createdAt: row.created_at,
  });
}

export interface ShotRow {
  id: string;
  session_id: string;
  club_id: string;
  shot_guid: string;
  captured_at: number;
  impact_timestamp: number;
  discarded: number;
  handedness: string;
  // MEASURED (SI; NULL = not measured, never 0)
  ball_speed_ms: number;
  launch_angle_deg: number;
  launch_direction_deg: number;
  backspin_rpm: number;
  sidespin_rpm: number;
  rollspin_rpm: number;
  club_speed_ms: number | null;
  club_path_deg: number | null;
  face_angle_deg: number | null;
  attack_angle_deg: number | null;
  loft_deg: number | null;
  lie_deg: number | null;
  face_impact_h_mm: number | null;
  face_impact_v_mm: number | null;
  // assurance (auditable null-reason per club metric)
  assurance_spin: number;
  assurance_clubspeed: number;
  assurance_clubpath: number;
  assurance_faceangle: number;
  assurance_attackangle: number;
  assurance_loftangle: number;
  assurance_lieangle: number;
  assurance_faceimpact_lateral: number;
  assurance_faceimpact_vertical: number;
  // DERIVED
  smash_factor: number | null;
  shot_img_path: string | null;
  // COMPUTED (FlightModel; NULL until computed)
  carry_m: number | null;
  total_m: number | null;
  apex_m: number | null;
  descent_deg: number | null;
  flight_time_s: number | null;
  offline_m: number | null;
  rollout_m: number | null;
  landing_x_m: number | null;
  landing_z_m: number | null;
  flight_path_json: string | null;
  raw_json: string;
}

/**
 * Column view → `ShotRecord`. `flight` is null exactly when `carry_m` IS NULL
 * (the computed columns are written atomically, so `carry_m` is the sentinel).
 */
export function mapShotRow(row: ShotRow): ShotRecord {
  return ShotRecordSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    clubId: row.club_id,
    shotGuid: row.shot_guid,
    capturedAt: row.captured_at,
    discarded: row.discarded === 1,
    measured: {
      shotGuid: row.shot_guid,
      handedness: row.handedness,
      impactTimestamp: row.impact_timestamp,
      ball: {
        speedMs: row.ball_speed_ms,
        launchAngleDeg: row.launch_angle_deg,
        launchDirectionDeg: row.launch_direction_deg,
        backspinRpm: row.backspin_rpm,
        sidespinRpm: row.sidespin_rpm,
        rollspinRpm: row.rollspin_rpm,
        spinAssurance: row.assurance_spin,
      },
      club: {
        speedMs: row.club_speed_ms,
        pathDeg: row.club_path_deg,
        faceAngleDeg: row.face_angle_deg,
        attackAngleDeg: row.attack_angle_deg,
        loftDeg: row.loft_deg,
        lieDeg: row.lie_deg,
        faceImpactHMm: row.face_impact_h_mm,
        faceImpactVMm: row.face_impact_v_mm,
      },
      assurance: {
        spin: row.assurance_spin,
        clubSpeed: row.assurance_clubspeed,
        clubPath: row.assurance_clubpath,
        faceAngle: row.assurance_faceangle,
        attackAngle: row.assurance_attackangle,
        loftAngle: row.assurance_loftangle,
        lieAngle: row.assurance_lieangle,
        faceImpactLateral: row.assurance_faceimpact_lateral,
        faceImpactVertical: row.assurance_faceimpact_vertical,
      },
      smashFactor: row.smash_factor,
      shotImgPath: row.shot_img_path,
    },
    flight:
      row.carry_m === null
        ? null
        : {
            path: JSON.parse(row.flight_path_json ?? '[]') as unknown,
            carryM: row.carry_m,
            totalM: row.total_m,
            apexM: row.apex_m,
            descentDeg: row.descent_deg,
            flightTimeS: row.flight_time_s,
            offlineM: row.offline_m,
            landing: { x: row.landing_x_m, z: row.landing_z_m },
            rolloutM: row.rollout_m,
            computed: true,
          },
  });
}

export interface AnalysisRow {
  id: string;
  session_id: string;
  scope: string;
  model: string;
  created_at: number;
  verdict_json: string;
  narrative: string;
  input_summary_json: string;
}

/** Reads validate against `AnalysisRecordSchema` (contract rule). */
export function mapAnalysisRow(row: AnalysisRow): AnalysisRecord {
  return AnalysisRecordSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    scope: row.scope,
    model: row.model,
    createdAt: row.created_at,
    verdict: JSON.parse(row.verdict_json) as unknown,
    narrative: row.narrative,
    inputSummary: JSON.parse(row.input_summary_json) as unknown,
  });
}
