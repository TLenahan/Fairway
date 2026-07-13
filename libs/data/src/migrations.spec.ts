import { runMigrations } from './migrations';
import { openTestDatabase } from './testing/better-sqlite3-adapter';

describe('migration harness', () => {
  it('migrates a fresh database to the latest version', async () => {
    const db = openTestDatabase();
    const version = await runMigrations(db);
    expect(version).toBe(1);

    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['clubs', 'sessions', 'shots', 'analyses']),
    );
    db.close();
  });

  it('is idempotent — re-running applies nothing', async () => {
    const db = openTestDatabase();
    await runMigrations(db);
    await expect(runMigrations(db)).resolves.toBe(1);
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
    await expect(insert('b')).rejects.toThrow();
    db.close();
  });
});
