import {
  Handedness,
  WristCoachBlock,
  WristCoachCoverage,
  WristCoachKeyframes,
  WristSwingRecord,
} from '@golf/types';
import { z } from 'zod';

/**
 * Wrist portion of the daily session-JSON export (Reform Coach agent).
 *
 * Pure assembly over persisted wrist swings + the session's launch-monitor
 * shots: pairing, physical-bounds gating, the handedness-resolved radial
 * sign, wire rounding, and the coverage counters. The consumer computes only
 * from fields that are PRESENT — a missing field is safe, a wrong field is
 * poison — so nothing here clamps or null-fills; a value that can't be
 * trusted drops the swing's whole block into a coverage counter instead.
 *
 * Pairing is deliberately re-derived here (NOT reused from the live
 * wrist↔shot join): the export needs one-to-one certainty, so any ambiguity
 * inside the tolerance window pairs nothing, where the live join greedily
 * matches for UI immediacy.
 */

/** a swing attaches to a shot only within this single tolerance window */
export const WRIST_PAIR_TOLERANCE_MS = 3000;
/** physical bounds; any exported value outside drops the whole block */
export const EXT_BOUNDS_DEG: readonly [number, number] = [-60, 80];
export const RAD_BOUNDS_DEG: readonly [number, number] = [-45, 40];
export const ROT_BOUNDS_DEG: readonly [number, number] = [-90, 90];
/** strap-drift diagnostic: |last-third median − first-third median| of
    ext_setup beyond this, with the middle third in between, flags the strap */
export const STRAP_DRIFT_DEG = 5;
/** fewer exported blocks than this and a drift trend is noise */
export const STRAP_DRIFT_MIN_BLOCKS = 6;

type Handed = z.infer<typeof Handedness>;

/**
 * Anatomical deviation (+ about the calibration's vertical axis) → the wire's
 * radial-positive convention. Derivation from the flat+raise geometry: at the
 * neutral pose the deviation axis is world-up. For a RIGHT-handed golfer the
 * sensor rides the LEFT (lead) wrist — palm down, thumb on the right — so
 * radial deviation (thumb-ward) swings the fingertips clockwise seen from
 * above: NEGATIVE about up. Left-handed mirrors it. (Verified numerically
 * through calibrateFlatRaise + anatomicalAnglesDeg: +15° radial about −z
 * reads deviationDeg −15.)
 */
const radialSign = (handedness: Handed): number =>
  handedness === 'right' ? -1 : 1;

/**
 * Anatomical rotation (+ about the calibration's forearm axis, which points
 * body-ward at neutral) → the wire's supination-positive convention (the
 * face-closing direction for the lead wrist). For a RIGHT-handed golfer's
 * LEFT lead wrist, supination rolls the palm-down thumb (on the right) up
 * through vertical: POSITIVE about the body-ward axis, so the mapping is
 * already supination-positive. Left-handed mirrors it. (Verified numerically
 * through calibrateFlatRaise + anatomicalAnglesDeg: +25° left-forearm
 * supination reads rotationDeg +25.)
 */
const rotationSign = (handedness: Handed): number =>
  handedness === 'right' ? 1 : -1;

const round1 = (v: number): number => Math.round(v * 10) / 10;

const inBounds = (v: number, [lo, hi]: readonly [number, number]): boolean =>
  v >= lo && v <= hi;

/** Minimum a shot needs to pair: id + the arrival-clock timestamp the live
    join also rides (ShotRecord.capturedAt). Keeps the builder usable from
    capture replays, where "shots" are MINI labels, not DB rows. */
export interface WristPairShot {
  id: string;
  tMs: number;
}

export interface WristSessionExport {
  /** shot id → wire block, only for one-to-one pairs that survived gating */
  blocks: Record<string, WristCoachBlock>;
  coverage: WristCoachCoverage;
  /** true when ext_setup trended monotonically beyond the drift threshold */
  strapDrift: boolean;
}

/** The wire block, rounded; null when any value violates physical bounds. */
function toBlock(
  keyframes: WristCoachKeyframes,
  handedness: Handed,
): WristCoachBlock | null {
  const radSign = radialSign(handedness);
  const rotSign = rotationSign(handedness);
  const ext = [
    keyframes.setup.extensionDeg,
    keyframes.top.extensionDeg,
    keyframes.impact.extensionDeg,
    keyframes.peakDownExtensionDeg,
  ];
  const rad = [
    radSign * keyframes.setup.deviationDeg,
    radSign * keyframes.top.deviationDeg,
    radSign * keyframes.impact.deviationDeg,
  ];
  const rot = [
    rotSign * keyframes.setup.rotationDeg,
    rotSign * keyframes.top.rotationDeg,
    rotSign * keyframes.impact.rotationDeg,
  ];
  if (
    ext.some((v) => !inBounds(v, EXT_BOUNDS_DEG)) ||
    rad.some((v) => !inBounds(v, RAD_BOUNDS_DEG)) ||
    rot.some((v) => !inBounds(v, ROT_BOUNDS_DEG))
  ) {
    return null;
  }
  return {
    ext_setup: round1(ext[0]),
    ext_top: round1(ext[1]),
    ext_impact: round1(ext[2]),
    ext_peak_down: round1(ext[3]),
    rad_setup: round1(rad[0]),
    rad_top: round1(rad[1]),
    rad_impact: round1(rad[2]),
    rot_setup: round1(rot[0]),
    rot_top: round1(rot[1]),
    rot_impact: round1(rot[2]),
  };
}

