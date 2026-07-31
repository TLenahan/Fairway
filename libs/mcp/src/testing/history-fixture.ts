import { createDataStore, runMigrations } from '@golf/data';
import { openNodeDatabase } from '@golf/data/node';
import {
  InsightShot,
  SyntheticBucketSpec,
  generateSyntheticShots,
} from '@golf/insights';
import {
  Club,
  DataStore,
  Environment,
  FlightResult,
  MeasuredShot,
} from '@golf/types';

/**
 * A real SQLite practice history for the tool specs — persisted rows, real
 * migrations, the real DAO. The tools are only interesting against a store
 * with enough history to certify a bucket and carry a finding, and hand-built
 * report objects would prove nothing about whether a tool can read what the
 * hub actually writes.
 *
 * Deliberately not exported from the lib index (the `@golf/data` testing/
 * convention): it depends on better-sqlite3 and must never reach a bundle.
 */

const ENVIRONMENT: Environment = {
  altitudeM: 1600,
  temperatureC: 21,
  presetName: 'Home ~5,200 ft',
};

export const SESSIONS = 4;
export const SHOTS_PER_SESSION = 30;
export const TOTAL_SHOTS = SESSIONS * SHOTS_PER_SESSION;

/**
 * The same planted low-smash-through-club-speed history the hub's program
 * runner spec uses, and for the same reason: smash and ball speed are
 * tautological for a low-smash mode, so club speed is the metric left
 * carrying a minable signal. The plant also costs offline metres (see
 * `plantMiss`), which is what lets the §6.6 gate see the spread drive the
 * outcome rather than sit next to it.
 */
const SPEC: SyntheticBucketSpec = {
  clubId: '7-iron',
  clubCategory: 'iron',
  intent: 'stock',
  sessions: SESSIONS,
  shotsPerSession: SHOTS_PER_SESSION,
  carryMeanM: 150,
  carrySdM: 4.5,
  smashMean: 1.35,
  smashSd: 0.02,
  offlineSdM: 6,
  seed: 20260730,
  planted: {
    failureFraction: 0.25,
    failureMode: 'low-smash',
    affectedMetric: 'clubSpeedMs',
    shiftSigma: -12,
  },
};

/** Metres of offline the plant additionally costs — the mechanism §6.6 mines. */
const PLANT_OFFLINE_PUSH_M = 18;
/** Planted shots land far below this; unplanted smash is 1.35 ± 0.02. */
const PLANTED_SMASH_CEILING = 1.2;

function plantedShots(): InsightShot[] {
  const shots = generateSyntheticShots(SPEC);
  for (const shot of shots) {
    if (shot.smash === null || shot.smash > PLANTED_SMASH_CEILING) continue;
    if (shot.offlineM !== null) shot.offlineM += PLANT_OFFLINE_PUSH_M;
  }
  return shots;
}

function toMeasured(
  shot: InsightShot,
  index: number,
  guid = shot.id,
): MeasuredShot {
  // ±2.4 mm sawtooth on a period coprime to the plant's: every shot clears
  // the great-shot strike radius without the strike pattern tracking the
  // plant, which would hand the signal to the wrong metric.
  const strikeMm = ((index % 7) - 3) * 0.8;
  return {
    shotGuid: guid,
    handedness: shot.handedness,
    impactTimestamp: shot.ts,
    ball: {
      speedMs: shot.ballSpeedMs,
      launchAngleDeg: shot.launchDeg,
      launchDirectionDeg: shot.launchDirDeg,
      backspinRpm: shot.backspinRpm,
      sidespinRpm: shot.sidespinRpm,
      rollspinRpm: shot.backspinRpm,
      spinAssurance: 90,
    },
    club: {
      speedMs: shot.clubSpeedMs,
      pathDeg: 1.1,
      faceAngleDeg: 0.4,
      attackAngleDeg: -4.2,
      loftDeg: 34,
      lieDeg: 0.2,
      faceImpactHMm: strikeMm,
      faceImpactVMm: -strikeMm,
    },
    assurance: {
      spin: 90,
      clubSpeed: 80,
      clubPath: 80,
      faceAngle: 80,
      attackAngle: 80,
      loftAngle: 80,
      lieAngle: 80,
      faceImpactLateral: 80,
      faceImpactVertical: 80,
    },
    smashFactor: shot.smash,
    shotImgPath: null,
  };
}

