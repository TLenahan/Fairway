import { FlightResult, MeasuredShot } from '@golf/types';

import { createDataStore, DuplicateShotError } from './data-store';
import { runMigrations } from './migrations';
import { seedDefaultClubs } from './seed-runner';
import { DEFAULT_CLUBS } from './seed';
import { openTestDatabase } from './testing/better-sqlite3-adapter';

const measured = (
  guid: string,
  faceAngle: number | null = null,
): MeasuredShot => ({
  shotGuid: guid,
  handedness: 'right',
  impactTimestamp: 1783975921445500,
  ball: {
    speedMs: 26.092,
    launchAngleDeg: 25.63,
    launchDirectionDeg: -2.011,
    backspinRpm: 6918.153,
    sidespinRpm: 1396.358,
    rollspinRpm: 1028.395,
    spinAssurance: 97,
  },
  club: {
    speedMs: 25.357,
    pathDeg: -1.867,
    faceAngleDeg: faceAngle,
    attackAngleDeg: -6.2,
    loftDeg: null,
    lieDeg: null,
    faceImpactHMm: null,
    faceImpactVMm: null,
  },
  assurance: {
    spin: 97,
    clubSpeed: 95,
    clubPath: 95,
    faceAngle: faceAngle === null ? 0 : 90,
    attackAngle: 95,
    loftAngle: 0,
    lieAngle: 0,
    faceImpactLateral: 0,
    faceImpactVertical: 0,
  },
  smashFactor: 1.028986,
  shotImgPath: null,
});

const flight: FlightResult = {
  path: [
    { t: 0, x: 0, y: 0, z: 0 },
    { t: 1, x: 50, y: 15, z: -1 },
  ],
  carryM: 132.4,
  totalM: 138.9,
  apexM: 24.1,
  descentDeg: 46.2,
  flightTimeS: 5.4,
  offlineM: -3.1,
  landing: { x: 132.4, z: -3.1 },
  rolloutM: 6.5,
  computed: true,
};

const env = {
  altitudeM: 1849,
  temperatureC: null,
  presetName: 'Home ~6,000 ft',
};

async function build() {
  const db = openTestDatabase();
  await runMigrations(db);
  let tick = 1000;
  let id = 0;
  const store = createDataStore(db, {
    now: () => ++tick,
    newId: () => `id-${++id}`,
  });
  return { db, store };
}

