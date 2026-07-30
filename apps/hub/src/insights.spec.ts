import { join } from 'node:path';

import { openNodeDatabase } from '@golf/data/node';
import { InsightsWire } from '@golf/insights';
import { FakeTcpFactory, FakeUdpFactory } from '@golf/monitor/testing';
import { Environment, FlightResult, MeasuredShot } from '@golf/types';

import { startHubServer } from './server';
import { createHubServices } from './services';

/**
 * The /api/insights seam end to end: real SQLite, the real hub composition
 * root, the real HTTP server — the only fakes are the monitor transports the
 * server never touches. Proves the engine reaches the wire from persisted
 * rows, not from a hand-built report.
 */

const ENVIRONMENT: Environment = {
  altitudeM: 1800,
  temperatureC: 22,
  presetName: null,
};

const measured = (i: number): MeasuredShot => ({
  shotGuid: `guid-${i}`,
  handedness: 'right',
  impactTimestamp: i,
  ball: {
    speedMs: 54.5 + i * 0.2,
    launchAngleDeg: 18.2 + i * 0.1,
    launchDirectionDeg: -1.1 + i * 0.2,
    backspinRpm: 6100 + i * 40,
    sidespinRpm: 250 - i * 20,
    rollspinRpm: 6105 + i * 40,
    spinAssurance: 90,
  },
  club: {
    speedMs: 39.5 + i * 0.1,
    pathDeg: 1.1 + i * 0.1,
    faceAngleDeg: 0.4,
    attackAngleDeg: -4.2,
    loftDeg: 33.5,
    lieDeg: 0.2,
    faceImpactHMm: 1.5 - i * 0.3,
    faceImpactVMm: 2.1 - i * 0.2,
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
  smashFactor: 1.38 + i * 0.002,
  shotImgPath: null,
});

const flight = (i: number): FlightResult => ({
  path: [],
  carryM: 148 + i * 0.8,
  totalM: 156 + i * 0.8,
  apexM: 24.1,
  descentDeg: 44,
  flightTimeS: 5.6,
  offlineM: -3.2 + i * 0.5,
  curveM: 1.4 - i * 0.2,
  landing: { x: 148 + i * 0.8, z: -3.2 + i * 0.5 },
  rolloutM: 8,
  computed: true,
});

describe('GET /api/insights', () => {
  it('serves the engine wire for the persisted shot history', async () => {
    const db = openNodeDatabase(':memory:');
    const services = await createHubServices({
      db,
      tcp: new FakeTcpFactory(),
      udp: new FakeUdpFactory(),
      onError: (err) => {
        throw err;
      },
    });

    const clubs = await services.data.listClubs();
    const club = clubs[0];
    const session = await services.data.createSession({
      name: null,
      notes: null,
      startedAt: Date.now(),
      environment: ENVIRONMENT,
      defaultIntent: 'stock',
    });
    for (let i = 0; i < 8; i += 1) {
      await services.data.insertShot(
        session.id,
        club.id,
        measured(i),
        flight(i),
        { intent: 'stock', warmup: false },
      );
    }

    const server = await startHubServer({
      services,
      environment: ENVIRONMENT,
      uiDir: join(__dirname, 'renderer'),
      port: 0,
    });
    const address = server.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('server did not bind a port');
    }
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/api/insights`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');

    const wire: InsightsWire = await response.json();
    expect(Array.isArray(wire.findings)).toBe(true);
    const bucket = wire.buckets.find(
      (b) => b.club_id === club.id && b.intent === 'stock',
    );
    expect(bucket).toBeDefined();
    expect(bucket!.club_name).toBe(club.name);
    expect(bucket!.n_total).toBe(8);

    // the static branch is untouched: anything else is still a 404
    const missing = await fetch(`${base}/not-a-route`);
    expect(missing.status).toBe(404);

    await server.close();
    services.monitor.disconnect();
    db.close();
  });
});
