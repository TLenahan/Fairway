import { DrillRung } from '@golf/types';

export const DRILL_FLOOR_CARRY_M = 18.288; // 20 yd — shortest stock shot
// One threshold, because the angle and carry anchors now learn from ONE
// population: full-rung reps a launch monitor confirmed struck a ball.
export const MIN_FULL_SHOTS = 3; // full-swing anchors need this many confirmed
export const ANCHOR_WINDOW = 10; // medians run over the last N confirmed fulls
export const PARTIAL_MAX_FRACTION = 0.92; // partial target ≤ 92% of the wedge's full carry
export const MIN_RUNG_GAP_M = 4.572; // 5 yd — low must sit at least this under mid
export const DEFAULT_BACKSWING_MS = 750; // 3:1 tempo defaults until measured
export const DEFAULT_DOWNSWING_MS = 250;

/** Backswing clicks per rung (the impact accent is extra): 3 clicks + accent
    = 4 syllables = "co-ca-co-la" for a full swing; smaller rungs hum shorter
    motifs. */
export const CUE_BEATS: Record<DrillRung, number> = { low: 1, mid: 2, full: 3 };
