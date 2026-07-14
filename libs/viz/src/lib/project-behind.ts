import { FlightResult } from '@golf/types';

import { ScreenPoint } from './viewport';

/**
 * Behind-the-ball perspective projection — the golf-sim camera. Pure math,
 * unit-tested in Node; SimTracerView just draws the output.
 *
 * World frame (FLIGHT_MODEL.md §1): x downrange (m), y up, z lateral (+right).
 * Pinhole camera behind the tee at eye height, with SEPARATE vertical and
 * lateral pixel scales (an anamorphic camera):
 *
 *   scale(x) = F / (F + x)                     (F = focal distance, m)
 *   sx = cx + z · kx · scale(x)
 *   sy = horizonY + (EYE_M · ky − y · kh) · scale(x)
 *
 * ky is solved so eye height spans horizon→bottom (the ground fills the
 * lower view). Reusing ky laterally on a portrait phone would put ±34 m of
 * range ~10× off-screen, so kx is solved independently: the fairway width
 * (±FAIRWAY_HALF_M) fits the viewport at the LATERAL_REF_M plane. Ball
 * height is compressed the same way: ky is sized for 2.2 m of eye height and
 * would send a 30 m iron apex several screens off the top, so kh is solved
 * so the reference apex (APEX_REF_M high at APEX_REF_X_M downrange — about
 * the highest, closest peak a real club produces) crests APEX_TOP_FRACTION
 * of the viewport from the top edge. As x → ∞ everything still converges to
 * (cx, horizonY); the ground shadow is the same projection with y = 0.
 */
export const EYE_M = 2.2;
const FOCAL_M = 26;
/** horizon sits this fraction of the way down the viewport */
const HORIZON_FRACTION = 0.34;
/** half the visible range width (m) — stripes/boards live inside this */
const FAIRWAY_HALF_M = 34;
/** downrange plane (m) where the full fairway width exactly fits the screen */
const LATERAL_REF_M = 55;
/** reference apex that pins the height scale: this high (m)… */
const APEX_REF_M = 50;
/**
 * …at this downrange plane (m). The reference is the highest-projecting
 * flight in the real calibration suite (flight-model/calibration.spec.ts):
 * a towering 9-iron, 49.5 m apex at 97 m downrange. Wedges apex lower and
 * long irons peak farther out, so every club clears the top edge.
 */
const APEX_REF_X_M = 95;
/** the reference apex crests this fraction of the viewport from the top */
const APEX_TOP_FRACTION = 0.03;

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
  /** vertical px per meter at the tee plane */
  nearScale: number;
  /** lateral px per meter at the tee plane (anamorphic — see module docs) */
  lateralScale: number;
  /** project any ground-plane point (scene furniture: boards, stripes) */
  groundPoint(xM: number, zM: number): ScreenPoint;
  /** perspective shrink factor at downrange xM (1 at the tee → 0 at horizon) */
  scaleAt(xM: number): number;
}

export interface BehindSize {
  width: number;
  height: number;
  /** where the horizon sits (fraction of height) — match the backdrop photo */
  horizonFraction?: number;
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
  const horizonY = size.height * (size.horizonFraction ?? HORIZON_FRACTION);

  // Solve ky so the ground at the tee (x=0, y=0) hits the bottom of the view:
  //   bottom = horizonY + EYE_M · ky · scale(0)  with scale(0) = 1
  const groundNearY = size.height * 0.98;
  const k = (groundNearY - horizonY) / EYE_M;

  const scale = (x: number): number => FOCAL_M / (FOCAL_M + Math.max(x, 0));
  // Solve kx so ±FAIRWAY_HALF_M fills the width at the LATERAL_REF_M plane
  const kx = (0.94 * cx) / (FAIRWAY_HALF_M * scale(LATERAL_REF_M));
  // Solve kh so the reference apex crests just under the top edge — ground
  // geometry (y = 0) is untouched, only height above it is compressed
  const apexScale = scale(APEX_REF_X_M);
  const kh =
    (horizonY + EYE_M * k * apexScale - size.height * APEX_TOP_FRACTION) /
    (APEX_REF_M * apexScale);
  const project = (x: number, y: number, z: number): ScreenPoint => ({
    x: cx + z * kx * scale(x),
    y: horizonY + (EYE_M * k - y * kh) * scale(x),
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
      halfWidth: 30 * kx * scale(d), // fixed 60 m-wide fairway band
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
    lateralScale: kx,
    groundPoint: (xM, zM) => project(xM, 0, zM),
    scaleAt: scale,
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
