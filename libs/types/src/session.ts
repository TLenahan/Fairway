import { z } from 'zod';

import { ShotIntentSchema } from './enums';

export const EnvironmentSchema = z.object({
  altitudeM: z.number(),
  temperatureC: z.number().nullable(),
  presetName: z.string().nullable(), // e.g. "Home ~6,000 ft", "Perry Park ~7,500 ft"
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  notes: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  environment: EnvironmentSchema,
  // session-level intent; shots stamp it at capture (per-shot override wins).
  // Defaulted so sessions persisted before Insights still parse.
  defaultIntent: ShotIntentSchema.default('stock'),
  createdAt: z.number(),
});
export type Session = z.infer<typeof SessionSchema>;
