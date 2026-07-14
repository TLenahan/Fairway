import {
  DistanceUnit,
  Environment,
  EnvironmentSchema,
  Handedness,
  SpeedUnit,
} from '@golf/types';
import Storage from 'expo-sqlite/kv-store';
import { z } from 'zod';
import { createStore } from 'zustand/vanilla';

import { DEFAULT_ENVIRONMENT } from '../constants/environments';

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
