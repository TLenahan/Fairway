import { Baseline, Club } from '@golf/types';

import { computeDispersion } from './dispersion';
import { computeGapping } from './gapping';
import { buildFlight, buildShot } from './shot-builder';
import { summarizeClub, summarizeSession } from './summarize';

const club = (id: string, name: string): Club => ({
  id,
  name,
  category: 'iron',
  sensorMode: 'iron',
  swingTag: 'full',
  loftDeg: 34,
  notes: null,
  archived: false,
  createdAt: 1,
});

describe('summarizeClub — hand-checked stats', () => {
  it('computes mean/median/sd/min/max with measured n', () => {
    const shots = [
      buildShot({ clubId: 'c1', ball: { speedMs: 50 } }),
      buildShot({ clubId: 'c1', ball: { speedMs: 55 } }),
      buildShot({ clubId: 'c1', ball: { speedMs: 60 } }),
    ];
    const summary = summarizeClub(shots);
    const stat = summary.metrics['ballSpeedMs'];
    expect(stat.n).toBe(3);
    expect(stat.mean).toBeCloseTo(55);
    expect(stat.median).toBeCloseTo(55);
    expect(stat.sd).toBeCloseTo(5); // sample sd: sqrt((25+0+25)/2)
    expect(stat.min).toBe(50);
    expect(stat.max).toBe(60);
    expect(summary.shotCount).toBe(3);
  });

  it('honors the null rule: n < shotCount, no fake zeros', () => {
    const shots = [
      buildShot({ clubId: 'c1', club: { faceAngleDeg: 2 } }),
      buildShot({ clubId: 'c1', club: { faceAngleDeg: null } }),
      buildShot({ clubId: 'c1', club: { faceAngleDeg: 4 } }),
    ];
    const summary = summarizeClub(shots);
    expect(summary.shotCount).toBe(3);
    expect(summary.metrics['faceAngleDeg'].n).toBe(2);
    expect(summary.metrics['faceAngleDeg'].mean).toBeCloseTo(3); // (2+4)/2, NOT (2+0+4)/3
  });

  it('treats spinAssurance 0 as unmeasured spin', () => {
    const summary = summarizeClub([
      buildShot({ clubId: 'c1', ball: { spinAssurance: 0 } }),
    ]);
    expect(summary.metrics['backspinRpm']).toBeUndefined();
    expect(summary.metrics['sidespinRpm']).toBeUndefined();
    expect(summary.metrics['ballSpeedMs']).toBeDefined();
  });

  it('excludes discarded shots from everything', () => {
    const shots = [
      buildShot({ clubId: 'c1', ball: { speedMs: 50 } }),
      buildShot({ clubId: 'c1', ball: { speedMs: 99 }, discarded: true }),
    ];
    const summary = summarizeClub(shots);
    expect(summary.shotCount).toBe(1);
    expect(summary.metrics['ballSpeedMs'].max).toBe(50);
  });

  it('computes pathFaceGap only over shots measuring BOTH angles', () => {
    const shots = [
      buildShot({ clubId: 'c1', club: { faceAngleDeg: 3, pathDeg: -1 } }),
      buildShot({ clubId: 'c1', club: { faceAngleDeg: null, pathDeg: -9 } }),
    ];
    // only the first pair counts: 3 − (−1) = 4
    expect(summarizeClub(shots).pathFaceGapDeg).toBeCloseTo(4);
  });

  it('computes baselineGap only from supplied cited baselines', () => {
    const baseline: Baseline = {
      category: 'iron',
      level: 'tour',
      source: { citation: 'TrackMan Tour Averages', url: null },
      metrics: { ballSpeedMs: 60, carryM: 172 },
    };
    const summary = summarizeClub(
      [buildShot({ clubId: 'c1', ball: { speedMs: 55 }, flight: null })],
      { baseline },
    );
    expect(summary.baselineGap?.perMetricDelta['ballSpeedMs']).toBeCloseTo(-5);
    // no carry data measured → no delta claimed for carryM
    expect(summary.baselineGap?.perMetricDelta['carryM']).toBeUndefined();
    expect(summarizeClub([buildShot({})]).baselineGap).toBeNull();
  });
});

