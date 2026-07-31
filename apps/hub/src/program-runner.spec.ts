import { openNodeDatabase } from '@golf/data/node';
import {
  DEFAULT_INSIGHTS_CONFIG,
  InsightShot,
  SyntheticBucketSpec,
  generateSyntheticShots,
} from '@golf/insights';
import { FakeTcpFactory, FakeUdpFactory } from '@golf/monitor/testing';
import {
  Club,
  DataStore,
  Environment,
  FlightResult,
  MeasuredShot,
  Session,
} from '@golf/types';

import { runProgramLoop } from './program-runner';
import { createHubServices } from './services';

/**
 * The §6.10 loop end to end through the hub: real SQLite, the real hub
 * composition root, synthetic-but-persisted shots. Proves the loop reaches
 * training-block rows from stored shots, and — the property that actually
 * matters, because `GET /api/insights` triggers it — that running it twice
 * over unchanged history prescribes nothing the second time.
 */

const ENVIRONMENT: Environment = {
  altitudeM: 0,
  temperatureC: 20,
  presetName: null,
};

const SESSIONS = 4;
const SHOTS_PER_SESSION = 30;

/**
 * A 120-shot 7-iron/stock history with a planted low-smash failure whose
 * mechanism is club speed. That combination is what makes (low-smash,
 * clubSpeedMs) minable at all: smash and ballSpeedMs are tautological for a
 * low-smash mode — they restate the miss — and the engine's config excludes
 * them, so club speed is the metric left carrying the signal.
 *
 * The shift looks enormous because `shiftSigma` is denominated in the
 * GENERATOR's club-speed σ, which is the independent ball-speed noise alone
 * (≈0.19 m/s). Club speed is derived as ballSpeed/smash, so its actual spread
 * in the stream is dominated by the smash draw and runs about 4× that — −12
 * generator-σ is roughly a 3σ move in the data the engine sees.
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

/** The exact smash the generator forces onto a planted shot. Nothing else in
    the stream lands anywhere near it (unplanted smash is 1.35 ± 0.02), so it
    is a reliable "was this shot planted?" test that does not reach into the
    generator's indexing. */
const PLANTED_SMASH =
  DEFAULT_INSIGHTS_CONFIG.greatShot.smashCeiling.iron *
  DEFAULT_INSIGHTS_CONFIG.failureModes.lowSmashFactor *
  0.92;

/** Metres of offline the plant additionally costs. See `plantedShots`. */
const PLANT_OFFLINE_PUSH_M = 18;

/**
 * §6.6 gate, honoured rather than worked around: a metric only earns a drill
 * if its SPREAD drives the outcome's spread. The stock generator leaves
 * offline as independent noise, so no delivery metric would ever classify as
 * a variance driver and nothing would (correctly) be prescribed.
 *
 * So the fixture makes the plant cost something: the same shots that lose
 * club speed also miss offline. That is the mechanism the gate is designed to
 * find — a wandering delivery that shows up in the result — and it is what a
 * real low-smash-through-speed miss looks like.
 */
function plantedShots(): InsightShot[] {
  const shots = generateSyntheticShots(SPEC);
  for (const shot of shots) {
    if (shot.smash === null || shot.smash > PLANTED_SMASH + 0.01) continue;
    if (shot.offlineM !== null) shot.offlineM += PLANT_OFFLINE_PUSH_M;
  }
  return shots;
}

/**
 * Project an engine shot back into the persisted shape. Only the fields the
 * engine reads carry the fixture's values; the rest are plausible constants.
 *
 * Face impact is filled with a small ±2.4 mm sawtooth on a period coprime to
 * the plant's, so the strike criterion passes for every shot (well inside the
 * 12 mm great-shot radius) without correlating with the plant — a strike
 * pattern that tracked the plant would hand the prescription to a different
 * drill for a reason the fixture never intended.
 */
