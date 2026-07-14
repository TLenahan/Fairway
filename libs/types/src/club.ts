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
  focusNote: z.string().nullable(), // what the golfer is working on — fed to AI analysis
  archived: z.boolean(),
  createdAt: z.number(), // epoch ms
});
export type Club = z.infer<typeof ClubSchema>;

/** Curated tracer swatches offered in the club editor (hex + label). */
export const TRACER_COLORS = [
  { hex: '#ff4136', name: 'Red' },
  { hex: '#ff851b', name: 'Orange' },
  { hex: '#ffdc00', name: 'Yellow' },
  { hex: '#2ecc40', name: 'Green' },
  { hex: '#39cccc', name: 'Teal' },
  { hex: '#0074d9', name: 'Blue' },
  { hex: '#b10dc9', name: 'Purple' },
  { hex: '#ffffff', name: 'White' },
] as const;
export const DEFAULT_TRACER_COLOR = TRACER_COLORS[0].hex;
export const tracerColorName = (hex: string): string =>
  TRACER_COLORS.find((c) => c.hex === hex)?.name ?? 'Custom';
