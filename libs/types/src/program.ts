import { z } from 'zod';

import { ShotIntentSchema } from './enums';

/* ───────────────────────── training blocks (BUILD_SPEC §6.10 / §6.12) ─────────
   ONE primitive covers both calendar-planned off-season work and
   finding-driven prescriptions (§6.12 rule 4), so scheduling, execution and
   the re-measure loop are shared rather than duplicated. `source` is the only
   thing that differs: 'program' blocks come from a plan, 'finding' blocks are
   prescribed by the analytics engine against a specific finding.

   Drill CONTENT is not persisted — only a reference to it. The curated
   library (@golf/program) is versioned in the repo so a block always records
   which version it was issued against. */

export const TrainingBlockSourceSchema = z.enum(['program', 'finding']);
export type TrainingBlockSource = z.infer<typeof TrainingBlockSourceSchema>;

export const TrainingBlockStatusSchema = z.enum([
  'active', // issued; the re-measure window has not closed
  'graduated', // target metric moved AND the linked outcome improved
  'escalated', // window closed without both — needs a different approach
  'abandoned', // superseded or dismissed by the user
]);
export type TrainingBlockStatus = z.infer<typeof TrainingBlockStatusSchema>;

/**
 * The tolerance band a block is judged against, derived from the user's OWN
 * reference baseline (§6.10: never universal constants). Recorded on the
 * block so a later evaluation judges against the band that was actually in
 * force when it was issued, not today's recomputed one.
 */
export const BlockToleranceSchema = z.object({
  metric: z.string(),
  center: z.number(), // the great-shot median at issue time
  halfWidth: z.number(), // ± band around it
  /** great-shot sample the band came from — thin baselines are weak evidence */
  nGreat: z.number(),
});
export type BlockTolerance = z.infer<typeof BlockToleranceSchema>;

export const TrainingBlockSchema = z.object({
  id: z.string(),
  source: TrainingBlockSourceSchema,
  /** stable finding identity (club|intent|failureMode|metric); null for
      program-sourced blocks. Deterministic so a block survives the engine
      recomputing its findings from scratch. */
  findingKey: z.string().nullable(),
  drillId: z.string(),
  drillVersion: z.number(),
  /** the bucket this block trains; null on a general program block */
  clubId: z.string().nullable(),
  intent: ShotIntentSchema.nullable(),
  tolerance: BlockToleranceSchema.nullable(),
  /** re-measure window: the block is judged once this many qualifying shots
      have been recorded in its bucket since issue (§6.10 closed loop) */
  remeasureShots: z.number(),
  status: TrainingBlockStatusSchema,
  startedAt: z.number(),
  resolvedAt: z.number().nullable(),
  /** why it graduated or escalated — the audit trail behind the verdict */
  resolutionNote: z.string().nullable(),
  createdAt: z.number(),
});
export type TrainingBlock = z.infer<typeof TrainingBlockSchema>;
