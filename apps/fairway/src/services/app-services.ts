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

import { getApiKey } from './api-key';
import { AppServices } from './context';
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

  const analysis = createAnalysisService({
    getApiKey,
    // RN's built-in fetch can't stream bodies; expo/fetch can
    fetchImpl: expoFetch as unknown as typeof fetch,
    dataStore: data,
  });

  const store = createFairwayStore({
    monitor,
    data,
    flightModel,
    getDefaultEnvironment: () => settings.getState().environment,
    onError,
  });

  // surface transport/protocol errors — a silent socket failure cost us a
  // debugging session once already
  monitor.on('error', onError);

  // reflect persisted handedness on the sensor whenever we (re)connect
  monitor.on('connection', (state) => {
    if (state === 'connected') {
      void monitor.setHandedness(settings.getState().handedness).catch(onError);
    }
  });

  return {
    monitor,
    data,
    analytics: { summarizeSession, summarizeClub },
    analysis,
    store,
    settings,
  };
}
