/**
 * Identity of the metric tiles on the practice-screen data strip. The order
 * here is the default strip order; the user's arrangement (long-press drag)
 * persists in settings.tileOrder.
 */
export const METRIC_TILE_KEYS = [
  'carry',
  'total',
  'ball',
  'club',
  'smash',
  'launch',
  'direction',
  'backspin',
  'sidespin',
  'apex',
  'side',
  'curve',
  'path',
  'attack',
] as const;

export type MetricTileKey = (typeof METRIC_TILE_KEYS)[number];

export function isMetricTileKey(value: string): value is MetricTileKey {
  return (METRIC_TILE_KEYS as readonly string[]).includes(value);
}

/**
 * Persisted order is stored leniently (plain strings), so drop unknown keys
 * and append any metrics added after the order was saved.
 */
export function sanitizeTileOrder(order: readonly string[]): MetricTileKey[] {
  const saved = [...new Set(order)].filter(isMetricTileKey);
  const missing = METRIC_TILE_KEYS.filter((key) => !saved.includes(key));
  return [...saved, ...missing];
}
