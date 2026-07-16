import { z } from 'zod';

import { Club } from './club';

/* ───────────────────────── wedge distance-control drill ─────────────────────────
   Trains 9 stock wedge shots: 3 rungs (low / mid / full) × 3 wedges, laddered
   from a 20-yard floor up to the longest full-swing carry. NOTHING about a
   rung's swing is assumed: the carry ladder is derived from measured full-swing
   carries (EYE MINI), and each rung's lead-wrist angle target is learned from
   the wrist sensor's top-of-backswing keyframe joined to those carries. The
   drill lib (@golf/drill) owns the math; this file is the shared contract. */

export const DrillRungSchema = z.enum(['low', 'mid', 'full']);
export type DrillRung = z.infer<typeof DrillRungSchema>;

/** Judged against the rung's target lead-wrist top angle. `calibrating` =
    no target existed yet (the rep still feeds the learning). */
export const DrillOutcomeSchema = z.enum([
  'match',
  'over', // backswing longer than the target window
  'under', // shorter
  'calibrating',
]);
export type DrillOutcome = z.infer<typeof DrillOutcomeSchema>;

/** One recorded drill swing. Created the instant the wrist `swing` event
    fires — BEFORE the launch monitor reports — so feedback is immediate;
    `shotId`/`carryM` attach ~1 s later when the Mini shot joins by arrival
    time. A rep with null carry is a ball-less rehearsal swing: it still gets
    angle feedback, it just doesn't enter the carry matrix. */
export const DrillRepSchema = z.object({
  id: z.string(),
  clubId: z.string(), // the wedge — a normal Club row
  rung: DrillRungSchema,
  shotId: z.string().nullable(),
  tMs: z.number(), // wrist impact arrival epoch ms
  topAngleDeg: z.number(), // |top.rotVecDeg| — backswing-length proxy
  topExtensionDeg: z.number().nullable(), // anatomical, only when calibrated
  backswingMs: z.number(), // address→top, feeds the cue tempo
  downswingMs: z.number(), // top→impact
  targetAngleDeg: z.number().nullable(), // the target in force when judged
  outcome: DrillOutcomeSchema,
  carryM: z.number().nullable(), // from the joined shot's computed flight
  createdAt: z.number(), // epoch ms
});
export type DrillRep = z.infer<typeof DrillRepSchema>;

/** Rehearsal "swing song" (hummable, Korda co-ca-co-la style): `beats` evenly
    spaced clicks across the backswing, then one accent at impact. Fewer beats
    over a shorter backswing = smaller swing; the downswing beat gap stays
    constant (downswing time barely changes with swing size). */
export interface DrillCue {
  beats: number; // backswing clicks, excluding the impact accent
  backswingMs: number;
  downswingMs: number;
}

export type DrillRungStatus =
  | 'collecting' // full rung: swing full swings until the anchor exists
  | 'needsFulls' // partial rung: waiting on this wedge's full-swing anchor
  | 'ready'; // target angle defined — feedback is live

/** One cell of the 3×3 matrix, fully computed from reps (never persisted). */
export interface DrillRungPlan {
  rung: DrillRung;
  status: DrillRungStatus;
  targetCarryM: number | null;
  targetAngleDeg: number | null;
  toleranceDeg: number;
  cue: DrillCue | null; // null until the target exists
  repCount: number;
  /** dispersion over reps that have a joined carry */
  carry: { n: number; meanM: number; sdM: number } | null;
}

export interface DrillWedgePlan {
  club: Club;
  /** ordered full, mid, low (descending target carry) */
  rungs: DrillRungPlan[];
}

export interface DrillPlan {
  wedges: DrillWedgePlan[]; // caller's wedge order preserved
  floorM: number; // shortest stock-shot carry the ladder reaches for
}

/** What the UI plays sound/haptics from, the instant a drill swing lands. */
export interface DrillRepFeedback {
  repId: string;
  clubId: string;
  rung: DrillRung;
  outcome: DrillOutcome;
  topAngleDeg: number;
  targetAngleDeg: number | null;
  deltaDeg: number | null; // topAngle − target; positive = over
  at: number; // epoch ms — effect dedup key
}
