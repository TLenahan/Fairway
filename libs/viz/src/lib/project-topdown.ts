import { FlightResult } from '@golf/types';

import {
  boundsOfPoints,
  createViewport,
  mergeBounds,
  toSvgPoints,
  ScreenPoint,
} from './viewport';

/**
 * Plan-view projection (BUILD_SPEC §10.2): screen-x = lateral (world z,
 * + = right), screen-y = downrange (world x) growing UP the screen (tee at
 * the bottom). Aspect is preserved — shape truthfulness is the whole point
 * of this view.
 */
export interface TopDownProjection {
  svgPoints: string;
  landing: ScreenPoint;
  /** target line from the tee to the far edge, down the middle of the pattern */
  targetLine: { from: ScreenPoint; to: ScreenPoint };
  tee: ScreenPoint;
}

export interface TopDownSize {
  width: number;
  height: number;
  padding?: number;
}

export function projectTopDown(
  result: FlightResult,
  size: TopDownSize,
): TopDownProjection {
  // world→view mapping: viewX = lateral z, viewY = downrange x
  const viewPoints = result.path.map((p) => ({ x: p.z, y: p.x }));
  const pathBounds = boundsOfPoints(
    viewPoints.length > 0 ? viewPoints : [{ x: 0, y: 0 }],
  );
  // always include the tee (0,0) and the target line's lateral center 0,
  // padded laterally so a dead-straight shot doesn't collapse to zero width
  const anchored = mergeBounds(pathBounds, {
    minX: -5,
    maxX: 5,
    minY: 0,
    maxY: pathBounds.maxY,
  });
  const viewport = createViewport(anchored, {
    width: size.width,
    height: size.height,
    padding: size.padding ?? 12,
    preserveAspect: true,
  });

  return {
    svgPoints: toSvgPoints(viewPoints.map((p) => viewport.toScreen(p))),
    landing: viewport.toScreen({ x: result.landing.z, y: result.landing.x }),
    targetLine: {
      from: viewport.toScreen({ x: 0, y: 0 }),
      to: viewport.toScreen({ x: 0, y: anchored.maxY }),
    },
    tee: viewport.toScreen({ x: 0, y: 0 }),
  };
}
