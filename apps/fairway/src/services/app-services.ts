import { createAnalysisService } from '@golf/analysis';
import { summarizeClub, summarizeSession } from '@golf/analytics';
import {
  createDataStore,
  runMigrations,
  seedDefaultClubs,
  SqlDatabase,
} from '@golf/data';
import { flightModel } from '@golf/flight-model';
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
import { createNativeMonitorService } from './rn-monitor-transport';
import { createSettingsStore, loadSettings } from './settings';
import { createWristCaptureRecorder } from './wrist-capture';

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
  const wristCapture = createWristCaptureRecorder();
  const wrist = createNativeWristService({
    onRawFrame: wristCapture.record,
  });
  // apply persisted anatomical calibration (flat+raise flow) from last session
  wrist.setCalibration(settings.getState().wristCalibration);

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

  // Self-labeling captures: while the wrist recorder is running, stamp the
  // active club + an EYE MINI `shot` line (same host clock as the frames) into
  // the capture. A wrist swing that time-aligns to a `shot` struck a ball; one
  // that doesn't is a practice swing. This is the ground truth the detector is
  // tuned against, so the raw frames never need a separate DB export to label.
  {
    let wasRecording = false;
    let lastShotId: string | null = null;
    let lastClubId: string | null = null;
    const emitContext = (): void => {
      const club = store.getState().activeClub;
      wristCapture.event({
        type: 'context',
        t: Date.now(),
        calibrated: settings.getState().wristCalibration !== null,
        club: club
          ? {
              id: club.id,
              name: club.name,
              category: club.category,
              loftDeg: club.loftDeg ?? null,
            }
          : null,
      });
    };
    store.subscribe((state) => {
      const recording = wristCapture.status().recording;
      if (recording && !wasRecording) {
        // fresh capture: snapshot context, and don't back-emit older shots
        lastClubId = state.activeClub?.id ?? null;
        lastShotId = state.sessionShots[0]?.id ?? null;
        emitContext();
      }
      wasRecording = recording;
      if (!recording) return;

      if (state.activeClub && state.activeClub.id !== lastClubId) {
        lastClubId = state.activeClub.id;
        emitContext();
      }
      const shot = state.sessionShots[0];
      if (shot && shot.id !== lastShotId) {
        lastShotId = shot.id;
        wristCapture.event({
          type: 'shot',
          t: shot.capturedAt,
          shotGuid: shot.shotGuid,
          clubId: shot.clubId,
          carryM: shot.flight?.carryM ?? null,
          ballSpeedMs: shot.measured.ball.speedMs,
        });
      }
    });
  }

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
    wristCapture,
  };
}
