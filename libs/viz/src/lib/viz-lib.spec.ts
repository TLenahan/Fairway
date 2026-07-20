import { Dispersion, FlightResult } from '@golf/types';

import {
  buildGroupingGeometry,
  normalizedDistance,
} from './dispersion-geometry';
import { buildGappingRows } from './gapping-layout';
import { projectTopDown } from './project-topdown';
import { projectTrajectories } from './project-trajectory';
import { classifyShotShape } from './shot-shape';
import { formatDistanceLabel, metersToYards, msToMph } from './units';
import { boundsOfPoints, createViewport } from './viewport';

/** synthetic flight: parabolic arc, optional lateral drift */
const flight = (over: Partial<FlightResult> = {}): FlightResult => {
  const path = [];
  for (let t = 0; t <= 10; t += 1) {
    const x = t * 15;
    path.push({
      t,
      x,
      y: 30 - 0.3 * (x - 75) ** 2 * (30 / 75 ** 2) * 2.5,
      z: 0,
    });
  }
  // simple clean parabola: y = 30 - 30*((x-75)/75)^2, zero at x=0 and 150
  const clean = path.map((p) => ({
    ...p,
    y: Math.max(30 - 30 * ((p.x - 75) / 75) ** 2, 0),
  }));
  return {
    path: clean,
    carryM: 150,
    totalM: 158,
    apexM: 30,
    descentDeg: 44,
    flightTimeS: 10,
    offlineM: 0,
    curveM: 0,
    landing: { x: 150, z: 0 },
    rolloutM: 8,
    computed: true,
    ...over,
  };
};

describe('viewport', () => {
  it('round-trips world↔screen and flips y for SVG', () => {
    const bounds = boundsOfPoints([
      { x: 0, y: 0 },
      { x: 100, y: 50 },
    ]);
    const viewport = createViewport(bounds, {
      width: 220,
      height: 120,
      padding: 10,
    });
    const origin = viewport.toScreen({ x: 0, y: 0 });
    const top = viewport.toScreen({ x: 100, y: 50 });
    expect(origin.y).toBeGreaterThan(top.y); // y flipped: higher world = smaller screen y
    expect(origin.x).toBeLessThan(top.x);
    const back = viewport.toWorld(viewport.toScreen({ x: 42, y: 13 }));
    expect(back.x).toBeCloseTo(42, 6);
    expect(back.y).toBeCloseTo(13, 6);
  });

  it('preserveAspect uses one uniform scale', () => {
    const viewport = createViewport(
      { minX: 0, maxX: 100, minY: 0, maxY: 10 },
      { width: 200, height: 200, preserveAspect: true },
    );
    expect(viewport.scaleX).toBeCloseTo(viewport.scaleY, 9);
  });
});

describe('projectTrajectories', () => {
  it('projects the parabola with shared scale, apex and grounded landing', () => {
    const short = flight({
      carryM: 100,
      landing: { x: 100, z: 0 },
      path: flight().path.map((p) => ({ ...p, x: p.x * (100 / 150) })),
    });
    const projection = projectTrajectories([short, flight()], {
      width: 300,
      height: 150,
      padding: 10,
    });
    expect(projection.shots).toHaveLength(2);
    // shared scale: the longer shot's landing is further right
    expect(projection.shots[1].landing.x).toBeGreaterThan(
      projection.shots[0].landing.x,
    );
    // landing sits on the ground line
    expect(projection.shots[1].landing.y).toBeCloseTo(projection.groundY, 6);
    // apex is the highest (smallest screen y) point
    expect(projection.shots[1].apex.y).toBeLessThan(projection.groundY);
  });

  it('handles empty input', () => {
    const projection = projectTrajectories([], { width: 100, height: 50 });
    expect(projection.shots).toEqual([]);
  });
});

describe('projectTopDown', () => {
  it('keeps a straight shot on the target line, tee at the bottom', () => {
    const projection = projectTopDown(flight(), { width: 200, height: 300 });
    expect(projection.landing.x).toBeCloseTo(projection.targetLine.from.x, 4);
    // tee (downrange 0) renders below the landing (downrange 150)
    expect(projection.tee.y).toBeGreaterThan(projection.landing.y);
  });

  it('puts a rightward finish right of the target line', () => {
    const curved = flight({
      offlineM: 12,
      landing: { x: 150, z: 12 },
      path: flight().path.map((p) => ({ ...p, z: (p.x / 150) ** 2 * 12 })),
    });
    const projection = projectTopDown(curved, { width: 200, height: 300 });
    expect(projection.landing.x).toBeGreaterThan(projection.targetLine.from.x);
  });
});

