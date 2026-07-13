import { z } from 'zod';

import { Environment } from './session';

/* ───────────────────────── flight model (flight-model output) ─────────────────────────
   ALL COMPUTED. x=downrange, y=height, z=lateral(+right); meters, seconds.
   See handoff/FLIGHT_MODEL.md. */
export const LaunchConditionsSchema = z.object({
  ballSpeedMs: z.number(),
  launchAngleDeg: z.number(),
  launchDirectionDeg: z.number(),
  backspinRpm: z.number(),
  sidespinRpm: z.number(),
  rollspinRpm: z.number(),
});
export type LaunchConditions = z.infer<typeof LaunchConditionsSchema>;

export const FlightPathPointSchema = z.object({
  t: z.number(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
export type FlightPathPoint = z.infer<typeof FlightPathPointSchema>;

export const FlightResultSchema = z.object({
  path: z.array(FlightPathPointSchema),
  carryM: z.number(),
  totalM: z.number(),
  apexM: z.number(),
  descentDeg: z.number(),
  flightTimeS: z.number(),
  offlineM: z.number(),
  landing: z.object({ x: z.number(), z: z.number() }),
  rolloutM: z.number(),
  computed: z.literal(true),
});
export type FlightResult = z.infer<typeof FlightResultSchema>;

/** flight-model public API */
export interface FlightModel {
  simulate(launch: LaunchConditions, env: Environment): FlightResult;
}
