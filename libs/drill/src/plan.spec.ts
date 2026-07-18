import {
  Club,
  DrillPlan,
  DrillRep,
  DrillRung,
  DrillRungPlan,
} from '@golf/types';

import { ANCHOR_WINDOW, DRILL_FLOOR_CARRY_M } from './constants';
import { computeDrillPlan } from './plan';

const wedge = (id: string, name: string): Club => ({
  id,
  name,
  category: 'wedge',
  sensorMode: 'iron',
  swingTag: 'full',
  loftDeg: null,
  notes: null,
  tracerColor: null,
  focusNote: null,
  archived: false,
  createdAt: 1,
});

let seq = 0;
beforeEach(() => {
  seq = 0;
});

const rep = (
  clubId: string,
  rung: DrillRung,
  topAngleDeg: number,
  carryM: number | null,
  tempo: { backswingMs: number; downswingMs: number } = {
    backswingMs: 720,
    downswingMs: 240,
  },
): DrillRep => {
  seq += 1;
  return {
    id: `r${seq}`,
    clubId,
    rung,
    shotId: carryM === null ? null : `s${seq}`,
    tMs: seq * 1000,
    topAngleDeg,
    topExtensionDeg: null,
    backswingMs: tempo.backswingMs,
    downswingMs: tempo.downswingMs,
    targetAngleDeg: null,
    outcome: 'calibrating',
    carryM,
    createdAt: seq * 1000,
  };
};

const rungOf = (
  plan: DrillPlan,
  clubId: string,
  rung: DrillRung,
): DrillRungPlan => {
  const found = plan.wedges
    .find((w) => w.club.id === clubId)
    ?.rungs.find((r) => r.rung === rung);
  if (found === undefined) throw new Error(`missing rung ${clubId}/${rung}`);
  return found;
};

describe('computeDrillPlan — empty state', () => {
  it('0 reps → fulls collecting, partials needing fulls, nothing claimed', () => {
    const plan = computeDrillPlan([wedge('pw', 'PW'), wedge('lw', '60°')], []);
    expect(plan.floorM).toBeCloseTo(DRILL_FLOOR_CARRY_M);
    expect(plan.wedges.map((w) => w.club.id)).toEqual(['pw', 'lw']);
    for (const w of plan.wedges) {
      expect(w.rungs.map((r) => r.rung)).toEqual(['full', 'mid', 'low']);
      expect(w.rungs[0].status).toBe('collecting');
      expect(w.rungs[1].status).toBe('needsFulls');
      expect(w.rungs[2].status).toBe('needsFulls');
      for (const r of w.rungs) {
        expect(r.targetAngleDeg).toBeNull();
        expect(r.targetCarryM).toBeNull();
        expect(r.cue).toBeNull();
        expect(r.repCount).toBe(0);
        expect(r.carry).toBeNull();
        expect(r.toleranceDeg).toBe(4); // the pre-anchor default
      }
    }
  });
});

