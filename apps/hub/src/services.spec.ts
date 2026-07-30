import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { openNodeDatabase } from '@golf/data/node';
import { EVENT_PORT } from '@golf/monitor';
import {
  FakeTcpFactory,
  FakeUdpFactory,
  feedShot,
  SAMPLE_SHOT,
} from '@golf/monitor/testing';
import {
  BleAvailability,
  WristBleConnection,
  WristBleTransport,
} from '@golf/wrist';

import { createHubServices, HubServices } from './services';

/**
 * The Phase 1 replay harness in miniature: a REAL EyeMiniMonitor on fake
 * TCP/UDP, a REAL HackMotionWristService on a fake BLE pipe fed from a
 * recorded range capture, real SQLite via @golf/data/node — no hardware.
 */

const CAPTURE = join(
  __dirname,
  '../../../captures/2026-07-16T19-04-18-session.ndjson',
);

class FakeWristConnection implements WristBleConnection {
  writes: Uint8Array[] = [];
  private handler: ((data: Uint8Array) => void) | null = null;
  async write(data: Uint8Array): Promise<void> {
    this.writes.push(data);
  }
  onData(handler: (data: Uint8Array) => void): void {
    this.handler = handler;
  }
  onDisconnect(): void {}
  async disconnect(): Promise<void> {}
  feed(data: Uint8Array): void {
    this.handler?.(data);
  }
}

class FakeWristTransport implements WristBleTransport {
  conn = new FakeWristConnection();
  startScan(onDevice: (d: { id: string; name: string | null }) => void): void {
    onDevice({ id: 'fake-wrist', name: 'HackMotion Fake' });
  }
  stopScan(): void {}
  async connect(): Promise<WristBleConnection> {
    return this.conn;
  }
  availability(): BleAvailability {
    return 'ready';
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

interface Harness {
  services: HubServices;
  tcp: FakeTcpFactory;
  udp: FakeUdpFactory;
  wristTransport: FakeWristTransport;
  close(): void;
}

async function buildHarness(withWrist: boolean): Promise<Harness> {
  const db = openNodeDatabase(':memory:');
  const tcp = new FakeTcpFactory();
  const udp = new FakeUdpFactory();
  const wristTransport = new FakeWristTransport();
  const services = await createHubServices({
    db,
    tcp,
    udp,
    ...(withWrist ? { wristTransport } : {}),
    onError: (err) => {
      throw err;
    },
  });
  services.monitor.startDiscovery();
  await Promise.resolve();
  await Promise.resolve();
  udp.socket.beacon('501000330615', '192.168.1.217');
  await services.monitor.connect('192.168.1.217');
  return {
    services,
    tcp,
    udp,
    wristTransport,
    close: () => {
      services.monitor.disconnect();
      services.wrist?.disconnect();
      db.close();
    },
  };
}

describe('hub composition (replay harness)', () => {
  it('persists a monitor shot to SQLite with computed flight', async () => {
    const harness = await buildHarness(false);
    const { services, tcp } = harness;

    feedShot(tcp.byPort(EVENT_PORT), SAMPLE_SHOT.raw_shotdataEX1);
    await waitFor(() => services.store.getState().sessionShots.length === 1);

    const state = services.store.getState();
    const shot = state.sessionShots[0];
    expect(shot.measured.ball.speedMs).toBeCloseTo(
      SAMPLE_SHOT.expected_decode_SI.ball.speedMs as number,
      3,
    );
    expect(shot.flight).not.toBeNull();
    expect(shot.flight?.carryM).toBeGreaterThan(0);

    // the row is really in SQLite, not just in memory
    const session = state.session;
    expect(session).not.toBeNull();
    const rows = await services.data.listShots(session!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].shotGuid).toBe(shot.shotGuid);
    expect(rows[0].flight?.carryM).toBeCloseTo(shot.flight!.carryM, 6);

    harness.close();
  });

  it('joins a swing replayed from a real capture onto the shot', async () => {
    const harness = await buildHarness(true);
    const { services, tcp, wristTransport } = harness;
    const wrist = services.wrist;
    expect(wrist).not.toBeNull();
    await wrist!.connect('fake-wrist');

    // Replay the recorded wedge session up to (and a bit past) its first
    // EYE MINI shot label, feeding raw wrist frames through the BLE pipe and
    // the canonical shot fixture at the label position.
    const lines = readFileSync(CAPTURE, 'utf8').split('\n');
    let shotFed = false;
    let framesAfterShot = 0;
    for (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line) as { type: string; d?: string };
      if (record.type === 'frame' && record.d) {
        wristTransport.conn.feed(
          new Uint8Array(Buffer.from(record.d, 'base64')),
        );
        if (shotFed && (framesAfterShot += 1) > 600) break;
      } else if (record.type === 'shot' && !shotFed) {
        feedShot(tcp.byPort(EVENT_PORT), SAMPLE_SHOT.raw_shotdataEX1);
        shotFed = true;
      }
    }

    await waitFor(() => {
      const [latest] = services.store.getState().sessionShots;
      return latest !== undefined && latest.wrist !== undefined;
    });

    const shot = services.store.getState().sessionShots[0];
    expect(shot.wrist?.peakAngularSpeedDegS).toBeGreaterThan(0);

    // joined record persisted, not just in memory
    const rows = await services.data.listShots(
      services.store.getState().session!.id,
    );
    expect(rows[0].wrist?.tImpactMs).toBe(shot.wrist?.tImpactMs);

    harness.close();
  });
});
