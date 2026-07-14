import {
  categoryToSensorMode,
  AnalysisRecord,
  Club,
  DataStore,
  FlightResult,
  MeasuredShot,
  Session,
  ShotRecord,
} from '@golf/types';

import { SqlDatabase, SqlValue } from './database';
import {
  mapAnalysisRow,
  mapClubRow,
  mapSessionRow,
  mapShotRow,
  AnalysisRow,
  ClubRow,
  SessionRow,
  ShotRow,
} from './rows';

/** insertShot hit the shot_guid UNIQUE constraint — the shot already exists. */
export class DuplicateShotError extends Error {
  constructor(shotGuid: string) {
    super(`Shot already recorded: ${shotGuid}`);
    this.name = 'DuplicateShotError';
  }
}

export interface DataStoreOptions {
  now?(): number;
  newId?(): string;
}

const defaultNewId = (): string => {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && 'randomUUID' in cryptoApi) return cryptoApi.randomUUID();
  // Fallback for runtimes without WebCrypto (documented: time + random).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export function createDataStore(
  db: SqlDatabase,
  opts: DataStoreOptions = {},
): DataStore {
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? defaultNewId;

  async function getClub(id: string): Promise<Club> {
    const row = await db.getFirstAsync<ClubRow>(
      'SELECT * FROM clubs WHERE id = ?',
      [id],
    );
    if (!row) throw new Error(`Unknown club: ${id}`);
    return mapClubRow(row);
  }

  return {
    /* ── clubs ── */
    async createClub(input) {
      const club: Club = {
        ...input,
        id: newId(),
        createdAt: now(),
        sensorMode: categoryToSensorMode[input.category],
      };
      await db.runAsync(
        `INSERT INTO clubs (id, name, category, sensor_mode, swing_tag, loft_deg, notes, tracer_color, focus_note, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          club.id,
          club.name,
          club.category,
          club.sensorMode,
          club.swingTag,
          club.loftDeg,
          club.notes,
          club.tracerColor,
          club.focusNote,
          club.archived ? 1 : 0,
          club.createdAt,
        ],
      );
      return club;
    },

    async updateClub(id, patch) {
      const current = await getClub(id);
      const next: Club = { ...current, ...patch, id: current.id };
      // category is the source of truth for sensorMode — re-derive on change
      if (patch.category && !patch.sensorMode) {
        next.sensorMode = categoryToSensorMode[next.category];
      }
      await db.runAsync(
        `UPDATE clubs SET name = ?, category = ?, sensor_mode = ?, swing_tag = ?,
           loft_deg = ?, notes = ?, tracer_color = ?, focus_note = ?, archived = ? WHERE id = ?`,
        [
          next.name,
          next.category,
          next.sensorMode,
          next.swingTag,
          next.loftDeg,
          next.notes,
          next.tracerColor,
          next.focusNote,
          next.archived ? 1 : 0,
          id,
        ],
      );
      return next;
    },

    async listClubs(listOpts) {
      const rows = await db.getAllAsync<ClubRow>(
        listOpts?.includeArchived
          ? 'SELECT * FROM clubs ORDER BY created_at ASC'
          : 'SELECT * FROM clubs WHERE archived = 0 ORDER BY created_at ASC',
      );
      return rows.map(mapClubRow);
    },

    async archiveClub(id) {
      await db.runAsync('UPDATE clubs SET archived = 1 WHERE id = ?', [id]);
    },

    /* ── sessions ── */
    async createSession(input) {
      const session: Session = {
        ...input,
        id: newId(),
        createdAt: now(),
        endedAt: null,
      };
      await db.runAsync(
        `INSERT INTO sessions (id, name, notes, started_at, ended_at, altitude_m, temperature_c, env_preset, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        [
          session.id,
          session.name,
          session.notes,
          session.startedAt,
          session.environment.altitudeM,
          session.environment.temperatureC,
          session.environment.presetName,
          session.createdAt,
        ],
      );
      return session;
    },

    async endSession(id) {
      await db.runAsync('UPDATE sessions SET ended_at = ? WHERE id = ?', [
        now(),
        id,
      ]);
      const row = await db.getFirstAsync<SessionRow>(
        'SELECT * FROM sessions WHERE id = ?',
        [id],
      );
      if (!row) throw new Error(`Unknown session: ${id}`);
      return mapSessionRow(row);
    },

    async getSession(id) {
      const row = await db.getFirstAsync<SessionRow>(
        'SELECT * FROM sessions WHERE id = ?',
        [id],
      );
      return row ? mapSessionRow(row) : null;
    },

    async listSessions() {
      const rows = await db.getAllAsync<SessionRow>(
        'SELECT * FROM sessions ORDER BY started_at DESC',
      );
      return rows.map(mapSessionRow);
    },

    /* ── shots ── */
    async insertShot(sessionId, clubId, m: MeasuredShot, flight) {
      const record: ShotRecord = {
        id: newId(),
        sessionId,
        clubId,
        shotGuid: m.shotGuid,
        capturedAt: now(),
        discarded: false,
        measured: m,
        flight,
      };
      const params: SqlValue[] = [
        record.id,
        sessionId,
        clubId,
        m.shotGuid,
        record.capturedAt,
        m.impactTimestamp,
        m.handedness,
        m.ball.speedMs,
        m.ball.launchAngleDeg,
        m.ball.launchDirectionDeg,
        m.ball.backspinRpm,
        m.ball.sidespinRpm,
        m.ball.rollspinRpm,
        m.club.speedMs,
        m.club.pathDeg,
        m.club.faceAngleDeg,
        m.club.attackAngleDeg,
        m.club.loftDeg,
        m.club.lieDeg,
        m.club.faceImpactHMm,
        m.club.faceImpactVMm,
        m.assurance.spin,
        m.assurance.clubSpeed,
        m.assurance.clubPath,
        m.assurance.faceAngle,
        m.assurance.attackAngle,
        m.assurance.loftAngle,
        m.assurance.lieAngle,
        m.assurance.faceImpactLateral,
        m.assurance.faceImpactVertical,
        m.smashFactor,
        m.shotImgPath,
        flight?.carryM ?? null,
        flight?.totalM ?? null,
        flight?.apexM ?? null,
        flight?.descentDeg ?? null,
        flight?.flightTimeS ?? null,
        flight?.offlineM ?? null,
        flight?.rolloutM ?? null,
        flight?.landing.x ?? null,
        flight?.landing.z ?? null,
        flight ? JSON.stringify(flight.path) : null,
        JSON.stringify(m),
      ];
      try {
        await db.runAsync(
          `INSERT INTO shots (
             id, session_id, club_id, shot_guid, captured_at, impact_timestamp,
             discarded, handedness,
             ball_speed_ms, launch_angle_deg, launch_direction_deg,
             backspin_rpm, sidespin_rpm, rollspin_rpm,
             club_speed_ms, club_path_deg, face_angle_deg, attack_angle_deg,
             loft_deg, lie_deg, face_impact_h_mm, face_impact_v_mm,
             assurance_spin, assurance_clubspeed, assurance_clubpath,
             assurance_faceangle, assurance_attackangle, assurance_loftangle,
             assurance_lieangle, assurance_faceimpact_lateral,
             assurance_faceimpact_vertical,
             smash_factor, shot_img_path,
             carry_m, total_m, apex_m, descent_deg, flight_time_s, offline_m,
             rollout_m, landing_x_m, landing_z_m, flight_path_json, raw_json
           ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params,
        );
      } catch (err) {
        // Structural detection, not `instanceof Error`: the driver's error
        // class can come from another realm (jest vm contexts, RN bridges).
        const shaped = err as { code?: unknown; message?: unknown };
        const message =
          typeof shaped.message === 'string' ? shaped.message : String(err);
        if (
          shaped.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
          /unique/i.test(message)
        ) {
          throw new DuplicateShotError(m.shotGuid);
        }
        throw err;
      }
      return record;
    },

    async attachFlight(shotId, flight: FlightResult) {
      await db.runAsync(
        `UPDATE shots SET carry_m = ?, total_m = ?, apex_m = ?, descent_deg = ?,
           flight_time_s = ?, offline_m = ?, rollout_m = ?, landing_x_m = ?,
           landing_z_m = ?, flight_path_json = ? WHERE id = ?`,
        [
          flight.carryM,
          flight.totalM,
          flight.apexM,
          flight.descentDeg,
          flight.flightTimeS,
          flight.offlineM,
          flight.rolloutM,
          flight.landing.x,
          flight.landing.z,
          JSON.stringify(flight.path),
          shotId,
        ],
      );
    },

    async setShotDiscarded(shotId, discarded) {
      await db.runAsync('UPDATE shots SET discarded = ? WHERE id = ?', [
        discarded ? 1 : 0,
        shotId,
      ]);
    },

    async listShots(sessionId) {
      const rows = await db.getAllAsync<ShotRow>(
        'SELECT * FROM shots WHERE session_id = ? ORDER BY captured_at ASC',
        [sessionId],
      );
      return rows.map(mapShotRow);
    },

    async listShotsByClub(clubId, listOpts) {
      // sinceSessionId = shots from sessions whose started_at >= that
      // session's started_at (a "from this session onward" cursor)
      if (listOpts?.sinceSessionId) {
        const rows = await db.getAllAsync<ShotRow>(
          `SELECT s.* FROM shots s
             JOIN sessions ss ON ss.id = s.session_id
           WHERE s.club_id = ?
             AND ss.started_at >= (SELECT started_at FROM sessions WHERE id = ?)
           ORDER BY s.captured_at ASC`,
          [clubId, listOpts.sinceSessionId],
        );
        return rows.map(mapShotRow);
      }
      const rows = await db.getAllAsync<ShotRow>(
        'SELECT * FROM shots WHERE club_id = ? ORDER BY captured_at ASC',
        [clubId],
      );
      return rows.map(mapShotRow);
    },

    /* ── analyses ── */
    async saveAnalysis(a: AnalysisRecord) {
      await db.runAsync(
        `INSERT INTO analyses (id, session_id, scope, model, created_at, verdict_json, narrative, input_summary_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          a.id,
          a.sessionId,
          a.scope,
          a.model,
          a.createdAt,
          JSON.stringify(a.verdict),
          a.narrative,
          JSON.stringify(a.inputSummary ?? null),
        ],
      );
    },

    async listAnalyses(sessionId) {
      const rows = await db.getAllAsync<AnalysisRow>(
        'SELECT * FROM analyses WHERE session_id = ? ORDER BY created_at DESC',
        [sessionId],
      );
      return rows.map(mapAnalysisRow);
    },
  };
}