describe('computeDispersion — known patterns', () => {
  it('symmetric rectangle: axis-aligned ellipse, zero bias', () => {
    const d = computeDispersion([
      { x: 140, z: -4 },
      { x: 140, z: 4 },
      { x: 160, z: -4 },
      { x: 160, z: 4 },
    ]);
    expect(d.centerX).toBeCloseTo(150);
    expect(d.centerZ).toBeCloseTo(0);
    expect(d.depthSpreadM).toBeCloseTo(11.547, 3); // sqrt(400/3)
    expect(d.lateralSpreadM).toBeCloseTo(4.6188, 3); // sqrt(64/3)
    expect(d.ellipseSemiMajorM).toBeCloseTo(11.547, 3);
    expect(d.ellipseSemiMinorM).toBeCloseTo(4.6188, 3);
    expect(d.ellipseAngleDeg).toBeCloseTo(0);
    expect(d.biasLateralM).toBeCloseTo(0);
    expect(d.biasDepthM).toBeCloseTo(0);
  });

  it('45° line: tilted degenerate ellipse', () => {
    const d = computeDispersion([
      { x: 100, z: -10 },
      { x: 110, z: 0 },
      { x: 120, z: 10 },
    ]);
    expect(d.ellipseAngleDeg).toBeCloseTo(45);
    expect(d.ellipseSemiMajorM).toBeCloseTo(Math.sqrt(200), 3);
    expect(d.ellipseSemiMinorM).toBeCloseTo(0, 6);
  });

  it('right-bias pattern reports lateral bias', () => {
    const d = computeDispersion([
      { x: 150, z: 6 },
      { x: 155, z: 10 },
    ]);
    expect(d.biasLateralM).toBeCloseTo(8);
  });

  it('degenerate inputs claim nothing', () => {
    expect(computeDispersion([]).lateralSpreadM).toBe(0);
    const single = computeDispersion([{ x: 150, z: 3 }]);
    expect(single.centerX).toBe(150);
    expect(single.biasLateralM).toBe(3);
    expect(single.depthSpreadM).toBe(0);
    expect(single.ellipseSemiMajorM).toBe(0);
  });
});

describe('summarizeSession + gapping', () => {
  it('groups by club, resolves names, builds the carry ladder', () => {
    const shots = [
      buildShot({
        sessionId: 's1',
        clubId: 'driver',
        flight: buildFlight({ carryM: 230, landing: { x: 230, z: 0 } }),
      }),
      buildShot({
        sessionId: 's1',
        clubId: 'seven',
        flight: buildFlight({ carryM: 180, landing: { x: 180, z: 0 } }),
      }),
      buildShot({
        sessionId: 's1',
        clubId: 'eight',
        flight: buildFlight({ carryM: 176, landing: { x: 176, z: 0 } }),
      }),
      buildShot({ sessionId: 's1', clubId: 'putter', flight: null }),
      buildShot({ sessionId: 's1', clubId: 'seven', discarded: true }),
    ];
    const env = { altitudeM: 1849, temperatureC: null, presetName: null };
    const summary = summarizeSession(shots, env, [
      club('driver', 'Driver'),
      club('seven', '7 Iron'),
      club('eight', '8 Iron'),
      club('putter', 'Putter'),
    ]);

    expect(summary.sessionId).toBe('s1');
    expect(summary.shotCount).toBe(4); // discarded excluded
    expect(summary.clubs.map((c) => c.clubName)).toEqual(
      expect.arrayContaining(['Driver', '7 Iron', '8 Iron', 'Putter']),
    );
    expect(summary.environment).toEqual(env);

    // ladder: putter (no carry) excluded; ordered desc; 4 m gap flags overlap
    expect(summary.gapping.map((g) => g.clubName)).toEqual([
      'Driver',
      '7 Iron',
      '8 Iron',
    ]);
    expect(summary.gapping[0].gapToNextM).toBeCloseTo(50);
    expect(summary.gapping[0].overlap).toBe(false);
    expect(summary.gapping[1].gapToNextM).toBeCloseTo(4);
    expect(summary.gapping[1].overlap).toBe(true);
    expect(summary.gapping[2].gapToNextM).toBeNull();
    expect(summary.gapping[2].overlap).toBe(false);
  });

  it('falls back to clubId when no club list is supplied', () => {
    const summary = summarizeSession([buildShot({ clubId: 'mystery' })], {
      altitudeM: 0,
      temperatureC: null,
      presetName: null,
    });
    expect(summary.clubs[0].clubName).toBe('mystery');
  });

  it('computeGapping alone handles an empty bag', () => {
    expect(computeGapping([])).toEqual([]);
  });
});
