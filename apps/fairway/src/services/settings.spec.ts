import { WristCalibration } from '@golf/types';

import {
  createSettingsStore,
  DEFAULT_SETTINGS,
  loadSettings,
} from './settings';

// In-memory stand-in for expo-sqlite's kv-store so persistSettings/loadSettings
// round-trip against real storage semantics (string in, string out).
const mockStorage = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => mockStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      mockStorage.set(key, value);
    },
  },
}));

// update() persists fire-and-forget (void promise); a macrotask flushes it.
const flushPersist = () =>
  new Promise<void>((resolve) => setImmediate(() => resolve()));

const calibration: WristCalibration = {
  qRef: [0.98, 0.01, -0.17, 0.05],
  frame: [
    [0.9, 0.1, 0.0],
    [-0.1, 0.9, 0.0],
    [0.0, 0.0, 1.0],
  ],
};

beforeEach(() => {
  mockStorage.clear();
});

describe('settings persistence', () => {
  it('round-trips wristCalibration set via update()', async () => {
    const store = createSettingsStore(DEFAULT_SETTINGS);

    store.getState().update({ wristCalibration: calibration });
    await flushPersist();

    const loaded = await loadSettings();
    expect(loaded.wristCalibration).toEqual(calibration);
  });

  it('keeps a saved wristCalibration across unrelated updates', async () => {
    // As after an app restart post-calibration: the store hydrates with a
    // non-null calibration, then the user changes some other setting.
    const store = createSettingsStore({
      ...DEFAULT_SETTINGS,
      wristCalibration: calibration,
    });

    store.getState().update({ deepAnalysis: true });
    await flushPersist();

    const loaded = await loadSettings();
    expect(loaded.deepAnalysis).toBe(true);
    expect(loaded.wristCalibration).toEqual(calibration);
  });
});