function toFlight(shot: InsightShot): FlightResult {
  const carryM = shot.carryM ?? 0;
  const offlineM = shot.offlineM ?? 0;
  return {
    path: [],
    carryM,
    totalM: shot.totalM ?? carryM,
    apexM: shot.apexM ?? 0,
    descentDeg: 44,
    flightTimeS: 5.6,
    offlineM,
    curveM: shot.curveM ?? 0,
    landing: { x: carryM, z: offlineM },
    rolloutM: 4,
    computed: true,
  };
}

export interface Fixture {
  data: DataStore;
  iron: Club;
  wedge: Club;
  /** the 4 focused 7-iron sessions, oldest first */
  sessionIds: string[];
  /** the one-shot wedge session, which exists to prove the club filters bite */
  wedgeSessionId: string;
  close(): void;
}

/**
 * 120 stock 7-iron shots across 4 focused sessions, plus a single wedge shot
 * in a session of its own. The wedge is the control: every filter in this lib
 * takes a club_id, and a store with one club cannot tell a working filter
 * from an ignored one.
 */
export async function seedFixture(): Promise<Fixture> {
  const db = openNodeDatabase(':memory:');
  await runMigrations(db);
  const data = createDataStore(db);

  const iron = await data.createClub({
    name: '7 iron',
    category: 'iron',
    swingTag: 'full',
    loftDeg: 34,
    notes: null,
    tracerColor: null,
    focusNote: 'strike',
    archived: false,
  });
  const wedge = await data.createClub({
    name: '60 degree',
    category: 'wedge',
    swingTag: 'three_quarter',
    loftDeg: 60,
    notes: null,
    tracerColor: null,
    focusNote: null,
    archived: false,
  });

  const shots = plantedShots();
  const sessionIds: string[] = [];
  for (let s = 0; s < SESSIONS; s += 1) {
    const session = await data.createSession({
      name: `session-${s}`,
      notes: null,
      startedAt: shots[s * SHOTS_PER_SESSION].ts,
      environment: ENVIRONMENT,
      defaultIntent: 'stock',
      focusClubId: iron.id,
    });
    sessionIds.push(session.id);
  }
  // `insertShot` stamps capturedAt with the wall clock, so a seed loop this
  // tight would land 120 shots inside the same millisecond or two. Real shots
  // arrive ~45 s apart, and capturedAt is what the engine reads as `ts` and
  // what every time filter here compares against — so the fixture writes the
  // generator's timeline back over it. Test-only surgery, deliberately close
  // to the table rather than hidden behind a DAO method no product code needs.
  const restamp = async (shotId: string, ts: number): Promise<void> => {
    await db.runAsync('UPDATE shots SET captured_at = ? WHERE id = ?', [
      ts,
      shotId,
    ]);
  };

  for (let i = 0; i < shots.length; i += 1) {
    const record = await data.insertShot(
      sessionIds[Math.floor(i / SHOTS_PER_SESSION)],
      iron.id,
      toMeasured(shots[i], i),
      toFlight(shots[i]),
      { intent: 'stock', warmup: false },
    );
    await restamp(record.id, shots[i].ts);
  }

  const wedgeTs = shots[shots.length - 1].ts + 60_000;
  const wedgeSession = await data.createSession({
    name: 'wedge-session',
    notes: null,
    startedAt: wedgeTs,
    environment: ENVIRONMENT,
    defaultIntent: 'stock',
    focusClubId: wedge.id,
  });
  const wedgeShot = await data.insertShot(
    wedgeSession.id,
    wedge.id,
    // its own guid: shotGuid is the dedupe key, and reusing the iron shot's
    // would be rejected as a duplicate rather than stored as a wedge shot
    toMeasured(shots[0], 0, 'wedge-shot-0'),
    toFlight(shots[0]),
    { intent: 'stock', warmup: false },
  );
  await restamp(wedgeShot.id, wedgeTs);

  return {
    data,
    iron,
    wedge,
    sessionIds,
    wedgeSessionId: wedgeSession.id,
    close: () => db.close(),
  };
}
