import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { openNodeDatabase } from '@golf/data/node';

import { createHubServices } from './services';
import { createNodeTcpFactory } from './transports/tcp';
import { createNodeUdpFactory } from './transports/udp';
import { createNobleWristTransport } from './transports/wrist-ble';

/**
 * Headless hub entry (`yarn nx run hub:serve`): live EYE MINI discovery +
 * HackMotion stream + per-shot SQLite join, logging to the console. The
 * Electron shell replaces this as the session UI lands; the composition
 * underneath stays identical.
 */
async function main(): Promise<void> {
  const dataDir = join(homedir(), '.fairway');
  mkdirSync(dataDir, { recursive: true });
  const db = openNodeDatabase(join(dataDir, 'hub.db'));

  const services = await createHubServices({
    db,
    tcp: createNodeTcpFactory(),
    udp: createNodeUdpFactory(),
    wristTransport: createNobleWristTransport(),
    onError: (err) => console.error('[hub]', err.message),
  });

  const { monitor, wrist, store } = services;

  monitor.on('device', (device) => {
    console.log(`[mini] discovered ${device.model} ${device.serial} at ${device.ip}`);
    void monitor.connect(device.ip);
  });
  monitor.on('connection', (state) => console.log(`[mini] ${state}`));
  monitor.on('shot', (shot) => {
    console.log(
      `[shot] ${shot.shotGuid} ball ${shot.ball.speedMs?.toFixed(1) ?? '—'} m/s ` +
        `smash ${shot.smashFactor?.toFixed(2) ?? '—'}`,
    );
  });

  if (wrist) {
    wrist.on('device', (device) => {
      if (device.name?.startsWith('HackMotion')) {
        console.log(`[wrist] found ${device.name} (${device.id})`);
        wrist.stopScan();
        void wrist.connect(device.id);
      }
    });
    wrist.on('connection', (state) => console.log(`[wrist] ${state}`));
    wrist.on('swing', (swing) => {
      console.log(
        `[swing] top ${swing.top.angles.extensionDeg?.toFixed(1) ?? '—'}° ext, ` +
          `${swing.durationMs.toFixed(0)}ms`,
      );
    });
    wrist.startScan();
  }

  store.subscribe((state, prev) => {
    const latest = state.sessionShots[0];
    if (latest && latest !== prev.sessionShots[0]) {
      const wristTag = latest.wrist ? ' +wrist' : '';
      console.log(`[joined] shot persisted${wristTag}`);
    }
  });

  monitor.startDiscovery();
  console.log('[hub] running — EYE MINI discovery + wrist scan. Ctrl-C to stop.');

  process.on('SIGINT', () => {
    console.log('\n[hub] shutting down');
    monitor.disconnect();
    wrist?.disconnect();
    process.exit(0);
  });
}

void main();
