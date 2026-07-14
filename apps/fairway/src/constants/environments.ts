import { Environment } from '@golf/types';

/**
 * Altitude presets (BUILD_SPEC F9). Feeds both the FlightModel and the
 * sensor's altitude setting. The device itself reported ~1849 m at the home
 * test site.
 */
export const ENVIRONMENT_PRESETS: Environment[] = [
  { altitudeM: 1849, temperatureC: null, presetName: 'Home ~6,000 ft' },
  { altitudeM: 2286, temperatureC: null, presetName: 'Perry Park ~7,500 ft' },
  { altitudeM: 0, temperatureC: null, presetName: 'Sea level' },
];

export const DEFAULT_ENVIRONMENT = ENVIRONMENT_PRESETS[0];
