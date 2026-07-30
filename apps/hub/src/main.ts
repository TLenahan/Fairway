import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { openNodeDatabase } from '@golf/data/node';
import { Environment } from '@golf/types';

import { startHubServer } from './server';
import { createHubServices } from './services';
import { createNodeTcpFactory } from './transports/tcp';
import { createNodeUdpFactory } from './transports/udp';

/**
 * Hub entry (`yarn nx run hub:serve`): live EYE MINI discovery + HackMotion
 * stream + per-shot SQLite join, with the session UI served on localhost.
 * macOS note: run through the FairwayHub.app wrapper (tools/make-hub-app.sh)
 * or Bluetooth access gets the process killed — see @golf/hub wrist-ble.ts.
 */
const UI_PORT = 4271;

const ENVIRONMENT: Environment = {
  altitudeM: 0,
  temperatureC: 20,
  presetName: null,
};

async function main(): Promise<void> {
  const dataDir = join(homedir(), '.fairway');
  mkdirSync(dataDir, { recursive: true });
  const db = openNodeDatabase(join(dataDir, 'hub.db'));

  // HUB_NO_BLE=1 skips loading the BLE stack entirely — bare `node` without
  // the FairwayHub.app wrapper is TCC-killed on CoreBluetooth access.
  const requireModule = createRequire(__filename);
  const loadWristBle = (): typeof import('./transports/wrist-ble.js') =>
    requireModule('./transports/wrist-ble');
  const wristTransport = process.env.HUB_NO_BLE
    ? undefined
    : loadWristBle().createNobleWristTransport();

  const services = await createHubServices({
    db,
    tcp: createNodeTcpFactory(),
    udp: createNodeUdpFactory(),
    ...(wristTransport ? { wristTransport } : {}),
    getEnvironment: () => ENVIRONMENT,
    onError: (err) => console.error('[hub]', err.message),
  });

  const { monitor, wrist, store } = services;

  monitor.on('device', (device) => {
    console.log(`[mini] discovered ${device.model} ${device.serial} at ${device.ip}`);
    void monitor.connect(device.ip);
  });
  monitor.on('connection', (state) => console.log(`[mini] ${state}`));
  wrist?.on('connection', (state) => console.log(`[wrist] ${state}`));

  store.subscribe((state, prev) => {
    const latest = state.sessionShots[0];
    if (latest && latest !== prev.sessionShots[0]) {
      const wristTag = latest.wrist ? ' +wrist' : '';
      console.log(
        `[shot] ${latest.measured.shotGuid} ` +
          `carry ${latest.flight?.carryM.toFixed(1) ?? '—'} m${wristTag}`,
      );
    }
  });

  const uiDir = join(__dirname, '../dist-ui');
  await startHubServer({
    services,
    environment: ENVIRONMENT,
    uiDir,
    port: UI_PORT,
  });

  store.getState().startDiscovery();
  store.getState().startWristScan();
  console.log(`[hub] running — session UI at http://localhost:${UI_PORT}`);

  process.on('SIGINT', () => {
    console.log('\n[hub] shutting down');
    monitor.disconnect();
    wrist?.disconnect();
    process.exit(0);
  });
}

void main();
