import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { openNodeDatabase } from '@golf/data/node';
import {
  ClipSource,
  ClipSourceSchema,
  ClipView,
  ClipViewSchema,
  Environment,
} from '@golf/types';

import { createClipStore } from './capture/clip-store';
import { createHttpClipSeam } from './capture/client';
import { createHttpCamera } from './capture/gopro/camera';
import { GoProDriver, createGoProDriver } from './capture/gopro/driver';
import { createFfmpegTrimmer } from './capture/gopro/trim';
import { createCaptureRegistry } from './capture/requests';
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

interface CameraConfig {
  source: ClipSource;
  view: ClipView;
  /** Where to reach it, for a camera the hub drives itself. */
  address: string | null;
}

/**
 * Cameras the hub should ask for footage, as `source:view` pairs with an
 * optional address —
 * `HUB_CAMERAS=phone:face_on,gopro:down_the_line@172.24.106.51`. Unset means no
 * cameras, and therefore no capture requests: a hub with nothing pointed at the
 * hitting bay should not spend every shot asking an empty room for a clip.
 *
 * The address is what splits the two kinds of camera apart. A phone finds the
 * hub itself and needs none. A GoPro cannot be told anything, so the hub runs
 * the client for it — and that client needs to know which body to talk to. It
 * rides here rather than in a second variable so there is still exactly one
 * list of what is pointed at the bay.
 */
function configuredCameras(): CameraConfig[] {
  const raw = process.env.HUB_CAMERAS?.trim();
  if (!raw) return [];
  return raw.split(',').map((entry) => {
    const [pair, address] = entry.trim().split('@');
    const [source, view] = pair.split(':');
    return {
      source: ClipSourceSchema.parse(source),
      view: ClipViewSchema.parse(view),
      address: address ?? null,
    };
  });
}

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

  // Capture (Phase 2). Both clip sources are ring-buffer devices — the phone's
  // buffer, the GoPro's Hindsight — so the ask goes out AFTER the ball is
  // struck, when the hub already knows which shot it is asking about. That is
  // why a clip is never matched to a shot by timing the way a wrist swing is.
  const cameras = configuredCameras();
  const captureRegistry = createCaptureRegistry();
  const clipStore = createClipStore(join(dataDir, 'clips'));
  if (cameras.length === 0) {
    console.log('[capture] no cameras — set HUB_CAMERAS=phone:down_the_line');
  } else {
    console.log(
      `[capture] ${cameras
        .map((c) => `${c.source}:${c.view}${c.address ? `@${c.address}` : ''}`)
        .join(', ')}`,
    );
  }
  for (const camera of cameras) {
    if (camera.source === 'gopro' && !camera.address) {
      console.log(
        `[capture] gopro:${camera.view} has no address — the hub will ask for ` +
          'its clips but nothing here will drive it ' +
          `(HUB_CAMERAS=gopro:${camera.view}@172.24.106.51)`,
      );
    }
  }

  store.subscribe((state, prev) => {
    const latest = state.sessionShots[0];
    if (latest && latest !== prev.sessionShots[0]) {
      const wristTag = latest.wrist ? ' +wrist' : '';
      console.log(
        `[shot] ${latest.measured.shotGuid} ` +
          `carry ${latest.flight?.carryM.toFixed(1) ?? '—'} m${wristTag}`,
      );
      for (const camera of cameras) {
        const request = captureRegistry.open({
          shotId: latest.id,
          sessionId: latest.sessionId,
          ...camera,
        });
        console.log(
          `[capture] ${camera.source}:${camera.view} → request ${request.id}`,
        );
      }
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
    capture: {
      data: services.data,
      clips: clipStore,
      registry: captureRegistry,
    },
    ...(onSessionEnd ? { onSessionEnd } : {}),
  });

  // The GoPro cannot be reached by the hub, so the hub runs its client: it
  // polls the same /api/clips endpoints a phone would, arms Hindsight, and
  // answers each request with the pre-roll around that shot. Started after the
  // server is listening, because that is what it talks to.
  const goproDrivers: GoProDriver[] = [];
  for (const camera of cameras) {
    if (camera.source !== 'gopro' || !camera.address) continue;
    const driver = createGoProDriver({
      camera: createHttpCamera(camera.address),
      seam: createHttpClipSeam(`http://127.0.0.1:${UI_PORT}`),
      trimmer: createFfmpegTrimmer(),
      view: camera.view,
      // One per body: a driver clears its scratch dir on the way up, and two
      // sharing one would clear each other's work in flight.
      workDir: join(dataDir, 'gopro-work', camera.view),
    });
    try {
      await driver.start();
      goproDrivers.push(driver);
    } catch (err) {
      // Only the missing-ffmpeg case gets here; an unreachable camera is
      // something the driver keeps working on by itself.
      console.error(`[gopro:${camera.view}] disabled — ${(err as Error).message}`);
    }
  }

  store.getState().startDiscovery();
  store.getState().startWristScan();
  console.log(`[hub] running — session UI at http://localhost:${UI_PORT}`);

  process.on('SIGINT', () => {
    console.log('\n[hub] shutting down');
    for (const driver of goproDrivers) driver.stop();
    monitor.disconnect();
    wrist?.disconnect();
    process.exit(0);
  });
}

void main();
