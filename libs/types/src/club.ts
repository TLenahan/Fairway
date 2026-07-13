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
  archived: z.boolean(),
  createdAt: z.number(), // epoch ms
});
export type Club = z.infer<typeof ClubSchema>;
