import { mean, median, sampleSd } from '@golf/analytics';
import {
  Club,
  DrillPlan,
  DrillRep,
  DrillRung,
  DrillRungPlan,
  DrillWedgePlan,
} from '@golf/types';

import { CarrySample, targetAngleForCarry } from './angle-model';
import { toleranceFor } from './classify';
import {
  ANCHOR_WINDOW,
  CUE_BEATS,
  DEFAULT_BACKSWING_MS,
  DEFAULT_DOWNSWING_MS,
  DRILL_FLOOR_CARRY_M,
  MIN_FULL_SHOTS,
} from './constants';
import { buildCarryLadder, PartialCarries, WedgeFullAnchor } from './ladder';

/** Everything one wedge's rungs derive from: its reps plus the learned
    full-swing anchors and tempo (medians over the last ANCHOR_WINDOW fulls —
    the window lets a drifting swing age out old reps). */
interface WedgeState {
  club: Club;
  reps: DrillRep[];
  anchorAngleDeg: number | null;
  anchorCarryM: number | null;
  backswingMs: number;
  downswingMs: number;
}

const wedgeState = (club: Club, reps: DrillRep[]): WedgeState => {
  const clubReps = reps.filter((r) => r.clubId === club.id);
  // The anchor learns ONLY from full swings a launch monitor confirmed struck
  // a ball (shotId set by the wrist↔shot join). A practice swing has the same
  // top angle as a real one but no carry, so admitting it would bias the angle
  // median while contributing nothing to carry — the two anchors must come
  // from one population for their ratio (the slope prior) to mean anything.
  const window = clubReps
    .filter((r) => r.rung === 'full' && r.shotId !== null && r.carryM !== null)
    .slice(-ANCHOR_WINDOW);
  const ready = window.length >= MIN_FULL_SHOTS;
  return {
    club,
    reps: clubReps,
    anchorAngleDeg: ready ? median(window.map((r) => r.topAngleDeg)) : null,
    anchorCarryM: ready
      ? median(window.flatMap((r) => (r.carryM === null ? [] : [r.carryM])))
      : null,
    backswingMs:
      window.length > 0
        ? median(window.map((r) => r.backswingMs))
        : DEFAULT_BACKSWING_MS,
    downswingMs:
      window.length > 0
        ? median(window.map((r) => r.downswingMs))
        : DEFAULT_DOWNSWING_MS,
  };
};

/** Dispersion over the rung's joined carries; null when none have landed. */
const carryStats = (reps: DrillRep[]): DrillRungPlan['carry'] => {
  const carries = reps.flatMap((r) => (r.carryM === null ? [] : [r.carryM]));
  if (carries.length === 0) return null;
  return { n: carries.length, meanM: mean(carries), sdM: sampleSd(carries) };
};

const fullRungPlan = (s: WedgeState): DrillRungPlan => {
  const fullReps = s.reps.filter((r) => r.rung === 'full');
  const base: Pick<DrillRungPlan, 'rung' | 'repCount' | 'carry'> = {
    rung: 'full',
    repCount: fullReps.length,
    carry: carryStats(fullReps),
  };
  if (s.anchorAngleDeg === null) {
    return {
      ...base,
      status: 'collecting',
      targetCarryM: null,
      targetAngleDeg: null,
      toleranceDeg: toleranceFor(0),
      cue: null,
    };
  }
  return {
    ...base,
    status: 'ready',
    // the anchor IS the target: the drill trains repeating the stock full
    targetCarryM: s.anchorCarryM,
    targetAngleDeg: s.anchorAngleDeg,
    toleranceDeg: toleranceFor(s.anchorAngleDeg),
    cue: {
      beats: CUE_BEATS.full,
      backswingMs: s.backswingMs,
      downswingMs: s.downswingMs,
    },
  };
};

const partialRungPlan = (
  s: WedgeState,
  rung: Exclude<DrillRung, 'full'>,
  partials: PartialCarries | undefined,
): DrillRungPlan => {
  const rungReps = s.reps.filter((r) => r.rung === rung);
  const base: Pick<DrillRungPlan, 'rung' | 'repCount' | 'carry'> = {
    rung,
    repCount: rungReps.length,
    carry: carryStats(rungReps),
  };
  if (
    s.anchorAngleDeg === null ||
    s.anchorCarryM === null ||
    partials === undefined
  ) {
    return {
      ...base,
      status: 'needsFulls',
      targetCarryM: null,
      targetAngleDeg: null,
      toleranceDeg: toleranceFor(s.anchorAngleDeg ?? 0),
      cue: null,
    };
  }
  const targetCarryM = rung === 'mid' ? partials.midM : partials.lowM;
  const samples: CarrySample[] = s.reps.flatMap((r) =>
    r.carryM === null ? [] : [{ topAngleDeg: r.topAngleDeg, carryM: r.carryM }],
  );
  const targetAngleDeg = targetAngleForCarry(
    samples,
    { angleDeg: s.anchorAngleDeg, carryM: s.anchorCarryM },
    targetCarryM,
  );
  return {
    ...base,
    status: 'ready',
    targetCarryM,
    targetAngleDeg,
    toleranceDeg: toleranceFor(s.anchorAngleDeg),
    cue: {
      beats: CUE_BEATS[rung],
      // shorter swing, proportionally shorter backswing; downswing time is
      // near-constant across swing sizes, so it stays unscaled
      backswingMs: s.backswingMs * (targetAngleDeg / s.anchorAngleDeg),
      downswingMs: s.downswingMs,
    },
  };
};

/**
 * The whole 3×3 matrix, recomputed from scratch on every rep — reps are the
 * only persisted state, so the plan is always exactly what the data says.
 * Full rungs come straight from their anchors; partial carry targets come
 * from ONE global ladder over every wedge that has both anchors (so the nine
 * stock shots ladder together, not per wedge); partial angle targets come
 * from each wedge's angle↔carry model.
 */
export const computeDrillPlan = (
  wedges: Club[],
  reps: DrillRep[],
  floorM = DRILL_FLOOR_CARRY_M,
): DrillPlan => {
  const states = wedges.map((club) => wedgeState(club, reps));

  const anchored: WedgeFullAnchor[] = states.flatMap((s) =>
    s.anchorAngleDeg !== null && s.anchorCarryM !== null
      ? [{ clubId: s.club.id, fullCarryM: s.anchorCarryM }]
      : [],
  );
  const ladder = buildCarryLadder(anchored, floorM);

  const wedgePlans: DrillWedgePlan[] = states.map((s) => ({
    club: s.club,
    rungs: [
      fullRungPlan(s),
      partialRungPlan(s, 'mid', ladder.get(s.club.id)),
      partialRungPlan(s, 'low', ladder.get(s.club.id)),
    ],
  }));
  return { wedges: wedgePlans, floorM };
};
