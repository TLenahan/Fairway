import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDataStore, runMigrations } from '@golf/data';
import { openNodeDatabase } from '@golf/data/node';
import { DataStore, Environment, MeasuredShot, ShotRecord } from '@golf/types';

import { createClipStore } from './clip-store';
import { CaptureEndpointDeps, handleCaptureRequest } from './endpoint';
import { createCaptureRegistry } from './requests';

/**
 * The capture seam standing up for real — real endpoints, real registry, real
 * SQLite, real clip files on a temp dir — so both halves can be tested against
 * the thing itself rather than against a mock of it. Only hardware gets faked:
 * the camera, and the ffmpeg the trim shells out to.
 */
const ENVIRONMENT: Environment = {
  altitudeM: 1800,
  temperatureC: 22,
  presetName: null,
};

export function measuredShot(guid: string): MeasuredShot {
  return {
    shotGuid: guid,
    handedness: 'right',
    impactTimestamp: 1783975921445500,
    ball: {
      speedMs: 60.1,
      launchAngleDeg: 15.2,
      launchDirectionDeg: -1.1,
      backspinRpm: 6100,
      sidespinRpm: 300,
      rollspinRpm: 100,
      spinAssurance: 97,
    },
    club: {
      speedMs: 44.2,
      pathDeg: -1.0,
      faceAngleDeg: null,
      attackAngleDeg: -2.5,
      loftDeg: null,
      lieDeg: null,
      faceImpactHMm: null,
      faceImpactVMm: null,
    },
    assurance: {
      spin: 97,
      clubSpeed: 95,
      clubPath: 95,
      faceAngle: 0,
      attackAngle: 95,
      loftAngle: 0,
      lieAngle: 0,
      faceImpactLateral: 0,
      faceImpactVertical: 0,
    },
    smashFactor: 1.36,
    shotImgPath: null,
  };
}

export interface CaptureHarness {
  deps: CaptureEndpointDeps;
  data: DataStore;
  /** One shot, already in the session — what most tests ask for a clip of. */
  shot: ShotRecord;
  sessionId: string;
  clubId: string;
  clipsDir: string;
  /** `http://127.0.0.1:<port>` — the seam as a camera sees it. */
  base: string;
  server: Server;
  addShot(guid: string): Promise<ShotRecord>;
  close(): Promise<void>;
}

export interface CaptureHarnessOptions {
  /**
   * Clock the registry stamps requests with. Pass the same one a camera client
   * is driven by — a request's age is the whole basis of the driver's decision
   * to trigger, so the two halves must agree on what time it is.
   */
  now?(): number;
}

export async function buildCaptureHarness(
  options: CaptureHarnessOptions = {},
): Promise<CaptureHarness> {
  const root = mkdtempSync(join(tmpdir(), 'fairway-clips-'));
  const clipsDir = join(root, 'clips');
  const db = openNodeDatabase();
  await runMigrations(db);
  const data = createDataStore(db);
  const club = await data.createClub({
    name: '7 Iron',
    category: 'iron',
    swingTag: 'full',
    loftDeg: 34,
    notes: null,
    tracerColor: null,
    focusNote: null,
    archived: false,
  });
  const session = await data.createSession({
    name: null,
    notes: null,
    startedAt: 1,
    environment: ENVIRONMENT,
  });
  const addShot = (guid: string): Promise<ShotRecord> =>
    data.insertShot(session.id, club.id, measuredShot(guid), null);
  const shot = await addShot('g-1');

  const deps: CaptureEndpointDeps = {
    data,
    clips: createClipStore(clipsDir),
    registry: createCaptureRegistry(options.now ? { now: options.now } : {}),
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      try {
        if (await handleCaptureRequest(deps, req, res, url)) return;
      } catch (err) {
        res
          .writeHead(500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: (err as Error).message }));
        return;
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    deps,
    data,
    shot,
    sessionId: session.id,
    clubId: club.id,
    clipsDir,
    base: `http://127.0.0.1:${port}`,
    server,
    addShot,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