function toMeasured(shot: InsightShot, index: number): MeasuredShot {
  const strikeMm = ((index % 7) - 3) * 0.8;
  return {
    shotGuid: shot.id,
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
      speedMs: shot.clubSpeedMs ?? 0,
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

/** Persist the fixture as 4 real sessions of 30 shots against one real club. */
async function seedHistory(data: DataStore, club: Club): Promise<void> {
  const shots = plantedShots();
  const sessions: Session[] = [];
  for (let s = 0; s < SESSIONS; s += 1) {
    sessions.push(
      await data.createSession({
        name: `session-${s}`,
        notes: null,
        startedAt: Date.now() + s,
        environment: ENVIRONMENT,
        defaultIntent: 'stock',
      }),
    );
  }
  for (let i = 0; i < shots.length; i += 1) {
    await data.insertShot(
      sessions[Math.floor(i / SHOTS_PER_SESSION)].id,
      club.id,
      toMeasured(shots[i], i),
      toFlight(shots[i]),
      { intent: 'stock', warmup: false },
    );
  }
}

describe('runProgramLoop', () => {
  it('prescribes from persisted history, then prescribes nothing new', async () => {
    const db = openNodeDatabase(':memory:');
    const services = await createHubServices({
      db,
      tcp: new FakeTcpFactory(),
      udp: new FakeUdpFactory(),
      onError: (err) => {
        throw err;
      },
    });
    const { data } = services;

    const clubs = await data.listClubs();
    const club = clubs.find((c) => c.name === '7 Iron');
    if (club === undefined) throw new Error('expected a seeded 7 Iron');
    await seedHistory(data, club);

    // Both runs are stamped after every shot, so no re-measure window has
    // filled and no verdict can resolve — the run-to-run difference under
    // test is prescription alone.
    const lastShotTs = Date.now() + 60_000;

    const first = await runProgramLoop(data, lastShotTs);
    expect(first.resolved).toEqual([]);
    expect(first.prescribed.length).toBeGreaterThan(0);

    const block = first.prescribed.find(
      (b) => b.findingKey === `${club.id}|stock|low-smash|clubSpeedMs`,
    );
    if (block === undefined) {
      throw new Error(
        `expected a (low-smash, clubSpeedMs) block; got ${first.prescribed
          .map((b) => b.findingKey)
          .join(', ')}`,
      );
    }
    // The drill that targets club speed, banded on the user's OWN great-shot
    // club speed (§6.10) — never a universal number.
    expect(block.drillId).toBe('tempo-ladder');
    expect(block.status).toBe('active');
    expect(block.clubId).toBe(club.id);
    expect(block.tolerance?.metric).toBe('clubSpeedMs');
    expect(block.tolerance?.halfWidth).toBeGreaterThan(0);

    // §6.6 is live on this path, not just in the unit tests. The plant also
    // pushes offline, so the engine reports a (low-smash, offlineM) finding —
    // and offlineM is an OUTCOME metric, which the bias/variance split can
    // only ever call 'bias' or 'neutral', never a variance driver. It must
    // therefore earn no drill: an offline offset is an aim note.
    expect(
      first.prescribed.some((b) => b.findingKey?.endsWith('|offlineM')),
    ).toBe(false);

    // THE property a GET depends on: same history, second run, nothing new.
    const second = await runProgramLoop(data, lastShotTs + 1000);
    expect(second.prescribed).toEqual([]);
    expect(second.resolved).toEqual([]);

    const persisted = await data.listTrainingBlocks();
    expect(persisted).toHaveLength(first.prescribed.length);

    // The payload reflects what is actually on file, drill content resolved.
    expect(second.payload.blocks.map((b) => b.id).sort()).toEqual(
      persisted.map((b) => b.id).sort(),
    );
    const wire = second.payload.blocks.find((b) => b.id === block.id);
    expect(wire).toBeDefined();
    expect(wire!.drill_name).toBe('Speed ladder');
    expect(wire!.failure_mode).toBe('low-smash');
    expect(wire!.target_metric).toBe('clubSpeedMs');
    expect(wire!.status).toBe('active');
    expect(wire!.resolved_at_ms).toBeNull();
    // active blocks sort first
    expect(second.payload.blocks[0].status).toBe('active');

    // The engine wire still rides along untouched.
    const bucket = second.payload.buckets.find(
      (b) => b.club_id === club.id && b.intent === 'stock',
    );
    expect(bucket).toBeDefined();
    expect(bucket!.n_total).toBe(SESSIONS * SHOTS_PER_SESSION);
    expect(bucket!.variance_drivers).toContain('clubSpeedMs');

    services.monitor.disconnect();
    db.close();
  });
});
