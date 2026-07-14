import { z } from 'zod';

import { ClubCategory, SensorMode, SwingTag } from './enums';

export const ClubSchema = z.object({
  id: z.string(),
  name: z.string(), // free text, e.g. "60° ½ swing"
  category: ClubCategory,
  sensorMode: SensorMode, // derived via categoryToSensorMode
  swingTag: SwingTag.nullable(),
  loftDeg: z.number().nullable(),
  notes: z.string().nullable(),
  tracerColor: z.string().nullable(), // hex for this club's flight tracer; null = app default
  archived: z.boolean(),
  createdAt: z.number(), // epoch ms
});
export type Club = z.infer<typeof ClubSchema>;

/** Curated tracer swatches offered in the club editor. */
export const TRACER_COLORS = [
  '#ff4136', // red (default)
  '#ff851b', // orange
  '#ffdc00', // yellow
  '#2ecc40', // green
  '#39cccc', // teal
  '#0074d9', // blue
  '#b10dc9', // purple
  '#ffffff', // white
] as const;
export const DEFAULT_TRACER_COLOR = TRACER_COLORS[0];