describe('classifyShotShape', () => {
  // curveM as simulate() computes it: perpendicular deviation from the HLA ray
  const shape = (offlineM: number, hla: number, carryM = 150) => {
    const hlaRad = (hla * Math.PI) / 180;
    return classifyShotShape(
      flight({
        offlineM,
        carryM,
        curveM: offlineM * Math.cos(hlaRad) - carryM * Math.sin(hlaRad),
        landing: { x: carryM, z: offlineM },
      }),
      { launchDirectionDeg: hla },
    );
  };

  it('classifies the seven shapes', () => {
    expect(shape(0, 0)).toBe('straight');
    expect(shape(8, 0)).toBe('fade'); // starts straight, curves right
    expect(shape(20, 0)).toBe('slice');
    expect(shape(-8, 0)).toBe('draw');
    expect(shape(-20, 0)).toBe('hook');
    expect(shape(-13, -5)).toBe('pull'); // straight-line left finish, no curve
    expect(shape(13, 5)).toBe('push');
  });

  it('a fade that starts left still reads as a fade', () => {
    // HLA -3° projects ≈ -7.9 m; finishing at +2 m means ~+10 m of curve
    expect(shape(2, -3)).toBe('fade');
  });
});

describe('dispersion geometry', () => {
  const dispersion: Dispersion = {
    centerX: 150,
    centerZ: 0,
    ellipseSemiMajorM: 10,
    ellipseSemiMinorM: 4,
    ellipseAngleDeg: 0, // major axis along downrange
    biasLateralM: 0,
    biasDepthM: 0,
    lateralSpreadM: 4,
    depthSpreadM: 10,
  };

  it('normalizes distance in ellipse units', () => {
    expect(normalizedDistance({ x: 160, z: 0 }, dispersion)).toBeCloseTo(1); // 1σ deep
    expect(normalizedDistance({ x: 150, z: 4 }, dispersion)).toBeCloseTo(1); // 1σ lateral
    expect(normalizedDistance({ x: 150, z: 12 }, dispersion)).toBeCloseTo(3);
  });

  it('flags only >2.5σ points as outliers', () => {
    const geometry = buildGroupingGeometry(
      [
        { x: 150, z: 0 },
        { x: 158, z: 0 }, // 0.8σ
        { x: 150, z: 11 }, // 2.75σ lateral → outlier
      ],
      dispersion,
      { width: 200, height: 300 },
    );
    expect(geometry.marks.map((m) => m.outlier)).toEqual([false, false, true]);
    expect(geometry.ellipse).not.toBeNull();
  });

  it('claims no ellipse for a single landing', () => {
    const single = buildGroupingGeometry(
      [{ x: 150, z: 0 }],
      { ...dispersion, ellipseSemiMajorM: 0, ellipseSemiMinorM: 0 },
      { width: 200, height: 300 },
    );
    expect(single.ellipse).toBeNull();
    expect(single.marks[0].outlier).toBe(false);
  });
});

describe('gapping layout', () => {
  it('scales bars and flags overlaps + oversized gaps', () => {
    const rows = buildGappingRows([
      {
        clubId: 'd',
        clubName: 'Driver',
        carryMeanM: 230,
        gapToNextM: 60,
        overlap: false,
      },
      {
        clubId: '3w',
        clubName: '3 Wood',
        carryMeanM: 170,
        gapToNextM: 4,
        overlap: true,
      },
      {
        clubId: '7i',
        clubName: '7 Iron',
        carryMeanM: 166,
        gapToNextM: null,
        overlap: false,
      },
    ]);
    expect(rows[0].barFraction).toBe(1);
    expect(rows[2].barFraction).toBeCloseTo(166 / 230);
    expect(rows[0].oversizedGap).toBe(true); // 60 m hole
    expect(rows[1].overlap).toBe(true);
    expect(rows[2].oversizedGap).toBe(false);
  });
});

describe('units (display only)', () => {
  it('converts and formats', () => {
    expect(metersToYards(100)).toBeCloseTo(109.361, 3);
    expect(msToMph(26.092)).toBeCloseTo(58.37, 2);
    expect(formatDistanceLabel(150, 'yards')).toBe('164 yd');
    expect(formatDistanceLabel(150, 'meters')).toBe('150 m');
  });
});