describe('computeDrillPlan — full 3-wedge bag with joined carries', () => {
  // Medians land on the ladder.spec fixture: fulls 100.6 / 77.7 / 64.0.
  const wedges = [wedge('pw', 'PW'), wedge('sw', '56°'), wedge('lw', '60°')];
  const reps = [
    rep('pw', 'full', 78, 100, { backswingMs: 700, downswingMs: 230 }),
    rep('pw', 'full', 80, 100.6, { backswingMs: 720, downswingMs: 240 }),
    rep('pw', 'full', 82, 101.6, { backswingMs: 740, downswingMs: 250 }),
    rep('sw', 'full', 76, 77),
    rep('sw', 'full', 78, 77.7),
    rep('sw', 'full', 80, 78.5),
    rep('lw', 'full', 74, 63),
    rep('lw', 'full', 76, 64),
    rep('lw', 'full', 78, 65),
  ];
  const plan = computeDrillPlan(wedges, reps);

  it('full rungs anchor on the medians', () => {
    const full = rungOf(plan, 'pw', 'full');
    expect(full.status).toBe('ready');
    expect(full.targetAngleDeg).toBeCloseTo(80);
    expect(full.targetCarryM).toBeCloseTo(100.6);
    expect(full.toleranceDeg).toBeCloseTo(6.4); // 8% of 80°
    expect(full.cue).toEqual({ beats: 3, backswingMs: 720, downswingMs: 240 });
    expect(full.repCount).toBe(3);
  });

  it('full-rung carry stats are hand-checked', () => {
    const carry = rungOf(plan, 'pw', 'full').carry;
    expect(carry?.n).toBe(3);
    expect(carry?.meanM).toBeCloseTo(100.7333, 3);
    expect(carry?.sdM).toBeCloseTo(0.8083, 3); // sample sd
  });

  it('partial carry targets come from the shared 9-rung ladder', () => {
    expect(rungOf(plan, 'lw', 'low').targetCarryM).toBeCloseTo(18.288, 3);
    expect(rungOf(plan, 'lw', 'mid').targetCarryM).toBeCloseTo(28.577, 3);
    expect(rungOf(plan, 'sw', 'low').targetCarryM).toBeCloseTo(38.866, 3);
    expect(rungOf(plan, 'sw', 'mid').targetCarryM).toBeCloseTo(49.155, 3);
    expect(rungOf(plan, 'pw', 'low').targetCarryM).toBeCloseTo(69.733, 3);
    expect(rungOf(plan, 'pw', 'mid').targetCarryM).toBeCloseTo(90.311, 3);
  });

  it('partial angle targets follow the prior slope (3 carries < LSQ minimum)', () => {
    // prior = 100.6 / 80 = 1.2575 m/deg
    const mid = rungOf(plan, 'pw', 'mid');
    const low = rungOf(plan, 'pw', 'low');
    expect(mid.targetAngleDeg).toBeCloseTo(71.818, 3); // 80 − 10.289/1.2575
    expect(low.targetAngleDeg).toBeCloseTo(55.454, 3); // 80 − 30.867/1.2575
    expect(mid.status).toBe('ready');
    expect(low.status).toBe('ready');
    expect(mid.toleranceDeg).toBeCloseTo(6.4); // tolerance tracks the anchor
  });

  it('per wedge the angle targets ascend low < mid < full', () => {
    for (const w of plan.wedges) {
      const [full, mid, low] = w.rungs;
      expect(low.targetAngleDeg ?? NaN).toBeLessThan(mid.targetAngleDeg ?? NaN);
      expect(mid.targetAngleDeg ?? NaN).toBeLessThan(
        full.targetAngleDeg ?? NaN,
      );
    }
  });

  it('partial cues scale the backswing by angle ratio, downswing untouched', () => {
    const mid = rungOf(plan, 'pw', 'mid');
    const low = rungOf(plan, 'pw', 'low');
    expect(mid.cue?.beats).toBe(2);
    expect(low.cue?.beats).toBe(1);
    expect(mid.cue?.backswingMs).toBeCloseTo(646.361, 2); // 720 × 71.818/80
    expect(low.cue?.backswingMs).toBeCloseTo(499.083, 2); // 720 × 55.454/80
    expect(mid.cue?.downswingMs).toBe(240);
    expect(low.cue?.downswingMs).toBe(240);
  });

  it('partial rungs start with no reps of their own', () => {
    const mid = rungOf(plan, 'pw', 'mid');
    expect(mid.repCount).toBe(0);
    expect(mid.carry).toBeNull();
  });
});

