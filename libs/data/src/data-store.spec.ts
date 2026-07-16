import { DrillRep, FlightResult, MeasuredShot, WristShot } from '@golf/types';

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

const wristFixture: WristShot = {
  tImpactMs: 1783975921445,
  durationMs: 780,
  peakAngularSpeedDegS: 645.2,
  calibrated: false,
  address: {
    tMs: 1783975920500,
    angularSpeedDegS: 12,
    angles: { extensionDeg: null, deviationDeg: null, rotationDeg: null },
    rotVecDeg: [16.1, -47.8, -4.5],
  },
  top: {
    tMs: 1783975921000,
    angularSpeedDegS: 40,
    angles: { extensionDeg: null, deviationDeg: null, rotationDeg: null },
    rotVecDeg: [14.1, 13.1, -3.0],
  },
  impact: {
    tMs: 1783975921445,
    angularSpeedDegS: 645.2,
    angles: { extensionDeg: null, deviationDeg: null, rotationDeg: null },
    rotVecDeg: [10.6, 40.2, -3.9],
  },
  shock: { tMs: 1783975921445, offsetFromImpactMs: 0, peakAbsLsb: 5123 },
};

const drillRepInput = (
  clubId: string,
  overrides: Partial<Omit<DrillRep, 'id' | 'createdAt'>> = {},
): Omit<DrillRep, 'id' | 'createdAt'> => ({
  clubId,
  rung: 'full',
  shotId: null,
  tMs: 1783975921445,
  topAngleDeg: 61.4,
  topExtensionDeg: null,
  backswingMs: 742,
  downswingMs: 251,
  targetAngleDeg: null,
  outcome: 'calibrating',
  carryM: null,
  ...overrides,
});

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

  it('attachWrist round-trips wrist mechanics (absent until attached)', async () => {
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

    const [before] = await store.listShots(session.id);
    expect(before.wrist).toBeUndefined();

    await store.attachWrist(shot.id, wristFixture);
    const [after] = await store.listShots(session.id);
    expect(after.wrist?.peakAngularSpeedDegS).toBeCloseTo(645.2);
    expect(after.wrist?.impact.angles.extensionDeg).toBeNull();
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

  it('round-trips drill reps — every field preserved, nulls stay null', async () => {
    const { store } = await build();
    const wedge = await store.createClub({
      name: '56°',
      category: 'wedge',
      swingTag: 'full',
      loftDeg: 56,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
    });

    const calibrating = await store.insertDrillRep(drillRepInput(wedge.id));
    const judged = await store.insertDrillRep(
      drillRepInput(wedge.id, {
        rung: 'mid',
        topAngleDeg: 44.2,
        topExtensionDeg: 18.7,
        targetAngleDeg: 45.0,
        outcome: 'match',
      }),
    );

    const reps = await store.listDrillReps([wedge.id]);
    expect(reps).toEqual([calibrating, judged]);
    expect(reps[0].shotId).toBeNull();
    expect(reps[0].topExtensionDeg).toBeNull();
    expect(reps[0].targetAngleDeg).toBeNull();
    expect(reps[0].carryM).toBeNull();
    expect(reps[1].topExtensionDeg).toBeCloseTo(18.7);
    expect(reps[1].targetAngleDeg).toBeCloseTo(45.0);
    expect(reps[1].outcome).toBe('match');
  });

  it('setDrillRepCarry attaches the joined shot and carry', async () => {
    const { store } = await build();
    const wedge = await store.createClub({
      name: '56°',
      category: 'wedge',
      swingTag: 'full',
      loftDeg: 56,
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
      wedge.id,
      measured('g-1'),
      flight,
    );
    const rep = await store.insertDrillRep(drillRepInput(wedge.id));

    await store.setDrillRepCarry(rep.id, shot.id, 132.4);
    const [read] = await store.listDrillReps([wedge.id]);
    expect(read.shotId).toBe(shot.id);
    expect(read.carryM).toBeCloseTo(132.4);
  });

  it('listDrillReps filters by club ids and orders by createdAt', async () => {
    const { store } = await build();
    const clubInput = {
      swingTag: 'full' as const,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
    };
    const pw = await store.createClub({
      ...clubInput,
      name: 'PW',
      category: 'wedge',
      loftDeg: 46,
    });
    const lw = await store.createClub({
      ...clubInput,
      name: '60°',
      category: 'wedge',
      loftDeg: 60,
    });

    const first = await store.insertDrillRep(drillRepInput(pw.id));
    const second = await store.insertDrillRep(drillRepInput(lw.id));
    const third = await store.insertDrillRep(drillRepInput(pw.id));

    expect(await store.listDrillReps([])).toEqual([]);
    expect(await store.listDrillReps([pw.id])).toEqual([first, third]);
    expect(await store.listDrillReps([pw.id, lw.id])).toEqual([
      first,
      second,
      third,
    ]);
  });
});
