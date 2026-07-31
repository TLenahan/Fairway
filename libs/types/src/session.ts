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
  /**
   * The one club this session is about. Every statistic keys on
   * (club, intent), so a session that wanders the bag spreads its reps
   * across buckets that each stay below the findings and certification
   * gates — the focus is what makes a range trip add up to something.
   * Null = unfocused: sessions persisted before v10 and anything imported
   * from the phone.
   */
  focusClubId: z.string().nullable().default(null),
  createdAt: z.number(),
});
export type Session = z.infer<typeof SessionSchema>;
