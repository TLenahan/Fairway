import {
  DRILL_FLOOR_CARRY_M,
  MIN_RUNG_GAP_M,
  PARTIAL_MAX_FRACTION,
} from './constants';
import { buildCarryLadder, WedgeFullAnchor } from './ladder';

const anchor = (clubId: string, fullCarryM: number): WedgeFullAnchor => ({
  clubId,
  fullCarryM,
});

describe('buildCarryLadder — realistic 3-wedge bag (PW/56/60-ish)', () => {
  // grid of 9 over [18.288, 100.6]: step = 82.312 / 8 = 10.289 exactly
  const fulls = [anchor('pw', 100.6), anchor('sw', 77.7), anchor('lw', 64.0)];
  const ladder = buildCarryLadder(fulls);

  it('gives the loftiest wedge the shortest partials, down to the floor', () => {
    const lw = ladder.get('lw');
    expect(lw?.lowM).toBeCloseTo(18.288, 3); // g0 — the 20 yd floor itself
    expect(lw?.midM).toBeCloseTo(28.577, 3); // g1
  });

  it('mid wedge fills the middle of the span', () => {
    const sw = ladder.get('sw');
    expect(sw?.lowM).toBeCloseTo(38.866, 3); // g2
    expect(sw?.midM).toBeCloseTo(49.155, 3); // g3
  });

  it('longest wedge covers the top (fulls claimed g4, g6, g8)', () => {
    const pw = ladder.get('pw');
    expect(pw?.lowM).toBeCloseTo(69.733, 3); // g5
    expect(pw?.midM).toBeCloseTo(90.311, 3); // g7
  });

  it('all 9 rungs ascend and cover floor→max', () => {
    const rungs = fulls
      .flatMap((f) => {
        const p = ladder.get(f.clubId);
        return p === undefined ? [] : [p.lowM, p.midM, f.fullCarryM];
      })
      .sort((a, b) => a - b);
    expect(rungs).toHaveLength(9);
    expect(rungs[0]).toBeCloseTo(DRILL_FLOOR_CARRY_M, 3);
    expect(rungs[8]).toBeCloseTo(100.6, 3);
    for (let i = 1; i < rungs.length; i++) {
      expect(rungs[i]).toBeGreaterThan(rungs[i - 1]);
    }
  });

  it('respects the per-wedge clamps: low < mid ≤ 92% of full', () => {
    for (const f of fulls) {
      const p = ladder.get(f.clubId);
      expect(p).toBeDefined();
      if (p === undefined) continue;
      expect(p.midM).toBeLessThanOrEqual(PARTIAL_MAX_FRACTION * f.fullCarryM);
      expect(p.lowM).toBeLessThanOrEqual(p.midM - MIN_RUNG_GAP_M);
    }
  });
});

describe('buildCarryLadder — small bags', () => {
  it('n = 1: grid of 3 over [floor, full]', () => {
    const ladder = buildCarryLadder([anchor('lw', 64)]);
    const lw = ladder.get('lw');
    expect(lw?.lowM).toBeCloseTo(18.288, 3);
    expect(lw?.midM).toBeCloseTo((18.288 + 64) / 2, 3); // 41.144
  });

  it('n = 2: grid of 6, fulls claim their nearest slots', () => {
    // step = 82.312 / 5 = 16.4624; 100.6 claims g5, 64 claims g3 (67.6752)
    const ladder = buildCarryLadder([anchor('pw', 100.6), anchor('lw', 64)]);
    expect(ladder.get('lw')?.lowM).toBeCloseTo(18.288, 3); // g0
    expect(ladder.get('lw')?.midM).toBeCloseTo(34.7504, 3); // g1
    expect(ladder.get('pw')?.lowM).toBeCloseTo(51.2128, 3); // g2
    expect(ladder.get('pw')?.midM).toBeCloseTo(84.1376, 3); // g4
  });

  it('honors a custom floor', () => {
    const ladder = buildCarryLadder([anchor('lw', 60)], 30);
    expect(ladder.get('lw')?.lowM).toBeCloseTo(30, 3);
    expect(ladder.get('lw')?.midM).toBeCloseTo(45, 3);
  });

  it('returns an empty map for no anchors', () => {
    expect(buildCarryLadder([]).size).toBe(0);
  });
});

describe('buildCarryLadder — clustered and degenerate inputs', () => {
  it('clustered fulls: partials still spread over the whole span', () => {
    // 80/78/76: step = 61.712 / 8 = 7.714; fulls claim g8, g7, g6
    const ladder = buildCarryLadder([
      anchor('a', 80),
      anchor('b', 78),
      anchor('c', 76),
    ]);
    expect(ladder.get('c')?.lowM).toBeCloseTo(18.288, 3); // g0
    expect(ladder.get('c')?.midM).toBeCloseTo(26.002, 3); // g1
    expect(ladder.get('b')?.lowM).toBeCloseTo(33.716, 3); // g2
    expect(ladder.get('b')?.midM).toBeCloseTo(41.43, 3); // g3
    expect(ladder.get('a')?.lowM).toBeCloseTo(49.144, 3); // g4
    expect(ladder.get('a')?.midM).toBeCloseTo(56.858, 3); // g5
  });

  it('clamps engage when the grid crowds a short full', () => {
    // full 20, floor 18.288: raw mid g1 = 19.144 > 0.92·20 = 18.4 → clamped;
    // low then drops MIN_RUNG_GAP_M under the clamped mid, below the floor —
    // feasibility beats floor coverage.
    const ladder = buildCarryLadder([anchor('lw', 20)]);
    expect(ladder.get('lw')?.midM).toBeCloseTo(18.4, 3);
    expect(ladder.get('lw')?.lowM).toBeCloseTo(18.4 - MIN_RUNG_GAP_M, 3);
  });

  it('degenerate F0 ≤ floor: pure per-wedge fractions', () => {
    const ladder = buildCarryLadder([anchor('a', 15), anchor('b', 12)]);
    expect(ladder.get('a')?.midM).toBeCloseTo(13.8, 3); // 0.92 × 15
    expect(ladder.get('a')?.lowM).toBeCloseTo(13.8 - MIN_RUNG_GAP_M, 3);
    expect(ladder.get('b')?.midM).toBeCloseTo(11.04, 3); // 0.92 × 12
    expect(ladder.get('b')?.lowM).toBeCloseTo(11.04 - MIN_RUNG_GAP_M, 3);
  });
});
