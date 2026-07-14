import { Dispersion } from '@golf/types';

import { createViewport, ScreenPoint, Bounds } from './viewport';

/**
 * Grouping-view geometry (BUILD_SPEC §10.2): landing points scattered in the
 * plan view (screen-x = lateral z, screen-y = downrange x growing up), the
 * analytics 1σ dispersion ellipse mapped to screen space, and outlier
 * flagging.
 */
export interface LandingMark {
  screen: ScreenPoint;
  outlier: boolean;
  landing: { x: number; z: number };
}

export interface DispersionEllipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** SVG rotation (degrees, clockwise in screen space) around (cx, cy) */
  rotationDeg: number;
}

export interface GroupingGeometry {
  marks: LandingMark[];
  center: ScreenPoint;
  ellipse: DispersionEllipse | null;
  targetLineX: number;
}

/** Points beyond this many σ (normalized ellipse radii) flag as outliers. */
export const OUTLIER_SIGMA = 2.5;

/**
 * Normalized (Mahalanobis-style) distance of a landing point from the
 * pattern center, in units of the 1σ ellipse. Falls back to axis spreads
 * when the ellipse is degenerate; a pattern with no spread flags nothing.
 */
export function normalizedDistance(
  landing: { x: number; z: number },
  dispersion: Dispersion,
): number {
  const angleRad = (dispersion.ellipseAngleDeg * Math.PI) / 180;
  // translate to center, rotate into the ellipse frame (x = downrange)
  const dx = landing.x - dispersion.centerX;
  const dz = landing.z - dispersion.centerZ;
  const major = dx * Math.cos(angleRad) + dz * Math.sin(angleRad);
  const minor = -dx * Math.sin(angleRad) + dz * Math.cos(angleRad);
  const semiMajor =
    dispersion.ellipseSemiMajorM > 0
      ? dispersion.ellipseSemiMajorM
      : Math.max(dispersion.depthSpreadM, dispersion.lateralSpreadM);
  const semiMinor =
    dispersion.ellipseSemiMinorM > 0 ? dispersion.ellipseSemiMinorM : semiMajor;
  if (semiMajor <= 0) return 0;
  return Math.hypot(
    major / semiMajor,
    minor / (semiMinor > 0 ? semiMinor : semiMajor),
  );
}

export interface GroupingSize {
  width: number;
  height: number;
  padding?: number;
}

export function buildGroupingGeometry(
  landings: { x: number; z: number }[],
  dispersion: Dispersion,
  size: GroupingSize,
): GroupingGeometry {
  const fallback: Bounds = { minX: -10, maxX: 10, minY: 0, maxY: 10 };
  const bounds: Bounds =
    landings.length === 0
      ? fallback
      : landings.reduce(
          (b, p) => ({
            minX: Math.min(b.minX, p.z),
            maxX: Math.max(b.maxX, p.z),
            minY: Math.min(b.minY, p.x),
            maxY: Math.max(b.maxY, p.x),
          }),
          {
            minX: -5,
            maxX: 5,
            minY: Number.POSITIVE_INFINITY,
            maxY: Number.NEGATIVE_INFINITY,
          },
        );

  const viewport = createViewport(bounds, {
    width: size.width,
    height: size.height,
    padding: size.padding ?? 16,
    preserveAspect: true,
  });
  const toScreen = (p: { x: number; z: number }): ScreenPoint =>
    viewport.toScreen({ x: p.z, y: p.x });

  const marks = landings.map((landing) => ({
    screen: toScreen(landing),
    outlier: normalizedDistance(landing, dispersion) > OUTLIER_SIGMA,
    landing,
  }));

  const center = toScreen({ x: dispersion.centerX, z: dispersion.centerZ });
  const hasEllipse = landings.length >= 2 && dispersion.ellipseSemiMajorM > 0;

  return {
    marks,
    center,
    // world-frame major axis is along downrange-rotated-by-angle; in screen
    // space downrange points up, so the rotation maps to (90° − angle)
    // clockwise from the screen-x axis.
    ellipse: hasEllipse
      ? {
          cx: center.x,
          cy: center.y,
          rx: dispersion.ellipseSemiMajorM * viewport.scaleX,
          ry: Math.max(dispersion.ellipseSemiMinorM * viewport.scaleY, 0.5),
          rotationDeg: 90 - dispersion.ellipseAngleDeg,
        }
      : null,
    targetLineX: toScreen({ x: dispersion.centerX, z: 0 }).x,
  };
}
