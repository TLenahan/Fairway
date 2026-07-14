import { z } from 'zod';

import { Environment, EnvironmentSchema } from './session';
import { ShotRecord } from './shot';

export const MetricStatSchema = z.object({
  n: z.number(), // MEASURED count (may be < shot count due to null rule)
  mean: z.number(),
  median: z.number(),
  sd: z.number(),
  min: z.number(),
  max: z.number(),
});
export type MetricStat = z.infer<typeof MetricStatSchema>;

export const DispersionSchema = z.object({
  centerX: z.number(),
  centerZ: z.number(), // pattern center (downrange, lateral) meters
  ellipseSemiMajorM: z.number(),
  ellipseSemiMinorM: z.number(),
  ellipseAngleDeg: z.number(),
  biasLateralM: z.number(),
  biasDepthM: z.number(), // systematic left/right & short/long
  lateralSpreadM: z.number(),
  depthSpreadM: z.number(),
});
export type Dispersion = z.infer<typeof DispersionSchema>;

export const ContactSchema = z.object({
  faceCentroidHMm: z.number().nullable(),
  faceCentroidVMm: z.number().nullable(),
  faceSpreadHMm: z.number().nullable(),
  faceSpreadVMm: z.number().nullable(),
  smashMean: z.number().nullable(),
  smashSd: z.number().nullable(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const BaselineGapSchema = z.object({
  source: z.object({ citation: z.string(), url: z.string().nullable() }),
  level: z.string(), // e.g. "scratch", "tour", "10-hcp"
  perMetricDelta: z.record(z.string(), z.number()), // golfer − baseline
});
export type BaselineGap = z.infer<typeof BaselineGapSchema>;

export const ClubSummarySchema = z.object({
  clubId: z.string(),
  clubName: z.string(),
  focusNote: z.string().nullable().optional(), // golfer's stated intent, for AI context
  shotCount: z.number(),
  // keys: ballSpeedMs, launchAngleDeg, backspinRpm, clubSpeedMs, clubPathDeg,
  // attackAngleDeg, carryM, ...
  metrics: z.record(z.string(), MetricStatSchema),
  dispersion: DispersionSchema,
  contact: ContactSchema,
  pathFaceGapDeg: z.number().nullable(), // face − path, the curvature driver
  carryM: MetricStatSchema.nullable(), // convenience for gapping
  baselineGap: BaselineGapSchema.nullable(),
});
export type ClubSummary = z.infer<typeof ClubSummarySchema>;

export const GappingEntrySchema = z.object({
  clubId: z.string(),
  clubName: z.string(),
  carryMeanM: z.number(),
  gapToNextM: z.number().nullable(),
  overlap: z.boolean(),
});
export type GappingEntry = z.infer<typeof GappingEntrySchema>;

export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  environment: EnvironmentSchema,
  shotCount: z.number(),
  clubs: z.array(ClubSummarySchema),
  gapping: z.array(GappingEntrySchema),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export interface AnalyticsEngine {
  summarizeSession(shots: ShotRecord[], env: Environment): SessionSummary;
  summarizeClub(shots: ShotRecord[]): ClubSummary;
}
