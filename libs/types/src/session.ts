import { z } from 'zod';

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
  createdAt: z.number(),
});
export type Session = z.infer<typeof SessionSchema>;
