import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { openNodeDatabase } from '@golf/data/node';
import { Environment } from '@golf/types';

import { runDailyCoachRecap } from './coach/recap-runner';
import { createRecapTracker } from './recap-endpoint';
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
  // FAIRWAY_DATA_DIR points the whole hub (DB, coach resources, API key) at a
  // scratch directory — how the UI gets exercised against seeded data without
  // touching the real practice history.
  const dataDir = process.env.FAIRWAY_DATA_DIR ?? join(homedir(), '.fairway');
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

  // Reform Coach: key from env or ~/.fairway/anthropic_api_key (chmod 600)
  const apiKey =
    process.env.ANTHROPIC_API_KEY ??
    ((): string | null => {
      try {
        return readFileSync(join(dataDir, 'anthropic_api_key'), 'utf8').trim();
      } catch {
        return null;
      }
    })();
  // A coach run outlives the request that triggered it, so the UI learns about
  // it here rather than from a response: the tracker is what /api/recaps reads
  // to say "one is being written" or "the last one failed".
  const recapTracker = createRecapTracker();
  let onSessionEnd: ((sessionId: string) => void) | undefined;
  if (apiKey) {
    const coach = {
      client: new Anthropic({ apiKey }),
      data: services.data,
      dataDir,
      handedness: 'right' as const,
    };
    onSessionEnd = (sessionId) => {
      console.log('[coach] building daily recap…');
      recapTracker.begin(sessionId);
      runDailyCoachRecap(coach, sessionId)
        .then(() => {
          recapTracker.succeed();
          console.log('[coach] recap saved');
        })
        .catch((err: Error) => {
          recapTracker.fail(err.message);
          console.error('[coach]', err.message);
        });
    };
  } else {
    console.log(
      '[coach] disabled — set ANTHROPIC_API_KEY or ~/.fairway/anthropic_api_key',
    );
  }

  const uiDir = join(__dirname, '../dist-ui');
  await startHubServer({
    services,
    environment: ENVIRONMENT,
    uiDir,
    port: UI_PORT,
    recapTracker,
    ...(onSessionEnd ? { onSessionEnd } : {}),
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
