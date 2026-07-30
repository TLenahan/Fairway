import { SqlDatabase } from './database';

/**
 * Versioned migration harness (WP0). Tracks schema version in PRAGMA
 * user_version; each migration runs at most once, in order.
 *
 * Schema per handoff/BUILD_SPEC.md §7. Measured columns are SI floats and
 * NULLABLE — a NULL means "not measured" (assurance 0), never 0. Computed
 * columns stay NULL until the flight model runs.
 */
export interface Migration {
  version: number;
  up(db: SqlDatabase): Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    async up(db) {
      await db.execAsync(`
        CREATE TABLE clubs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('driver','wood','hybrid','iron','wedge','putter')),
          sensor_mode TEXT NOT NULL CHECK (sensor_mode IN ('tee','iron','putter')),
          swing_tag TEXT CHECK (swing_tag IN ('full','three_quarter','half','chip')),
          loft_deg REAL,
          notes TEXT,
          archived INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          name TEXT,
          notes TEXT,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          altitude_m REAL NOT NULL,
          temperature_c REAL,
          env_preset TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE shots (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          club_id TEXT NOT NULL REFERENCES clubs(id),
          shot_guid TEXT NOT NULL UNIQUE,
          captured_at INTEGER NOT NULL,
          impact_timestamp INTEGER NOT NULL,
          discarded INTEGER NOT NULL DEFAULT 0,
          handedness TEXT NOT NULL CHECK (handedness IN ('right','left')),
          -- MEASURED (SI floats; NULL = not measured, never 0)
          ball_speed_ms REAL NOT NULL,
          launch_angle_deg REAL NOT NULL,
          launch_direction_deg REAL NOT NULL,
          backspin_rpm REAL NOT NULL,
          sidespin_rpm REAL NOT NULL,
          rollspin_rpm REAL NOT NULL,
          club_speed_ms REAL,
          club_path_deg REAL,
          face_angle_deg REAL,
          attack_angle_deg REAL,
          loft_deg REAL,
          lie_deg REAL,
          face_impact_h_mm REAL,
          face_impact_v_mm REAL,
          -- assurance (auditable null-reason per club metric)
          assurance_spin INTEGER NOT NULL,
          assurance_clubspeed INTEGER NOT NULL,
          assurance_clubpath INTEGER NOT NULL,
          assurance_faceangle INTEGER NOT NULL,
          assurance_attackangle INTEGER NOT NULL,
          assurance_loftangle INTEGER NOT NULL,
          assurance_lieangle INTEGER NOT NULL,
          assurance_faceimpact_lateral INTEGER NOT NULL,
          assurance_faceimpact_vertical INTEGER NOT NULL,
          -- DERIVED
          smash_factor REAL,
          shot_img_path TEXT,
          -- COMPUTED (FlightModel; NULL until computed)
          carry_m REAL,
          total_m REAL,
          apex_m REAL,
          descent_deg REAL,
          flight_time_s REAL,
          offline_m REAL,
          rollout_m REAL,
          landing_x_m REAL,
          landing_z_m REAL,
          flight_path_json TEXT,
          -- forward-compat / debugging
          raw_json TEXT NOT NULL
        );
        CREATE INDEX idx_shots_session ON shots(session_id);
        CREATE INDEX idx_shots_club ON shots(club_id);

        CREATE TABLE analyses (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          scope TEXT NOT NULL CHECK (scope IN ('session','club','trend','compare','diagnose','plan')),
          model TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          verdict_json TEXT NOT NULL,
          narrative TEXT NOT NULL,
          input_summary_json TEXT NOT NULL
        );
        CREATE INDEX idx_analyses_session ON analyses(session_id);
      `);
    },
  },
  {
    version: 2,
    async up(db) {
      // per-club flight-tracer color (hex); NULL = app default red
      await db.execAsync('ALTER TABLE clubs ADD COLUMN tracer_color TEXT');
    },
  },
  {
    version: 3,
    async up(db) {
      // what the golfer is working on with this club — fed to AI analysis
      await db.execAsync('ALTER TABLE clubs ADD COLUMN focus_note TEXT');
    },
  },
  {
    version: 4,
    async up(db) {
      // wrist mechanics (@golf/wrist WristShot) joined to this shot by impact
      // arrival time; NULL when no wrist unit was connected or nothing matched
      await db.execAsync('ALTER TABLE shots ADD COLUMN wrist_json TEXT');
    },
  },
  {
    version: 5,
    async up(db) {
      // Wedge drill reps — the drill's ONLY persisted state. Targets, anchors
      // and the carry ladder are always recomputed from reps by @golf/drill,
      // never stored. shot_id/carry_m stay NULL until the Mini shot joins
      // (~1 s after the wrist swing); a rep that never joins is a ball-less
      // rehearsal swing.
      await db.execAsync(`
        CREATE TABLE drill_reps (
          id TEXT PRIMARY KEY,
          club_id TEXT NOT NULL REFERENCES clubs(id),
          rung TEXT NOT NULL CHECK (rung IN ('low','mid','full')),
          shot_id TEXT REFERENCES shots(id),
          t_ms INTEGER NOT NULL,
          top_angle_deg REAL NOT NULL,
          top_extension_deg REAL,
          backswing_ms REAL NOT NULL,
          downswing_ms REAL NOT NULL,
          target_angle_deg REAL,
          outcome TEXT NOT NULL CHECK (outcome IN ('match','over','under','calibrating')),
          carry_m REAL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_drill_reps_club ON drill_reps(club_id);
      `);
    },
  },
  {
    version: 6,
    async up(db) {
      // curve: signed lateral deviation of the landing point from the START
      // line (the HLA ray), + = right — offline_m's sibling in the start-line
      // frame. Backfilled in JS from columns already on the row (SQLite math
      // functions aren't guaranteed on-device).
      await db.execAsync('ALTER TABLE shots ADD COLUMN curve_m REAL');
      const rows = await db.getAllAsync<{
        id: string;
        landing_x_m: number;
        landing_z_m: number;
        launch_direction_deg: number;
      }>(
        `SELECT id, landing_x_m, landing_z_m, launch_direction_deg
           FROM shots WHERE carry_m IS NOT NULL`,
      );
      for (const row of rows) {
        const hlaRad = (row.launch_direction_deg * Math.PI) / 180;
        const curveM =
          row.landing_z_m * Math.cos(hlaRad) -
          row.landing_x_m * Math.sin(hlaRad);
        await db.runAsync('UPDATE shots SET curve_m = ? WHERE id = ?', [
          curveM,
          row.id,
        ]);
      }
    },
  },
  {
    version: 7,
    async up(db) {
      // Every validated wrist swing during a session, practice swings
      // included — the coach export's coverage counts unpaired swings, which
      // the live wrist↔shot join silently ages out. coach_json is the
      // WristCoachResult (keyframes or a drop reason), never clamped.
      // IF NOT EXISTS: the migration runner bumps user_version in a separate
      // statement, so a crash between the two must leave a re-runnable
      // migration, not a permanently failing CREATE.
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS wrist_swings (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          t_impact_ms INTEGER NOT NULL,
          coach_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_wrist_swings_session ON wrist_swings(session_id);
      `);
    },
  },
  {
    version: 8,
    async up(db) {
      // Insights §6.1: stats bucket on (club, intent). intent is TEXT (no
      // CHECK) so future intents stay additive; 'untagged' is the quarantine
      // bucket. warmup = first ~5 shots of a session, excluded from stats,
      // re-taggable. Plain ALTERs (no IF NOT EXISTS exists for ADD COLUMN) —
      // same crash-window trade-off as v2–v4/v6, accepted there too.
      await db.execAsync(`
        ALTER TABLE sessions ADD COLUMN default_intent TEXT NOT NULL DEFAULT 'stock';
        ALTER TABLE shots ADD COLUMN intent TEXT NOT NULL DEFAULT 'untagged';
        ALTER TABLE shots ADD COLUMN warmup INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 9,
    async up(db) {
      // Training blocks (§6.11 `prescriptions`, generalized to the ONE
      // TrainingBlock primitive of §6.12 rule 4): calendar-planned work and
      // finding-driven prescriptions share a table so scheduling, execution
      // and the re-measure loop are written once. `source` is the only thing
      // that differs, and finding_key is NULL for program-sourced blocks.
      //
      // drill_id/drill_version reference the curated library (@golf/program,
      // §6.12 rule 1) — drill CONTENT is versioned in the repo, never copied
      // here, so a block records only which version it was issued against.
      // tolerance_json is the band derived from the user's OWN baseline at
      // issue time (§6.10), frozen so a later verdict judges against the band
      // that was actually in force, not today's recomputed one.
      //
      // The two indexes serve the only two hot reads: the active-block list
      // (status) and "does this finding already have a block?" (finding_key).
      // IF NOT EXISTS: the runner bumps user_version in a separate statement,
      // so a crash between the two must leave a re-runnable migration (same
      // reasoning as v7).
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS training_blocks (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          finding_key TEXT,
          drill_id TEXT NOT NULL,
          drill_version INTEGER NOT NULL,
          club_id TEXT REFERENCES clubs(id),
          intent TEXT,
          tolerance_json TEXT,
          remeasure_shots INTEGER NOT NULL,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          resolved_at INTEGER,
          resolution_note TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_training_blocks_status ON training_blocks(status);
        CREATE INDEX IF NOT EXISTS idx_training_blocks_finding ON training_blocks(finding_key);
      `);
    },
  },
];

export async function runMigrations(db: SqlDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version',
  );
  let current = row?.user_version ?? 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    await migration.up(db);
    await db.execAsync(`PRAGMA user_version = ${migration.version}`);
    current = migration.version;
  }
  return current;
}
