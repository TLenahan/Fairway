import { FlightResult } from '@golf/types';

import {
  boundsOfPoints,
  createViewport,
  mergeBounds,
  toSvgPoints,
  Bounds,
  ScreenPoint,
} from './viewport';

/**
 * Side-profile projection (BUILD_SPEC §10.2): world x = downrange, world
 * y = height. Multiple shots share ONE scale so ghost overlays compare
 * honestly.
 */
export interface TrajectoryShotProjection {
  svgPoints: string;
  apex: ScreenPoint;
  landing: ScreenPoint;
  result: FlightResult;
}

export interface TrajectoryProjection {
  shots: TrajectoryShotProjection[];
  bounds: Bounds;
  groundY: number;
}

export interface ProjectionSize {
  width: number;
  height: number;
  padding?: number;
}

export function projectTrajectories(
  results: FlightResult[],
  size: ProjectionSize,
): TrajectoryProjection {
  const nonEmpty = results.filter((r) => r.path.length > 0);
  if (nonEmpty.length === 0) {
    return {
      shots: [],
      bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
      groundY: size.height - (size.padding ?? 0),
    };
  }

  const bounds = nonEmpty
    .map((r) => boundsOfPoints(r.path.map((p) => ({ x: p.x, y: p.y }))))
    .reduce(mergeBounds);
  // anchor the ground line at y = 0 even if every sample is airborne
  const grounded: Bounds = { ...bounds, minY: Math.min(bounds.minY, 0) };
  const viewport = createViewport(grounded, {
    width: size.width,
    height: size.height,
    padding: size.padding ?? 12,
  });

  const shots = nonEmpty.map((result) => {
    const screenPoints = result.path.map((p) =>
      viewport.toScreen({ x: p.x, y: p.y }),
    );
    const apexPoint = result.path.reduce((best, p) =>
      p.y > best.y ? p : best,
    );
    return {
      svgPoints: toSvgPoints(screenPoints),
      apex: viewport.toScreen({ x: apexPoint.x, y: apexPoint.y }),
      landing: viewport.toScreen({ x: result.landing.x, y: 0 }),
      result,
    };
  });

  return {
    shots,
    bounds: grounded,
    groundY: viewport.toScreen({ x: 0, y: 0 }).y,
  };
}
