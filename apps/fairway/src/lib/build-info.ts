import Constants from 'expo-constants';

/**
 * When this JS bundle's config was evaluated — set in app.config.js at
 * `expo start` / bundle time (NOT app launch), so it reflects the build the
 * phone is actually running. Shown on the Connect screen to confirm the device
 * picked up the latest code after a rebuild/restart.
 */
const buildTimeMs =
  (Constants.expoConfig?.extra?.buildTimeMs as number | undefined) ?? null;

/** Human-readable build time in Mountain Time (America/Denver, DST-aware). */
export function buildStamp(): string {
  if (buildTimeMs === null) return 'build time unavailable';
  try {
    const s = new Date(buildTimeMs).toLocaleString('en-US', {
      timeZone: 'America/Denver',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
    return `Build ${s} MT`;
  } catch {
    // Hermes without full Intl time-zone support — fall back to device local.
    return `Build ${new Date(buildTimeMs).toLocaleString()} (device local)`;
  }
}
