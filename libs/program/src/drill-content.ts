import { z } from 'zod';

/**
 * The curated drill library's content schema (BUILD_SPEC §6.10).
 *
 * ONE library serves both the prescription loop and the coaching agent
 * (§6.12 rule 1) — the agent selects by `id` and may add cues and framing,
 * but never invents a drill, or the re-measure loop has nothing to track.
 *
 * Content lives in ../content/drills.json, versioned in the repo. A drill's
 * `version` is recorded on every block issued against it, so a later edit to
 * the wording never silently changes what an in-flight block was judged on.
 *
 * Tolerances here are RELATIVE (a multiple of the user's own great-shot
 * IQR), never absolute numbers — §6.10 requires bands derived from the
 * user's reference baseline, per club and per intent.
 */

/** Engine metric keys a drill can target. Mirrors InsightMetricKey; kept as
    a schema so bad content fails loudly at load rather than silently
    never matching a finding. */
export const DrillTargetMetricSchema = z.enum([
  'smash',
  'ballSpeedMs',
  'clubSpeedMs',
  'launchDeg',
  'launchDirDeg',
  'backspinRpm',
  'sidespinRpm',
  'carryM',
  'offlineM',
  'curveM',
  'apexM',
  'strikeHMm',
  'strikeVMm',
  'wristExtTop',
  'wristExtImpact',
  'wristExtPeakDown',
]);

export const DrillFailureModeSchema = z.enum([
  'pull',
  'push',
  'over-curve',
  'under-curve',
  'low-smash',
  'short',
  'long',
]);

export const DrillToleranceSchema = z.object({
  /** which target metric the band is drawn around */
  metric: DrillTargetMetricSchema,
  /** band half-width as a multiple of the great-shot IQR for that metric */
  iqrMultiple: z.number().positive(),
});

export const DrillGraduationSchema = z.object({
  /** qualifying shots in the bucket before the block is judged */
  remeasureShots: z.number().int().positive(),
  /** fraction of the metric's gap-to-band that must close (0–1) */
  metricGapClosed: z.number().min(0).max(1),
  /** the linked failure mode's rate must also fall by this fraction (0–1);
      §6.10 requires BOTH the metric and the outcome to move */
  outcomeImprovement: z.number().min(0).max(1),
});

export const DrillSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  /** what the drill is for, in the coach's own words */
  summary: z.string().min(1),
  /** metrics this drill is intended to move */
  targets: z.array(DrillTargetMetricSchema).min(1),
  /** failure modes it is indicated for — the prescription matcher's key */
  addresses: z.array(DrillFailureModeSchema).min(1),
  /** how to run it; the coach may reframe but not contradict this */
  protocol: z.string().min(1),
  tolerance: DrillToleranceSchema,
  graduation: DrillGraduationSchema,
  /** club categories it applies to; empty = all */
  clubCategories: z.array(
    z.enum(['driver', 'wood', 'hybrid', 'iron', 'wedge', 'putter']),
  ),
});

export type Drill = z.infer<typeof DrillSchema>;
export type DrillTolerance = z.infer<typeof DrillToleranceSchema>;
export type DrillGraduation = z.infer<typeof DrillGraduationSchema>;

export const DrillLibrarySchema = z.object({
  libraryVersion: z.number().int().positive(),
  drills: z.array(DrillSchema).min(1),
});
export type DrillLibrary = z.infer<typeof DrillLibrarySchema>;
