import { FlightResult } from '@golf/types';

import { ScreenPoint } from './viewport';

/**
 * Behind-the-ball perspective projection — the golf-sim camera. Pure math,
 * unit-tested in Node; SimTracerView just draws the output.
 *
 * World frame (FLIGHT_MODEL.md §1): x downrange (m), y up, z lateral (+right).
 * Pinhole camera behind the tee at eye height:
 *
 *   scale(x) = F / (F + x)                     (F = focal distance, m)
 *   sx = cx + z · k · scale(x)
 *   sy = horizonY + (EYE_M − y) · k · scale(x)
 *
 * As x → ∞ everything converges to (cx, horizonY). The ground shadow is the
 * same projection with y = 0 — it meets the tracer exactly at launch and
 * landing and separates most at the apex, which is what sells the depth.
 */
export const EYE_M = 2.2;
const FOCAL_M = 26;
/** horizon sits this fraction of the way down the viewport */
const HORIZON_FRACTION = 0.34;
/**
 * Lateral gain < 1 tames the fish-eye effect of a wide fairway on a narrow
 * phone screen while keeping left/right curve direction obvious.
 */
const PERSPECTIVE_LATERAL_GAIN = 0.85;

export interface BehindProjection {
  /** SVG path ("M x y L x y …") of the ball flight */
  tracerPath: string;
  /** same flight projected onto the ground plane (y = 0) */
  shadowPath: string;
  landing: ScreenPoint;
  apex: ScreenPoint;
  horizonY: number;
  /** near edge of the grass (screen y of the ground at the tee) */
  groundNearY: number;
  /** perspective ground lines, near → far */
  distanceLines: { y: number; distanceM: number; halfWidth: number }[];
  /** px per meter at the tee plane (for sizing markers) */
  nearScale: number;
}

export interface BehindSize {
  width: number;
  height: number;
}

const pathOf = (points: ScreenPoint[]): string =>
  points.length === 0
    ? ''
    : 'M ' +
      points
        .map(
          (p) =>
            `${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100}`,
        )
        .join(' L ');

export function projectBehind(
  result: FlightResult,
  size: BehindSize,
): BehindProjection {
  const cx = size.width / 2;
  const horizonY = size.height * HORIZON_FRACTION;

  // Solve k so the ground at the tee (x=0, y=0) hits the bottom of the view:
  //   bottom = horizonY + EYE_M · k · scale(0)  with scale(0) = 1
  const groundNearY = size.height * 0.98;
  const k = (groundNearY - horizonY) / EYE_M;

  const scale = (x: number): number => FOCAL_M / (FOCAL_M + Math.max(x, 0));
  const project = (x: number, y: number, z: number): ScreenPoint => ({
    x: cx + z * k * scale(x) * PERSPECTIVE_LATERAL_GAIN,
    y: horizonY + (EYE_M - y) * k * scale(x),
  });

  const tracer = result.path.map((p) => project(p.x, p.y, p.z));
  const shadow = result.path.map((p) => project(p.x, 0, p.z));

  const apexPoint = result.path.reduce(
    (best, p) => (p.y > best.y ? p : best),
    result.path[0] ?? { t: 0, x: 0, y: 0, z: 0 },
  );

  const maxDistance = Math.max(result.totalM, 30);
  const distanceLines: BehindProjection['distanceLines'] = [];
  for (let d = 25; d <= maxDistance + 25; d += 25) {
    distanceLines.push({
      y: project(d, 0, 0).y,
      distanceM: d,
      halfWidth: 30 * k * scale(d), // fixed 60 m-wide fairway band
    });
  }

  return {
    tracerPath: pathOf(tracer),
    shadowPath: pathOf(shadow),
    landing: project(result.landing.x, 0, result.landing.z),
    apex: project(apexPoint.x, apexPoint.y, apexPoint.z),
    horizonY,
    groundNearY,
    distanceLines,
    nearScale: k,
  };
}

/** length of an SVG "M … L …" polyline path in px — drives the draw-on dash */
export function polylineLength(path: string): number {
  const coords = path.replace(/[ML]/g, '').trim().split(/\s+/).map(Number);
  let length = 0;
  for (let i = 2; i + 1 < coords.length; i += 2) {
    length += Math.hypot(
      coords[i] - coords[i - 2],
      coords[i + 1] - coords[i - 1],
    );
  }
  return length;
}
