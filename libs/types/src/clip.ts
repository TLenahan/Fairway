import { z } from 'zod';

/* ─────────────────────────── swing clips (Phase 2 capture) ────────────────────
   Capture is RETROSPECTIVE. Both candidate sources hold a rolling pre-roll —
   the phone's ring buffer, the GoPro's Hindsight — and are triggered *after*
   the ball is struck, at monitor time T. So the hub already knows which shot
   it is asking for when it asks.

   That is the difference from the wrist sensor. HackMotion streams on its own
   clock and its swings must be matched to shots by nearest-neighbour join
   (@golf/store, ±1.5 s). A clip is not joined: the hub mints a CaptureRequest
   naming the shot, hands it to a camera, and the camera returns bytes against
   that id. The association is assigned, and therefore exact.

   The rule that falls out: a clip with no live request is REJECTED, not
   guessed at. A clip filed against the wrong shot is worse than a missing one
   — every pose metric Phase 3 derives from it would be attributed to a swing
   that did not produce it. */

/** Where the bytes came from. Both are ring-buffer devices; see GOPRO_CAPTURE.md. */
export const ClipSourceSchema = z.enum(['phone', 'gopro']);
export type ClipSource = z.infer<typeof ClipSourceSchema>;

/** Camera placement. The two-view station runs both at once. */
export const ClipViewSchema = z.enum(['down_the_line', 'face_on']);
export type ClipView = z.infer<typeof ClipViewSchema>;

/**
 * How the clip's timeline was aligned to impact (Phase 0 audit, decision 6):
 * `fine` means impact audio located the frame; `coarse` means it did not and
 * the offset is the trigger-time estimate. Recorded rather than assumed so a
 * pose metric can say how well it knows where impact was.
 */
export const ClipSyncSchema = z.enum(['coarse', 'fine']);
export type ClipSync = z.infer<typeof ClipSyncSchema>;

/**
 * A capture the hub has asked for but not yet received. Lives in memory on
 * the hub only — an unfulfilled request is not history, and a camera that
 * misses its window should leave nothing behind.
 */
export const CaptureRequestSchema = z.object({
  id: z.string(),
  shotId: z.string(),
  sessionId: z.string(),
  source: ClipSourceSchema,
  view: ClipViewSchema,
  /** host clock at the moment the shot landed — the trigger instant */
  requestedAt: z.number(),
  /** after this the request is dead; a late clip is a clip about nothing */
  expiresAt: z.number(),
});
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;

export const ClipSchema = z.object({
  id: z.string(),
  /** the shot this clip is OF — assigned at request time, never inferred */
  shotId: z.string(),
  sessionId: z.string(),
  source: ClipSourceSchema,
  view: ClipViewSchema,
  /** path relative to the hub's clips dir; absolute paths would not survive a
      data-dir move, and the data dir is already a configurable (FAIRWAY_DATA_DIR) */
  path: z.string(),
  bytes: z.number(),
  durationMs: z.number(),
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  sync: ClipSyncSchema,
  /**
   * Milliseconds from the first frame to impact — the frame Phase 3 measures
   * everything against. Null while unlocated: the NULL-never-0 rule applies
   * here as hard as it does to a sensor channel, because 0 is a real answer
   * (impact on the first frame) and "we don't know" is not.
   */
  impactOffsetMs: z.number().nullable(),
  /** host clock at the trigger, carried over from the request */
  capturedAt: z.number(),
  createdAt: z.number(),
});
export type Clip = z.infer<typeof ClipSchema>;
