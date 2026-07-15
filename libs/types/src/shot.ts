import { z } from 'zod';

import { Handedness } from './enums';
import { FlightResultSchema } from './flight';
import { WristShotSchema } from './wrist';

/* ───────────────────────── raw wire shot (monitor input) ─────────────────────────
   The exact shape of param.shotdataEX1 from the device. Values are integers ×1000,
   SI base. monitor validates device JSON against this before decoding.
   See handoff/BUILD_SPEC.md Appendix A.7. */
export const ShotDataEX1Schema = z
  .object({
    shotguid: z.object({
      Data1: z.number(),
      Data2: z.number(),
      Data3: z.number(),
      Data4: z.array(z.number()),
    }),
    category: z.number(),
    rightlefthanded: z.number(),
    xposx1000: z.number(),
    yposx1000: z.number(),
    zposx1000: z.number(),
    ballspeedx1000: z.number(),
    inclineX1000: z.number(),
    azimuthX1000: z.number(),
    spincalc_method: z.number(),
    assurance_spin: z.number(),
    backspinX1000: z.number(),
    sidespinX1000: z.number(),
    rollspinX1000: z.number(),
    clubcalc_method: z.number(),
    assurance_clubspeed: z.number(),
    assurance_clubpath: z.number(),
    assurance_faceangle: z.number(),
    assurance_attackangle: z.number(),
    assurance_loftangle: z.number(),
    assurance_lieangle: z.number(),
    assurance_faceimpactLateral: z.number(),
    assurance_faceimpactVertical: z.number(),
    clubspeedX1000: z.number(),
    clubpathX1000: z.number(),
    faceangleX1000: z.number(),
    attackangleX1000: z.number(),
    loftangleX1000: z.number(),
    lieangleX1000: z.number(),
    faceimpactLateralX1000: z.number(),
    faceimpactVerticalX1000: z.number(),
    impactTimestamp: z.number(),
  })
  .passthrough(); // tolerate unknown/new fields
export type ShotDataEX1 = z.infer<typeof ShotDataEX1Schema>;

/* ───────────────────────── decoded measured shot (monitor output) ─────────────────────────
   SI units. Club metrics are null when their assurance was 0 (NOT 0). This is the
   object every consumer uses; it never contains the ×1000 scaling. */
export const MeasuredShotSchema = z.object({
  shotGuid: z.string(), // `${Data1}-${Data2}-${Data3}` — dedup key
  handedness: Handedness,
  impactTimestamp: z.number(), // raw device value, opaque epoch
  ball: z.object({
    speedMs: z.number(),
    launchAngleDeg: z.number(), // VLA
    launchDirectionDeg: z.number(), // HLA, negative = left
    backspinRpm: z.number(),
    sidespinRpm: z.number(), // positive = right
    rollspinRpm: z.number(),
    spinAssurance: z.number(), // 0–100
  }),
  club: z.object({
    speedMs: z.number().nullable(),
    pathDeg: z.number().nullable(), // negative = out-to-in
    faceAngleDeg: z.number().nullable(),
    attackAngleDeg: z.number().nullable(),
    loftDeg: z.number().nullable(),
    lieDeg: z.number().nullable(),
    faceImpactHMm: z.number().nullable(),
    faceImpactVMm: z.number().nullable(),
  }),
  assurance: z.object({
    // keep the raw confidences for auditing why a metric is null
    spin: z.number(),
    clubSpeed: z.number(),
    clubPath: z.number(),
    faceAngle: z.number(),
    attackAngle: z.number(),
    loftAngle: z.number(),
    lieAngle: z.number(),
    faceImpactLateral: z.number(),
    faceImpactVertical: z.number(),
  }),
  smashFactor: z.number().nullable(), // ball/club speed, only when club speed measured
  shotImgPath: z.string().nullable(), // device-provided path to the impact image, if present
});
export type MeasuredShot = z.infer<typeof MeasuredShotSchema>;

/** what `data` stores/returns per shot (object view; columns per BUILD_SPEC §7). */
export const ShotRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  clubId: z.string(),
  shotGuid: z.string(),
  capturedAt: z.number(),
  discarded: z.boolean(),
  measured: MeasuredShotSchema,
  flight: FlightResultSchema.nullable(), // null until flight-model runs
  // Wrist mechanics joined from @golf/wrist by impact-arrival time. Absent when
  // no wrist unit was connected, or no swing matched this shot.
  wrist: WristShotSchema.optional(),
});
export type ShotRecord = z.infer<typeof ShotRecordSchema>;