describe('createDataStore', () => {
  it('round-trips clubs and derives sensorMode from category', async () => {
    const { store } = await build();
    const club = await store.createClub({
      name: '60° ½ swing',
      category: 'wedge',
      swingTag: 'half',
      loftDeg: 60,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
    });
    expect(club.sensorMode).toBe('iron');

    const updated = await store.updateClub(club.id, { category: 'driver' });
    expect(updated.sensorMode).toBe('tee');

    await store.archiveClub(club.id);
    expect(await store.listClubs()).toHaveLength(0);
    expect(await store.listClubs({ includeArchived: true })).toHaveLength(1);
  });

  it('round-trips sessions with environment', async () => {
    const { store } = await build();
    const session = await store.createSession({
      name: null,
      notes: null,
      startedAt: 111,
      environment: env,
    });
    const fetched = await store.getSession(session.id);
    expect(fetched?.environment).toEqual(env);
    expect(fetched?.endedAt).toBeNull();

    const ended = await store.endSession(session.id);
    expect(ended.endedAt).not.toBeNull();
  });

  it('persists shots — nulls stay null and flight round-trips', async () => {
    const { store } = await build();
    const club = await store.createClub({
      name: '7 Iron',
      category: 'iron',
      swingTag: 'full',
      loftDeg: 34,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
    });
    const session = await store.createSession({
      name: null,
      notes: null,
      startedAt: 1,
      environment: env,
    });

    const noFlight = await store.insertShot(
      session.id,
      club.id,
      measured('g-1'),
      null,
    );
    expect(noFlight.flight).toBeNull();

    const [read] = await store.listShots(session.id);
    expect(read.measured.club.faceAngleDeg).toBeNull();
    expect(read.measured.club.speedMs).toBeCloseTo(25.357);
    expect(read.flight).toBeNull();

    await store.attachFlight(noFlight.id, flight);
    const [withFlight] = await store.listShots(session.id);
    expect(withFlight.flight?.carryM).toBeCloseTo(132.4);
    expect(withFlight.flight?.path).toHaveLength(2);
    expect(withFlight.flight?.landing).toEqual({ x: 132.4, z: -3.1 });
  });

  it('throws DuplicateShotError on a replayed shot_guid', async () => {
    const { store } = await build();
    const club = await store.createClub({
      name: '7 Iron',
      category: 'iron',
      swingTag: 'full',
      loftDeg: 34,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
    });
    const session = await store.createSession({
      name: null,
      notes: null,
      startedAt: 1,
      environment: env,
    });
    await store.insertShot(session.id, club.id, measured('dup'), null);
    await expect(
      store.insertShot(session.id, club.id, measured('dup'), null),
    ).rejects.toBeInstanceOf(DuplicateShotError);
  });

  it('soft-deletes via the discarded flag', async () => {
    const { store } = await build();
    const club = await store.createClub({
      name: '7 Iron',
      category: 'iron',
      swingTag: 'full',
      loftDeg: 34,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
    });
    const session = await store.createSession({
      name: null,
      notes: null,
      startedAt: 1,
      environment: env,
    });
    const shot = await store.insertShot(
      session.id,
      club.id,
      measured('g-1'),
      null,
    );
    await store.setShotDiscarded(shot.id, true);
    const [read] = await store.listShots(session.id);
    expect(read.discarded).toBe(true); // retained, flagged
  });

  it('listShotsByClub spans sessions and honors sinceSessionId', async () => {
    const { store } = await build();
    const club = await store.createClub({
      name: 'Driver',
      category: 'driver',
      swingTag: 'full',
      loftDeg: 10.5,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
    });
    const s1 = await store.createSession({
      name: null,
      notes: null,
      startedAt: 100,
      environment: env,
    });
    const s2 = await store.createSession({
      name: null,
      notes: null,
      startedAt: 200,
      environment: env,
    });
    await store.insertShot(s1.id, club.id, measured('a'), null);
    await store.insertShot(s2.id, club.id, measured('b'), null);

    expect(await store.listShotsByClub(club.id)).toHaveLength(2);
    const since = await store.listShotsByClub(club.id, {
      sinceSessionId: s2.id,
    });
    expect(since).toHaveLength(1);
    expect(since[0].shotGuid).toBe('b');
  });

  it('round-trips analyses with schema validation', async () => {
    const { store } = await build();
    const session = await store.createSession({
      name: null,
      notes: null,
      startedAt: 1,
      environment: env,
    });
    await store.saveAnalysis({
      id: 'an-1',
      sessionId: session.id,
      scope: 'session',
      model: 'claude-sonnet-5',
      createdAt: 5,
      verdict: {
        headline: 'Face control is the leak',
        issues: [],
        strengths: [],
        drills: [],
        caveats: [],
      },
      narrative: 'Short narrative.',
      inputSummary: { clubs: [] },
    });
    const [read] = await store.listAnalyses(session.id);
    expect(read.verdict.headline).toBe('Face control is the leak');
    expect(read.inputSummary).toEqual({ clubs: [] });
  });

  it('seeds default clubs exactly once', async () => {
    const { store } = await build();
    await seedDefaultClubs(store);
    await seedDefaultClubs(store);
    const clubs = await store.listClubs({ includeArchived: true });
    expect(clubs).toHaveLength(DEFAULT_CLUBS.length);
    expect(clubs.find((c) => c.name === 'Putter')?.sensorMode).toBe('putter');
  });
});
