import { MIGRATIONS, runMigrations } from './migrations';
import { openTestDatabase } from './testing/better-sqlite3-adapter';

describe('migration harness', () => {
  it('migrates a fresh database to the latest version', async () => {
    const db = openTestDatabase();
    const version = await runMigrations(db);
    expect(version).toBe(11);

    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'clubs',
        'sessions',
        'shots',
        'analyses',
        'drill_reps',
        'wrist_swings',
        'training_blocks',
        'clips',
      ]),
    );
    db.close();
  });

  it('is idempotent — re-running applies nothing', async () => {
    const db = openTestDatabase();
    await runMigrations(db);
    await expect(runMigrations(db)).resolves.toBe(11);
    db.close();
  });

  it('v6 backfills curve_m for shots that already have a flight', async () => {
    const db = openTestDatabase();
    for (const migration of MIGRATIONS.slice(0, 5)) {
      await migration.up(db);
    }
    await db.execAsync('PRAGMA user_version = 5');
    await db.runAsync(
      `INSERT INTO clubs (id, name, category, sensor_mode, archived, created_at)
       VALUES ('c1', 'GW', 'wedge', 'iron', 0, 1)`,
    );
    await db.runAsync(
      `INSERT INTO sessions (id, started_at, altitude_m, created_at)
       VALUES ('s1', 1, 1849, 1)`,
    );
    // pull (HLA −17.5°) that also drifted a touch further left in the air
    await db.runAsync(
      `INSERT INTO shots (
         id, session_id, club_id, shot_guid, captured_at, impact_timestamp,
         discarded, handedness,
         ball_speed_ms, launch_angle_deg, launch_direction_deg,
         backspin_rpm, sidespin_rpm, rollspin_rpm,
         assurance_spin, assurance_clubspeed, assurance_clubpath,
         assurance_faceangle, assurance_attackangle, assurance_loftangle,
         assurance_lieangle, assurance_faceimpact_lateral,
         assurance_faceimpact_vertical,
         carry_m, landing_x_m, landing_z_m,
         raw_json
       ) VALUES (
         'x1', 's1', 'c1', 'g-1', 2, 3, 0, 'right',
         29.8, 22.8, -17.5, 6960, -224, 0,
         97, 95, 95, 0, 95, 0, 0, 0, 0,
         63.9, 60, -22,
         '{}'
       )`,
    );
    await expect(runMigrations(db)).resolves.toBe(11);
    const row = await db.getFirstAsync<{ curve_m: number | null }>(
      "SELECT curve_m FROM shots WHERE id = 'x1'",
    );
    const hlaRad = (-17.5 * Math.PI) / 180;
    const expected = -22 * Math.cos(hlaRad) - 60 * Math.sin(hlaRad);
    expect(row?.curve_m).toBeCloseTo(expected, 9);
    db.close();
  });

  it('v8 adds intent/warmup columns with defaults on a fresh database', async () => {
    const db = openTestDatabase();
    await runMigrations(db);
    await db.runAsync(
      `INSERT INTO clubs (id, name, category, sensor_mode, archived, created_at)
       VALUES ('c1', 'GW', 'wedge', 'iron', 0, 1)`,
    );
    // neither insert mentions the new columns — the DEFAULTs must fill them
    await db.runAsync(
      `INSERT INTO sessions (id, started_at, altitude_m, created_at)
       VALUES ('s1', 1, 1849, 1)`,
    );
    await db.runAsync(
      `INSERT INTO shots (
         id, session_id, club_id, shot_guid, captured_at, impact_timestamp,
         discarded, handedness,
         ball_speed_ms, launch_angle_deg, launch_direction_deg,
         backspin_rpm, sidespin_rpm, rollspin_rpm,
         assurance_spin, assurance_clubspeed, assurance_clubpath,
         assurance_faceangle, assurance_attackangle, assurance_loftangle,
         assurance_lieangle, assurance_faceimpact_lateral,
         assurance_faceimpact_vertical,
         raw_json
       ) VALUES (
         'x1', 's1', 'c1', 'g-1', 2, 3, 0, 'right',
         26, 25, -2, 6900, 1400, 1000,
         97, 95, 95, 0, 95, 0, 0, 0, 0, '{}'
       )`,
    );
    const session = await db.getFirstAsync<{ default_intent: string }>(
      "SELECT default_intent FROM sessions WHERE id = 's1'",
    );
    expect(session?.default_intent).toBe('stock');
    const shot = await db.getFirstAsync<{ intent: string; warmup: number }>(
      "SELECT intent, warmup FROM shots WHERE id = 'x1'",
    );
    expect(shot?.intent).toBe('untagged');
    expect(shot?.warmup).toBe(0);
    db.close();
  });

  it('v8 backfills defaults onto rows persisted by a v7 database', async () => {
    const db = openTestDatabase();
    for (const migration of MIGRATIONS.slice(0, 7)) {
      await migration.up(db);
    }
    await db.execAsync('PRAGMA user_version = 7');
    await db.runAsync(
      `INSERT INTO clubs (id, name, category, sensor_mode, archived, created_at)
       VALUES ('c1', 'GW', 'wedge', 'iron', 0, 1)`,
    );
    await db.runAsync(
      `INSERT INTO sessions (id, started_at, altitude_m, created_at)
       VALUES ('s1', 1, 1849, 1)`,
    );
    await db.runAsync(
      `INSERT INTO shots (
         id, session_id, club_id, shot_guid, captured_at, impact_timestamp,
         discarded, handedness,
         ball_speed_ms, launch_angle_deg, launch_direction_deg,
         backspin_rpm, sidespin_rpm, rollspin_rpm,
         assurance_spin, assurance_clubspeed, assurance_clubpath,
         assurance_faceangle, assurance_attackangle, assurance_loftangle,
         assurance_lieangle, assurance_faceimpact_lateral,
         assurance_faceimpact_vertical,
         raw_json
       ) VALUES (
         'x1', 's1', 'c1', 'g-1', 2, 3, 0, 'right',
         26, 25, -2, 6900, 1400, 1000,
         97, 95, 95, 0, 95, 0, 0, 0, 0, '{}'
       )`,
    );
    await expect(runMigrations(db)).resolves.toBe(11);
    const session = await db.getFirstAsync<{ default_intent: string }>(
      "SELECT default_intent FROM sessions WHERE id = 's1'",
    );
    expect(session?.default_intent).toBe('stock');
    const shot = await db.getFirstAsync<{ intent: string; warmup: number }>(
      "SELECT intent, warmup FROM shots WHERE id = 'x1'",
    );
    expect(shot?.intent).toBe('untagged');
    expect(shot?.warmup).toBe(0);
    db.close();
  });

  it('round-trips NULL for unmeasured metrics (never 0)', async () => {
    const db = openTestDatabase();
    await runMigrations(db);
    await db.runAsync(
      `INSERT INTO clubs (id, name, category, sensor_mode, archived, created_at)
       VALUES ('c1', '7 Iron', 'iron', 'iron', 0, 1)`,
    );
    await db.runAsync(
      `INSERT INTO sessions (id, started_at, altitude_m, created_at)
       VALUES ('s1', 1, 1849, 1)`,
    );
    await db.runAsync(
      `INSERT INTO shots (
         id, session_id, club_id, shot_guid, captured_at, impact_timestamp,
         discarded, handedness,
         ball_speed_ms, launch_angle_deg, launch_direction_deg,
         backspin_rpm, sidespin_rpm, rollspin_rpm,
         club_speed_ms, club_path_deg, face_angle_deg,
         assurance_spin, assurance_clubspeed, assurance_clubpath,
         assurance_faceangle, assurance_attackangle, assurance_loftangle,
         assurance_lieangle, assurance_faceimpact_lateral,
         assurance_faceimpact_vertical,
         raw_json
       ) VALUES (
         'x1', 's1', 'c1', 'g-1', 2, 3, 0, 'right',
         26.092, 25.63, -2.011, 6918.153, 1396.358, 1028.395,
         25.357, -1.867, NULL,
         97, 95, 95, 0, 95, 0, 0, 0, 0,
         '{}'
       )`,
    );
    const row = await db.getFirstAsync<{
      face_angle_deg: number | null;
      club_speed_ms: number | null;
    }>('SELECT face_angle_deg, club_speed_ms FROM shots WHERE id = ?', ['x1']);
    expect(row?.face_angle_deg).toBeNull();
    expect(row?.club_speed_ms).toBeCloseTo(25.357);
    db.close();
  });

  it('enforces shot_guid uniqueness (dedup safety net)', async () => {
    const db = openTestDatabase();
    await runMigrations(db);
    await db.runAsync(
      `INSERT INTO clubs (id, name, category, sensor_mode, archived, created_at)
       VALUES ('c1', '7 Iron', 'iron', 'iron', 0, 1)`,
    );
    await db.runAsync(
      `INSERT INTO sessions (id, started_at, altitude_m, created_at)
       VALUES ('s1', 1, 1849, 1)`,
    );
    const insert = (id: string) =>
      db.runAsync(
        `INSERT INTO shots (
           id, session_id, club_id, shot_guid, captured_at, impact_timestamp,
           discarded, handedness,
           ball_speed_ms, launch_angle_deg, launch_direction_deg,
           backspin_rpm, sidespin_rpm, rollspin_rpm,
           assurance_spin, assurance_clubspeed, assurance_clubpath,
           assurance_faceangle, assurance_attackangle, assurance_loftangle,
           assurance_lieangle, assurance_faceimpact_lateral,
           assurance_faceimpact_vertical,
           raw_json
         ) VALUES (
           '${id}', 's1', 'c1', 'same-guid', 2, 3, 0, 'right',
           26, 25, -2, 6900, 1400, 1000,
           97, 95, 95, 0, 95, 0, 0, 0, 0, '{}'
         )`,
      );
    await insert('a');
    // structural match — the driver's error class can be from another realm
    // (jest vm contexts), which breaks instanceof-based matchers like toThrow
    await expect(insert('b')).rejects.toMatchObject({
      message: expect.stringMatching(/unique/i),
    });
    db.close();
  });

  // the exact v9 column set, hand-written from the spec rather than read back
  // from the migration — a typo in either one has to fail the test
  const TRAINING_BLOCK_COLUMNS = [
    'id',
    'source',
    'finding_key',
    'drill_id',
    'drill_version',
    'club_id',
    'intent',
    'tolerance_json',
    'remeasure_shots',
    'status',
    'started_at',
    'resolved_at',
    'resolution_note',
    'created_at',
  ];

  it('v9 creates training_blocks with its full column set on a fresh database', async () => {
    const db = openTestDatabase();
    await runMigrations(db);

    const columns = await db.getAllAsync<{
      name: string;
      notnull: number;
      pk: number;
    }>('PRAGMA table_info(training_blocks)');
    expect(columns.map((c) => c.name)).toEqual(TRAINING_BLOCK_COLUMNS);
    // the nullable ones are the whole point: a program block has no finding,
    // no bucket and no band, and an active block has no verdict yet.
    // (pk excluded — SQLite reports notnull=0 for a TEXT PRIMARY KEY even
    // though the rowid alias still rejects a duplicate id.)
    const nullable = columns
      .filter((c) => c.notnull === 0 && c.pk === 0)
      .map((c) => c.name)
      .sort();
    expect(nullable).toEqual([
      'club_id',
      'finding_key',
      'intent',
      'resolution_note',
      'resolved_at',
      'tolerance_json',
    ]);

    const indexes = await db.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'training_blocks' ORDER BY name`,
    );
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining([
        'idx_training_blocks_finding',
        'idx_training_blocks_status',
      ]),
    );
    db.close();
  });

  it('v9 creates training_blocks when upgrading a v8 database', async () => {
    const db = openTestDatabase();
    for (const migration of MIGRATIONS.slice(0, 8)) {
      await migration.up(db);
    }
    await db.execAsync('PRAGMA user_version = 8');
    const before = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='training_blocks'",
    );
    expect(before).toEqual([]);

    await expect(runMigrations(db)).resolves.toBe(11);

    const columns = await db.getAllAsync<{ name: string }>(
      'PRAGMA table_info(training_blocks)',
    );
    expect(columns.map((c) => c.name)).toEqual(TRAINING_BLOCK_COLUMNS);

    // and the upgraded table takes a real row, club_id FK included
    await db.runAsync(
      `INSERT INTO clubs (id, name, category, sensor_mode, archived, created_at)
       VALUES ('c1', 'GW', 'wedge', 'iron', 0, 1)`,
    );
    await db.runAsync(
      `INSERT INTO training_blocks (id, source, finding_key, drill_id,
         drill_version, club_id, intent, tolerance_json, remeasure_shots,
         status, started_at, resolved_at, resolution_note, created_at)
       VALUES ('b1', 'finding', 'c1|stock|thin|carryM', 'ladder', 1, 'c1',
         'stock', NULL, 20, 'active', 5, NULL, NULL, 5)`,
    );
    const row = await db.getFirstAsync<{
      status: string;
      tolerance_json: string | null;
      resolved_at: number | null;
    }>(
      "SELECT status, tolerance_json, resolved_at FROM training_blocks WHERE id = 'b1'",
    );
    expect(row?.status).toBe('active');
    expect(row?.tolerance_json).toBeNull();
    expect(row?.resolved_at).toBeNull();
    db.close();
  });

  it('v10 adds a nullable focus_club_id to sessions persisted by v9', async () => {
    const db = openTestDatabase();
    for (const migration of MIGRATIONS.slice(0, 9)) {
      await migration.up(db);
    }
    await db.execAsync('PRAGMA user_version = 9');
    await db.runAsync(
      `INSERT INTO sessions (id, name, notes, started_at, altitude_m, default_intent, created_at)
       VALUES ('s1', NULL, NULL, 100, 0, 'stock', 100)`,
    );

    await expect(runMigrations(db)).resolves.toBe(11);

    // sessions that predate focus stay unfocused rather than being backfilled
    // with a guess — null is the honest value, and the coach is told so
    const legacy = await db.getFirstAsync<{ focus_club_id: string | null }>(
      "SELECT focus_club_id FROM sessions WHERE id = 's1'",
    );
    expect(legacy?.focus_club_id).toBeNull();

    // no FK on the column: a focused session must survive its club being
    // archived, and imported rows may reference clubs that never landed
    await db.runAsync(
      `INSERT INTO sessions (id, name, notes, started_at, altitude_m, default_intent, focus_club_id, created_at)
       VALUES ('s2', NULL, NULL, 200, 0, 'stock', 'not-a-club', 200)`,
    );
    const focused = await db.getFirstAsync<{ focus_club_id: string | null }>(
      "SELECT focus_club_id FROM sessions WHERE id = 's2'",
    );
    expect(focused?.focus_club_id).toBe('not-a-club');
    db.close();
  });

  it('v11 creates clips with a real shot FK and a nullable impact offset', async () => {
    const db = openTestDatabase();
    for (const migration of MIGRATIONS.slice(0, 10)) {
      await migration.up(db);
    }
    await db.execAsync('PRAGMA user_version = 10');
    const before = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='clips'",
    );
    expect(before).toEqual([]);

    await expect(runMigrations(db)).resolves.toBe(11);

    const columns = await db.getAllAsync<{
      name: string;
      notnull: number;
      pk: number;
    }>('PRAGMA table_info(clips)');
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'shot_id',
      'session_id',
      'source',
      'view',
      'path',
      'bytes',
      'duration_ms',
      'fps',
      'width',
      'height',
      'sync',
      'impact_offset_ms',
      'captured_at',
      'created_at',
    ]);
    // exactly one nullable column. A clip exists because the hub asked a
    // camera for a known shot's pre-roll, so every identifying field is
    // NOT NULL; the only thing genuinely unknown at write time is where
    // impact sits in the file.
    const nullable = columns
      .filter((c) => c.notnull === 0 && c.pk === 0)
      .map((c) => c.name);
    expect(nullable).toEqual(['impact_offset_ms']);

    const indexes = await db.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'clips' ORDER BY name`,
    );
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining(['idx_clips_session', 'idx_clips_shot']),
    );
    db.close();
  });

  it('v11 clips reject an unknown view and a duplicate path', async () => {
    const db = openTestDatabase();
    await runMigrations(db);
    await db.execAsync('PRAGMA foreign_keys = ON');
    await db.runAsync(
      `INSERT INTO clubs (id, name, category, sensor_mode, archived, created_at)
       VALUES ('c1', '7i', 'iron', 'iron', 0, 1)`,
    );
    await db.runAsync(
      `INSERT INTO sessions (id, name, notes, started_at, altitude_m, default_intent, created_at)
       VALUES ('s1', NULL, NULL, 100, 0, 'stock', 100)`,
    );
    await db.runAsync(
      `INSERT INTO shots (id, session_id, club_id, shot_guid, captured_at,
         impact_timestamp, handedness, ball_speed_ms, launch_angle_deg,
         launch_direction_deg, backspin_rpm, sidespin_rpm, rollspin_rpm,
         assurance_spin, assurance_clubspeed, assurance_clubpath,
         assurance_faceangle, assurance_attackangle, assurance_loftangle,
         assurance_lieangle, assurance_faceimpact_lateral,
         assurance_faceimpact_vertical, raw_json)
       VALUES ('sh1', 's1', 'c1', 'g1', 100, 100, 'right', 60, 15, 0, 6000, 0,
         0, 97, 95, 95, 0, 95, 0, 0, 0, 0, '{}')`,
    );
    const insertClip = (
      id: string,
      shotId: string,
      view: string,
      path: string,
    ): Promise<void> =>
      db.runAsync(
        `INSERT INTO clips (id, shot_id, session_id, source, view, path, bytes,
           duration_ms, fps, width, height, sync, impact_offset_ms, captured_at,
           created_at)
         VALUES (?, ?, 's1', 'phone', ?, ?, 1, 6000, 120, 1920, 1080,
           'coarse', NULL, 100, 100)`,
        [id, shotId, view, path],
      );
    const rejection = async (p: Promise<void>): Promise<string> => {
      try {
        await p;
        return 'accepted';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };

    expect(await rejection(insertClip('cl1', 'sh1', 'down_the_line', 's1/a.mp4')))
      .toBe('accepted');
    // a view the pose pipeline has no geometry for is a typo, not a new angle
    expect(await rejection(insertClip('cl2', 'sh1', 'side', 's1/b.mp4'))).toContain(
      'CHECK constraint failed',
    );
    // two rows pointing at one file means one of them is about the wrong swing
    expect(
      await rejection(insertClip('cl3', 'sh1', 'face_on', 's1/a.mp4')),
    ).toContain('UNIQUE constraint failed');
    // and a clip of a shot the hub never recorded cannot exist
    expect(
      await rejection(insertClip('cl4', 'nope', 'face_on', 's1/c.mp4')),
    ).toContain('FOREIGN KEY constraint failed');
    db.close();
  });
});
