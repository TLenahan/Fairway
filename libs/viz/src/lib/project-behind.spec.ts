import { FlightResult } from '@golf/types';

import { Dispersion } from '@golf/types';

import { buildMultiGroupGeometry } from './dispersion-geometry';
import { polylineLength, projectBehind } from './project-behind';

const dispersion = (centerX: number, centerZ: number): Dispersion => ({
  centerX,
  centerZ,
  ellipseSemiMajorM: 6,
  ellipseSemiMinorM: 3,
  ellipseAngleDeg: 0,
  biasLateralM: centerZ,
  biasDepthM: 0,
  lateralSpreadM: 3,
  depthSpreadM: 6,
});

describe('buildMultiGroupGeometry', () => {
  it('places each group on a shared viewport, keeping its color', () => {
    const geometry = buildMultiGroupGeometry(
      [
        {
          clubId: 'red',
          color: '#ff0000',
          landings: [
            { x: 150, z: -8 },
            { x: 156, z: -6 },
          ],
          dispersion: dispersion(153, -7),
        },
        {
          clubId: 'yellow',
          color: '#ffff00',
          landings: [
            { x: 148, z: 10 },
            { x: 152, z: 12 },
          ],
          dispersion: dispersion(150, 11),
        },
      ],
      { width: 300, height: 300 },
    );
    expect(geometry.groups).toHaveLength(2);
    expect(geometry.groups[0].color).toBe('#ff0000');
    expect(geometry.groups[1].color).toBe('#ffff00');
    // both groups measured against ONE viewport: the left (red, −z) pattern
    // sits left of the right (yellow, +z) pattern on screen
    expect(geometry.groups[0].center.x).toBeLessThan(
      geometry.groups[1].center.x,
    );
    expect(geometry.groups[0].ellipse).not.toBeNull();
  });

  it('handles empty input', () => {
    const geometry = buildMultiGroupGeometry([], { width: 200, height: 200 });
    expect(geometry.groups).toEqual([]);
  });
});

const flight = (over: Partial<FlightResult> = {}): FlightResult => {
  const path = [];
  for (let i = 0; i <= 10; i += 1) {
    const x = i * 15;
    path.push({
      t: i,
      x,
      y: Math.max(30 - 30 * ((x - 75) / 75) ** 2, 0),
      z: 0,
    });
  }
  return {
    path,
    carryM: 150,
    totalM: 158,
    apexM: 30,
    descentDeg: 44,
    flightTimeS: 10,
    offlineM: 0,
    landing: { x: 150, z: 0 },
    rolloutM: 8,
    computed: true,
    ...over,
  };
};

const SIZE = { width: 400, height: 300 };

const pathPoints = (path: string): { x: number; y: number }[] =>
  path
    .replace(/[ML]/g, '')
    .trim()
    .split(/\s+/)
    .map(Number)
    .reduce<{ x: number; y: number }[]>((acc, value, index, all) => {
      if (index % 2 === 0) acc.push({ x: value, y: all[index + 1] });
      return acc;
    }, []);

describe('projectBehind — sim camera', () => {
  it('starts near the bottom center and converges toward the horizon', () => {
    const projection = projectBehind(flight(), SIZE);
    const tracer = pathPoints(projection.tracerPath);
    expect(tracer[0].x).toBeCloseTo(200, 0); // tee is centered
    expect(tracer[0].y).toBeGreaterThan(projection.horizonY); // below horizon
    // downrange points sit closer to the horizon than the tee does
    const last = tracer[tracer.length - 1];
    expect(Math.abs(last.y - projection.horizonY)).toBeLessThan(
      Math.abs(tracer[0].y - projection.horizonY),
    );
  });

  it('keeps the arc above its own ground shadow, meeting at launch/landing', () => {
    const projection = projectBehind(flight(), SIZE);
    const tracer = pathPoints(projection.tracerPath);
    const shadow = pathPoints(projection.shadowPath);
    expect(tracer).toHaveLength(shadow.length);
    // apex-adjacent sample: tracer clearly above (smaller y than) shadow
    const mid = Math.floor(tracer.length / 2);
    expect(tracer[mid].y).toBeLessThan(shadow[mid].y - 10);
    // endpoints coincide (ball on the ground)
    expect(tracer[0].y).toBeCloseTo(shadow[0].y, 1);
    expect(tracer[tracer.length - 1].y).toBeCloseTo(
      shadow[shadow.length - 1].y,
      1,
    );
  });

  it('a rightward finish lands right of center; left lands left', () => {
    const right = projectBehind(
      flight({
        landing: { x: 150, z: 12 },
        path: flight().path.map((p) => ({ ...p, z: (p.x / 150) ** 2 * 12 })),
      }),
      SIZE,
    );
    expect(right.landing.x).toBeGreaterThan(200);
    const left = projectBehind(
      flight({
        landing: { x: 150, z: -12 },
        path: flight().path.map((p) => ({ ...p, z: -((p.x / 150) ** 2) * 12 })),
      }),
      SIZE,
    );
    expect(left.landing.x).toBeLessThan(200);
  });

  it('lays out distance lines monotonically toward the horizon', () => {
    const projection = projectBehind(flight(), SIZE);
    expect(projection.distanceLines.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < projection.distanceLines.length; i += 1) {
      const nearer = projection.distanceLines[i - 1];
      const farther = projection.distanceLines[i];
      expect(farther.y).toBeLessThan(nearer.y);
      expect(farther.y).toBeGreaterThan(projection.horizonY);
      expect(farther.halfWidth).toBeLessThan(nearer.halfWidth);
    }
  });

  it('measures polyline length for the draw-on dash', () => {
    expect(polylineLength('M 0 0 L 3 4')).toBeCloseTo(5);
    expect(polylineLength('M 0 0 L 3 4 L 3 14')).toBeCloseTo(15);
    expect(polylineLength('')).toBe(0);
  });
});
