import {
  DistanceUnit,
  Environment,
  EnvironmentSchema,
  Handedness,
  SpeedUnit,
  WristCalibrationSchema,
} from '@golf/types';
import Storage from 'expo-sqlite/kv-store';
import { z } from 'zod';
import { createStore } from 'zustand/vanilla';

import { DEFAULT_ENVIRONMENT } from '../constants/environments';
import { METRIC_TILE_KEYS } from '../constants/metric-tiles';

/**
 * App settings (BUILD_SPEC F9), persisted in expo-sqlite's key-value store.
 * The Anthropic API key is NOT here — it lives exclusively in
 * expo-secure-store (see api-key.ts).
 */
export const SettingsSchema = z.object({
  speedUnit: SpeedUnit,
  distanceUnit: DistanceUnit,
  environment: EnvironmentSchema,
  handedness: Handedness,
  analysisModel: z.string(),
  deepAnalysis: z.boolean(),
  savedDeviceIp: z.string().nullable(),
  // lenient on purpose: unknown/missing keys are reconciled at render by
  // sanitizeTileOrder, and the default keeps pre-existing saved settings
  // parsing after this field was added
  tileOrder: z.array(z.string()).default([...METRIC_TILE_KEYS]),
  // wedges picked for the distance drill (≤3 club ids); the default keeps
  // pre-existing saved settings parsing after this field was added
  drillWedgeIds: z.array(z.string()).default([]),
  // wrist anatomical calibration from the flat+raise flow; null = uncalibrated
  wristCalibration: WristCalibrationSchema.nullable().default(null),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  speedUnit: 'mph',
  distanceUnit: 'yards',
  environment: DEFAULT_ENVIRONMENT,
  handedness: 'right',
  analysisModel: 'claude-sonnet-5',
  deepAnalysis: false,
  savedDeviceIp: null,
  tileOrder: [...METRIC_TILE_KEYS],
  drillWedgeIds: [],
  wristCalibration: null,
};

const STORAGE_KEY = 'fairway.settings.v1';

export type SettingsState = Settings & {
  update(patch: Partial<Settings>): void;
  setEnvironment(env: Environment): void;
};

export function createSettingsStore(initial: Settings) {
  return createStore<SettingsState>()((set, get) => ({
    ...initial,
    update(patch) {
      set(patch);
      void persistSettings(settingsOf(get()));
    },
    setEnvironment(environment) {
      set({ environment });
      void persistSettings(settingsOf(get()));
    },
  }));
}

const settingsOf = (state: SettingsState): Settings =>
  SettingsSchema.parse({
    speedUnit: state.speedUnit,
    distanceUnit: state.distanceUnit,
    environment: state.environment,
    handedness: state.handedness,
    analysisModel: state.analysisModel,
    deepAnalysis: state.deepAnalysis,
    savedDeviceIp: state.savedDeviceIp,
    tileOrder: state.tileOrder,
    drillWedgeIds: state.drillWedgeIds,
    wristCalibration: state.wristCalibration,
  });

export async function loadSettings(): Promise<Settings> {
  const raw = await Storage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  const parsed = SettingsSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

async function persistSettings(settings: Settings): Promise<void> {
  await Storage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