/** One-to-one pairing: a swing attaches iff exactly one shot sits inside its
    tolerance window AND that shot has exactly one swing inside its own. */
function pairSwings(
  swings: WristSwingRecord[],
  shots: WristPairShot[],
): Map<WristSwingRecord, WristPairShot> {
  const swingCandidates = new Map<WristSwingRecord, WristPairShot[]>();
  const shotCandidateCounts = new Map<string, number>();
  for (const swing of swings) {
    const near = shots.filter(
      (shot) => Math.abs(shot.tMs - swing.tImpactMs) <= WRIST_PAIR_TOLERANCE_MS,
    );
    swingCandidates.set(swing, near);
    for (const shot of near) {
      shotCandidateCounts.set(shot.id, (shotCandidateCounts.get(shot.id) ?? 0) + 1);
    }
  }
  const paired = new Map<WristSwingRecord, WristPairShot>();
  for (const [swing, near] of swingCandidates) {
    if (near.length === 1 && shotCandidateCounts.get(near[0].id) === 1) {
      paired.set(swing, near[0]);
    }
  }
  return paired;
}

/** ext_setup trending monotonically across the session beyond the threshold —
    the strap has crept and every absolute inherits the offset. */
function detectStrapDrift(extSetups: number[]): boolean {
  if (extSetups.length < STRAP_DRIFT_MIN_BLOCKS) return false;
  const third = Math.floor(extSetups.length / 3);
  const median = (v: number[]): number => {
    const s = [...v].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const first = median(extSetups.slice(0, third));
  const middle = median(extSetups.slice(third, extSetups.length - third));
  const last = median(extSetups.slice(extSetups.length - third));
  const span = last - first;
  if (Math.abs(span) < STRAP_DRIFT_DEG) return false;
  // monotone: the middle third sits between the ends
  return span > 0
    ? middle >= first && middle <= last
    : middle <= first && middle >= last;
}

/**
 * Assemble the session's wrist blocks + coverage. Counters are mutually
 * exclusive and sum to `swings.length`: uncalibrated swings count first
 * (whole-session missing calibration ⇒ every swing lands there and zero
 * blocks export), then pairing (practice swings and ambiguities land in
 * `dropped_unpaired` silently), then per-swing extraction/gating quality.
 */
export function buildWristSessionExport(
  swings: WristSwingRecord[],
  shots: WristPairShot[],
  handedness: Handed,
): WristSessionExport {
  const coverage: WristCoachCoverage = {
    paired: 0,
    dropped_unpaired: 0,
    dropped_glitch: 0,
    dropped_no_setup: 0,
    dropped_uncalibrated: 0,
  };
  const ordered = [...swings].sort((a, b) => a.tImpactMs - b.tImpactMs);
  // EVERY swing participates in pairing — an uncalibrated swing can't export
  // a block, but it still blocks a one-to-one claim it sits inside (in a
  // mixed-calibration session, dropping it from the pool would let a nearby
  // rehearsal swing pair with a shot the uncalibrated swing actually struck)
  const paired = pairSwings(ordered, shots);
  const blocks: Record<string, WristCoachBlock> = {};
  const extSetups: number[] = [];
  for (const swing of ordered) {
    if (swing.coach.status === 'dropped' && swing.coach.reason === 'uncalibrated') {
      coverage.dropped_uncalibrated += 1;
      continue;
    }
    const shot = paired.get(swing);
    if (shot === undefined) {
      coverage.dropped_unpaired += 1;
      continue;
    }
    if (swing.coach.status === 'dropped') {
      if (swing.coach.reason === 'no_setup') coverage.dropped_no_setup += 1;
      else coverage.dropped_glitch += 1;
      continue;
    }
    const block = toBlock(swing.coach.keyframes, handedness);
    if (block === null) {
      coverage.dropped_glitch += 1;
      continue;
    }
    blocks[shot.id] = block;
    extSetups.push(block.ext_setup);
    coverage.paired += 1;
  }

  return { blocks, coverage, strapDrift: detectStrapDrift(extSetups) };
}