describe('computeDrillPlan — partial knowledge', () => {
  it('rehearsal swings (no confirmed ball) never anchor', () => {
    // Three full-length swings with the right wrist angle but no ball behind
    // them. A launch monitor confirmed nothing, so they must not become the
    // target other reps get judged against.
    const plan = computeDrillPlan(
      [wedge('lw', '60°')],
      [
        rep('lw', 'full', 74, null),
        rep('lw', 'full', 76, null),
        rep('lw', 'full', 78, null),
      ],
    );
    const full = rungOf(plan, 'lw', 'full');
    expect(full.status).toBe('collecting');
    expect(full.targetAngleDeg).toBeNull();
    expect(full.targetCarryM).toBeNull();
    expect(full.cue).toBeNull();
    expect(full.repCount).toBe(3); // still shown in the rep tally
    const mid = rungOf(plan, 'lw', 'mid');
    expect(mid.status).toBe('needsFulls');
    expect(mid.toleranceDeg).toBe(4); // no anchor ⇒ the pre-anchor default
  });

  it('one confirmed full is not enough — anchor waits for MIN_FULL_SHOTS', () => {
    // Two rehearsals plus a single real, measured shot. The real shot alone
    // can't anchor, and the rehearsals can never help it get there.
    const plan = computeDrillPlan(
      [wedge('lw', '60°')],
      [
        rep('lw', 'full', 74, null),
        rep('lw', 'full', 76, null),
        rep('lw', 'full', 78, 64),
      ],
    );
    expect(rungOf(plan, 'lw', 'full').status).toBe('collecting');
  });

  it('anchors once MIN_FULL_SHOTS real balls land, ignoring rehearsals', () => {
    const plan = computeDrillPlan(
      [wedge('lw', '60°')],
      [
        rep('lw', 'full', 40, null), // rehearsal — excluded from the median
        rep('lw', 'full', 74, 63),
        rep('lw', 'full', 76, 64),
        rep('lw', 'full', 78, 65),
      ],
    );
    const full = rungOf(plan, 'lw', 'full');
    expect(full.status).toBe('ready');
    expect(full.targetAngleDeg).toBeCloseTo(76); // median(74,76,78), not the 40
    expect(full.targetCarryM).toBeCloseTo(64);
  });

  it('a wedge without fulls stays needsFulls while others proceed', () => {
    const plan = computeDrillPlan(
      [wedge('pw', 'PW'), wedge('lw', '60°')],
      [
        rep('pw', 'full', 78, 100),
        rep('pw', 'full', 80, 100.6),
        rep('pw', 'full', 82, 101.6),
        rep('lw', 'full', 75, 62),
        rep('lw', 'full', 77, 64),
        rep('lw', 'mid', 50, 30),
        rep('lw', 'mid', 52, null),
      ],
    );
    // lw: 2 confirmed fulls < MIN_FULL_SHOTS
    expect(rungOf(plan, 'lw', 'full').status).toBe('collecting');
    expect(rungOf(plan, 'lw', 'mid').status).toBe('needsFulls');
    expect(rungOf(plan, 'lw', 'mid').repCount).toBe(2);
    expect(rungOf(plan, 'lw', 'mid').carry?.n).toBe(1);
    // pw proceeds alone: the ladder is n = 1 over [floor, 100.6]
    expect(rungOf(plan, 'pw', 'low').targetCarryM).toBeCloseTo(18.288, 3);
    expect(rungOf(plan, 'pw', 'mid').targetCarryM).toBeCloseTo(
      (DRILL_FLOOR_CARRY_M + 100.6) / 2,
      3,
    );
  });

  it('carry stats skip null carries but repCount includes rehearsals', () => {
    const plan = computeDrillPlan(
      [wedge('lw', '60°')],
      [
        rep('lw', 'mid', 50, 10),
        rep('lw', 'mid', 51, null),
        rep('lw', 'mid', 52, 12),
        rep('lw', 'mid', 53, null),
        rep('lw', 'mid', 54, 14),
      ],
    );
    const mid = rungOf(plan, 'lw', 'mid');
    expect(mid.repCount).toBe(5);
    expect(mid.carry).toEqual({ n: 3, meanM: 12, sdM: 2 });
  });

  it('reps from clubs outside the drill are ignored', () => {
    const plan = computeDrillPlan(
      [wedge('lw', '60°')],
      [
        rep('other', 'full', 74, 60),
        rep('other', 'full', 76, 61),
        rep('other', 'full', 78, 62),
      ],
    );
    const full = rungOf(plan, 'lw', 'full');
    expect(full.status).toBe('collecting');
    expect(full.repCount).toBe(0);
  });
});

describe('computeDrillPlan — anchor window', () => {
  it('old outlier reps age out of the anchors (but not the rung stats)', () => {
    const reps = [rep('lw', 'full', 150, 150)]; // early wild swing
    for (let i = 0; i < ANCHOR_WINDOW; i++) {
      reps.push(rep('lw', 'full', 75 + i, 95 + i));
    }
    const plan = computeDrillPlan([wedge('lw', '60°')], reps);
    const full = rungOf(plan, 'lw', 'full');
    // medians over the last 10 only: (79 + 80)/2 and (99 + 100)/2 — the
    // outlier inside the window would have shifted both to 80 / 100
    expect(full.targetAngleDeg).toBeCloseTo(79.5);
    expect(full.targetCarryM).toBeCloseTo(99.5);
    // rung-level dispersion still reflects every rep ever hit
    expect(full.repCount).toBe(ANCHOR_WINDOW + 1);
    expect(full.carry?.n).toBe(ANCHOR_WINDOW + 1);
  });
});

describe('computeDrillPlan — floor override', () => {
  it('echoes and uses a custom floor', () => {
    const plan = computeDrillPlan(
      [wedge('lw', '60°')],
      [
        rep('lw', 'full', 74, 63),
        rep('lw', 'full', 76, 64),
        rep('lw', 'full', 78, 65),
      ],
      30,
    );
    expect(plan.floorM).toBe(30);
    expect(rungOf(plan, 'lw', 'low').targetCarryM).toBeCloseTo(30, 3);
    expect(rungOf(plan, 'lw', 'mid').targetCarryM).toBeCloseTo(47, 3); // (30+64)/2
  });
});
