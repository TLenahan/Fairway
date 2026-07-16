import { createAnalysisService } from '@golf/analysis';
import { summarizeClub, summarizeSession } from '@golf/analytics';
import {
  createDataStore,
  runMigrations,
  seedDefaultClubs,
  SqlDatabase,
} from '@golf/data';
import { flightModel } from '@golf/flight-model';
import { createNativeMonitorService } from '@golf/monitor';
import { createFairwayStore } from '@golf/store';
import { fetch as expoFetch } from 'expo/fetch';
import * as SQLite from 'expo-sqlite';

import {
  startKeepAlive,
  stopKeepAlive,
} from '../../modules/practice-keepalive';
import { getApiKey } from './api-key';
import { AppServices } from './context';
import { createNativeWristService } from './rn-ble-wrist-transport';
import { createSettingsStore, loadSettings } from './settings';

/**
 * Composition root (BUILD_SPEC §4) — the ONLY place concrete implementations
 * of the @golf/* contracts meet. Everything else works against interfaces.
 */
export async function createAppServices(
  onError: (err: Error) => void,
): Promise<AppServices> {
  const db = await SQLite.openDatabaseAsync('fairway.db');
  const sql: SqlDatabase = {
    execAsync: (statement) => db.execAsync(statement),
    runAsync: async (statement, params = []) => {
      await db.runAsync(statement, params);
    },
    getFirstAsync: (statement, params = []) =>
      db.getFirstAsync(statement, params),
    getAllAsync: (statement, params = []) => db.getAllAsync(statement, params),
  };
  await runMigrations(sql);

  const data = createDataStore(sql);
  await seedDefaultClubs(data);

  const settings = createSettingsStore(await loadSettings());
  const monitor = createNativeMonitorService();
  const wrist = createNativeWristService();

  const analysis = createAnalysisService({
    getApiKey,
    // RN's built-in fetch can't stream bodies; expo/fetch can
    fetchImpl: expoFetch as unknown as typeof fetch,
    dataStore: data,
  });

  const store = createFairwayStore({
    monitor,
    wrist,
    data,
    flightModel,
    getDefaultEnvironment: () => settings.getState().environment,
    onError,
  });

  // surface transport/protocol errors — a silent socket failure cost us a
  // debugging session once already
  monitor.on('error', onError);
  wrist.on('error', onError);

  // On (re)connect: reflect persisted handedness on the sensor and hold the
  // keep-alive foreground service for exactly the connected span, so shots
  // keep streaming with the screen off. Released on disconnect/error.
  monitor.on('connection', (state) => {
    if (state === 'connected') {
      startKeepAlive(
        'Fairway — connected',
        'Streaming shots from the EYE MINI',
      );
      void monitor.setHandedness(settings.getState().handedness).catch(onError);
    } else if (state === 'disconnected' || state === 'error') {
      stopKeepAlive();
    }
  });

  return {
    monitor,
    wrist,
    data,
    analytics: { summarizeSession, summarizeClub },
    analysis,
    store,
    settings,
  };
}
