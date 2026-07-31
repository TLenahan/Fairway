import {
  categoryToSensorMode,
  AnalysisRecord,
  Clip,
  Club,
  DataStore,
  DrillRep,
  FlightResult,
  MeasuredShot,
  Session,
  ShotRecord,
  TrainingBlock,
  WristSwingRecord,
} from '@golf/types';

import { SqlDatabase, SqlValue } from './database';
import {
  mapAnalysisRow,
  mapClipRow,
  mapClubRow,
  mapDrillRepRow,
  mapSessionRow,
  mapShotRow,
  mapTrainingBlockRow,
  mapWristSwingRow,
  AnalysisRow,
  ClipRow,
  ClubRow,
  DrillRepRow,
  SessionRow,
  ShotRow,
  TrainingBlockRow,
  WristSwingRow,
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
        defaultIntent: input.defaultIntent ?? 'stock',
        focusClubId: input.focusClubId ?? null,
        id: newId(),
        createdAt: now(),
        endedAt: null,
      };
      await db.runAsync(
        `INSERT INTO sessions (id, name, notes, started_at, ended_at, altitude_m, temperature_c, env_preset, default_intent, focus_club_id, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        [
          session.id,
          session.name,
          session.notes,
          session.startedAt,
          session.environment.altitudeM,
          session.environment.temperatureC,
          session.environment.presetName,
          session.defaultIntent,
          session.focusClubId,
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
    async insertShot(sessionId, clubId, m: MeasuredShot, flight, insertOpts) {
      const record: ShotRecord = {
        id: newId(),
        sessionId,
        clubId,
        shotGuid: m.shotGuid,
        capturedAt: now(),
        discarded: false,
        intent: insertOpts?.intent ?? 'untagged',
        warmup: insertOpts?.warmup ?? false,
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
        record.intent,
        record.warmup ? 1 : 0,
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
        flight?.curveM ?? null,
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
             intent, warmup,
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
             curve_m, rollout_m, landing_x_m, landing_z_m, flight_path_json,
             raw_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
           flight_time_s = ?, offline_m = ?, curve_m = ?, rollout_m = ?,
           landing_x_m = ?, landing_z_m = ?, flight_path_json = ? WHERE id = ?`,
        [
          flight.carryM,
          flight.totalM,
          flight.apexM,
          flight.descentDeg,
          flight.flightTimeS,
          flight.offlineM,
          flight.curveM,
          flight.rolloutM,
          flight.landing.x,
          flight.landing.z,
          JSON.stringify(flight.path),
          shotId,
        ],
      );
    },

    async attachWrist(shotId, wrist) {
      await db.runAsync('UPDATE shots SET wrist_json = ? WHERE id = ?', [
        JSON.stringify(wrist),
        shotId,
      ]);
    },

    async setShotDiscarded(shotId, discarded) {
      await db.runAsync('UPDATE shots SET discarded = ? WHERE id = ?', [
        discarded ? 1 : 0,
        shotId,
      ]);
    },

    async setShotIntent(shotId, intent) {
      await db.runAsync('UPDATE shots SET intent = ? WHERE id = ?', [
        intent,
        shotId,
      ]);
    },

    async setShotWarmup(shotId, warmup) {
      await db.runAsync('UPDATE shots SET warmup = ? WHERE id = ?', [
        warmup ? 1 : 0,
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

    /* ── wrist swings ── */
    async insertWristSwing(input) {
      const record: WristSwingRecord = {
        ...input,
        id: newId(),
        createdAt: now(),
      };
      await db.runAsync(
        `INSERT INTO wrist_swings (id, session_id, t_impact_ms, coach_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          record.id,
          record.sessionId,
          record.tImpactMs,
          JSON.stringify(record.coach),
          record.createdAt,
        ],
      );
      return record;
    },

    async listWristSwings(sessionId) {
      const rows = await db.getAllAsync<WristSwingRow>(
        'SELECT * FROM wrist_swings WHERE session_id = ? ORDER BY t_impact_ms ASC',
        [sessionId],
      );
      return rows.map(mapWristSwingRow);
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

    /* ── drill reps ── */
    async insertDrillRep(input) {
      const rep: DrillRep = { ...input, id: newId(), createdAt: now() };
      await db.runAsync(
        `INSERT INTO drill_reps (id, club_id, rung, shot_id, t_ms, top_angle_deg,
           top_extension_deg, backswing_ms, downswing_ms, target_angle_deg,
           outcome, carry_m, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          rep.id,
          rep.clubId,
          rep.rung,
          rep.shotId,
          rep.tMs,
          rep.topAngleDeg,
          rep.topExtensionDeg,
          rep.backswingMs,
          rep.downswingMs,
          rep.targetAngleDeg,
          rep.outcome,
          rep.carryM,
          rep.createdAt,
        ],
      );
      return rep;
    },

    async setDrillRepCarry(repId, shotId, carryM) {
      await db.runAsync(
        'UPDATE drill_reps SET shot_id = ?, carry_m = ? WHERE id = ?',
        [shotId, carryM, repId],
      );
    },

    async listDrillReps(clubIds) {
      if (clubIds.length === 0) return [];
      const placeholders = clubIds.map(() => '?').join(', ');
      const rows = await db.getAllAsync<DrillRepRow>(
        `SELECT * FROM drill_reps WHERE club_id IN (${placeholders})
         ORDER BY created_at ASC`,
        clubIds,
      );
      return rows.map(mapDrillRepRow);
    },

    /* ── training blocks ── */
    async insertTrainingBlock(input) {
      const block: TrainingBlock = { ...input, id: newId(), createdAt: now() };
      await db.runAsync(
        `INSERT INTO training_blocks (id, source, finding_key, drill_id,
           drill_version, club_id, intent, tolerance_json, remeasure_shots,
           status, started_at, resolved_at, resolution_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          block.id,
          block.source,
          block.findingKey,
          block.drillId,
          block.drillVersion,
          block.clubId,
          block.intent,
          // the band is frozen as issued (§6.10) — stringify, never recompute
          block.tolerance === null ? null : JSON.stringify(block.tolerance),
          block.remeasureShots,
          block.status,
          block.startedAt,
          block.resolvedAt,
          block.resolutionNote,
          block.createdAt,
        ],
      );
      return block;
    },

    async updateTrainingBlockStatus(id, status, resolvedAt, note) {
      // resolvedAt is a parameter, not now(): the verdict is stamped with the
      // time of the shot that closed the re-measure window, not of the write.
      await db.runAsync(
        `UPDATE training_blocks SET status = ?, resolved_at = ?, resolution_note = ?
         WHERE id = ?`,
        [status, resolvedAt, note, id],
      );
    },

    async listTrainingBlocks(listOpts) {
      if (listOpts?.status) {
        const rows = await db.getAllAsync<TrainingBlockRow>(
          `SELECT * FROM training_blocks WHERE status = ?
           ORDER BY created_at ASC`,
          [listOpts.status],
        );
        return rows.map(mapTrainingBlockRow);
      }
      const rows = await db.getAllAsync<TrainingBlockRow>(
        'SELECT * FROM training_blocks ORDER BY created_at ASC',
      );
      return rows.map(mapTrainingBlockRow);
    },

    async insertClip(input) {
      const clip: Clip = { ...input, id: newId(), createdAt: now() };
      await db.runAsync(
        `INSERT INTO clips (id, shot_id, session_id, source, view, path, bytes,
           duration_ms, fps, width, height, sync, impact_offset_ms, captured_at,
           created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          clip.id,
          clip.shotId,
          clip.sessionId,
          clip.source,
          clip.view,
          clip.path,
          clip.bytes,
          clip.durationMs,
          clip.fps,
          clip.width,
          clip.height,
          clip.sync,
          clip.impactOffsetMs,
          clip.capturedAt,
          clip.createdAt,
        ],
      );
      return clip;
    },

    async setClipImpactOffset(clipId, sync, impactOffsetMs) {
      // sync moves with the offset because the two are one fact: locating
      // impact IS what upgrades a clip from coarse to fine. Letting a caller
      // set an offset without saying how it was found would leave a number
      // nobody can weigh.
      await db.runAsync(
        'UPDATE clips SET sync = ?, impact_offset_ms = ? WHERE id = ?',
        [sync, impactOffsetMs, clipId],
      );
    },

    async getClip(id) {
      const row = await db.getFirstAsync<ClipRow>(
        'SELECT * FROM clips WHERE id = ?',
        [id],
      );
      return row ? mapClipRow(row) : null;
    },

    async listClips(sessionId) {
      const rows = await db.getAllAsync<ClipRow>(
        'SELECT * FROM clips WHERE session_id = ? ORDER BY captured_at ASC',
        [sessionId],
      );
      return rows.map(mapClipRow);
    },

    async listClipsByShot(shotId) {
      const rows = await db.getAllAsync<ClipRow>(
        'SELECT * FROM clips WHERE shot_id = ? ORDER BY captured_at ASC',
        [shotId],
      );
      return rows.map(mapClipRow);
    },
  };
}
