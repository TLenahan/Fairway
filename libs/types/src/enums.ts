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
