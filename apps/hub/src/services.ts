import {
  createDataStore,
  runMigrations,
  seedDefaultClubs,
  SqlDatabase,
} from '@golf/data';
import { flightModel } from '@golf/flight-model';
import { EyeMiniMonitor, TcpFactory, UdpFactory } from '@golf/monitor';
import { createFairwayStore, FairwayStore } from '@golf/store';
import { DataStore, Environment, MonitorService, WristService } from '@golf/types';
import { HackMotionWristService, WristBleTransport } from '@golf/wrist';

/**
 * Hub composition root — the Node/Electron-main counterpart of the app's
 * app-services.ts. Pure dependency injection: every I/O seam (SQL driver, TCP,
 * UDP, BLE) comes in through config so the whole hub runs against the replay
 * harness in jest. main.ts wires the real ones.
 */
export interface HubServicesConfig {
  db: SqlDatabase;
  tcp: TcpFactory;
  udp: UdpFactory;
  /** Omit to run monitor-only (e.g. wrist unit off or not paired yet). */
  wristTransport?: WristBleTransport;
  getEnvironment?: () => Environment;
  onError?: (err: Error) => void;
  /** Raw wrist-frame tap for NDJSON capture recording. */
  onRawWristFrame?: (frame: Uint8Array, tMs: number) => void;
}

export interface HubServices {
  data: DataStore;
  monitor: MonitorService;
  wrist: WristService | null;
  store: FairwayStore;
}

const DEFAULT_ENVIRONMENT: Environment = {
  altitudeM: 0,
  temperatureC: 20,
  presetName: null,
};

export async function createHubServices(
  config: HubServicesConfig,
): Promise<HubServices> {
  const onError = config.onError ?? ((err: Error) => console.error(err));

  await runMigrations(config.db);
  const data = createDataStore(config.db);
  await seedDefaultClubs(data);

  const monitor = new EyeMiniMonitor({ tcp: config.tcp, udp: config.udp });

  const wrist = config.wristTransport
    ? new HackMotionWristService({
        transport: config.wristTransport,
        ...(config.onRawWristFrame ? { onRawFrame: config.onRawWristFrame } : {}),
      })
    : null;

  const store = createFairwayStore({
    monitor,
    data,
    flightModel,
    ...(wrist ? { wrist } : {}),
    getDefaultEnvironment: config.getEnvironment ?? (() => DEFAULT_ENVIRONMENT),
    onError,
  });

  monitor.on('error', onError);
  wrist?.on('error', onError);

  return { data, monitor, wrist, store };
}
