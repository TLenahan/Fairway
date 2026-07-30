import { z } from 'zod';

export const SensorMode = z.enum(['tee', 'iron', 'putter']);
export const ClubCategory = z.enum([
  'driver',
  'wood',
  'hybrid',
  'iron',
  'wedge',
  'putter',
]);
export const SwingTag = z.enum(['full', 'three_quarter', 'half', 'chip']);
export const Handedness = z.enum(['right', 'left']);
export const SpeedUnit = z.enum(['mph', 'ms']);
export const DistanceUnit = z.enum(['yards', 'meters']);
export const AnalysisScope = z.enum([
  'session',
  'club',
  'trend',
  'compare',
  'diagnose',
  'plan',
]);
export const ConnectionState = z.enum([
  'disconnected',
  'discovering',
  'connecting',
  'connected',
  'error',
  'localNetworkDenied',
]);
/* per-shot intent bucket (Insights spec §6.1) — stats key on (club, intent).
   v1 values; stored as TEXT so future intents stay additive. 'untagged' is
   the quarantine bucket, never mixed into stock stats. */
export const ShotIntentSchema = z.enum(['stock', 'draw', 'fade', 'untagged']);
export type ShotIntent = z.infer<typeof ShotIntentSchema>;

/* map category → sensor mode (single source of truth; used by monitor + store) */
export const categoryToSensorMode: Record<
  z.infer<typeof ClubCategory>,
  z.infer<typeof SensorMode>
> = {
  driver: 'tee',
  wood: 'iron',
  hybrid: 'iron',
  iron: 'iron',
  wedge: 'iron',
  putter: 'putter',
};
