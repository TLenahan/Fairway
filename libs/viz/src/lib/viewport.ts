/**
 * Generic world→screen scaling shared by every viz projection.
 *
 * A Viewport fits a world-space bounding box into a width×height screen
 * rectangle with uniform padding. SVG screen space grows downward, so world
 * y is flipped by default (flipY). When preserveAspect is set, both axes use
 * a single uniform scale (required wherever geometric truthfulness matters,
 * e.g. the top-down shape view) and the content is centered in the leftover
 * slack. Degenerate (zero-extent) axes borrow the other axis' scale so a
 * single point still projects to the middle of the viewport.
 *
 * Pure math — no React / react-native imports (unit-tested in Node).
 */

export interface WorldPoint {
  x: number;
  y: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface ViewportOptions {
  width: number;
  height: number;
  /** screen padding (px) applied on all four sides; default 0 */
  padding?: number;
  /** use one uniform scale for both axes; default false */
  preserveAspect?: boolean;
  /** flip world y so +y renders upward in SVG (which grows downward); default true */
  flipY?: boolean;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly padding: number;
  readonly bounds: Bounds;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly flipY: boolean;
  toScreen(point: WorldPoint): ScreenPoint;
  toWorld(point: ScreenPoint): WorldPoint;
}

export function boundsOfPoints(points: readonly WorldPoint[]): Bounds {
  if (points.length === 0) {
    throw new Error('boundsOfPoints requires at least one point');
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

export function mergeBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function createViewport(
  bounds: Bounds,
  options: ViewportOptions,
): Viewport {
  const padding = options.padding ?? 0;
  const flipY = options.flipY ?? true;
  const preserveAspect = options.preserveAspect ?? false;
  // clamp so a tiny viewport with large padding never divides by ≤0
  const innerWidth = Math.max(options.width - 2 * padding, 1);
  const innerHeight = Math.max(options.height - 2 * padding, 1);
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;

  let scaleX = spanX > 0 ? innerWidth / spanX : Number.POSITIVE_INFINITY;
  let scaleY = spanY > 0 ? innerHeight / spanY : Number.POSITIVE_INFINITY;
  if (preserveAspect) {
    const uniform = Math.min(scaleX, scaleY);
    const scale = Number.isFinite(uniform) ? uniform : 1;
    scaleX = scale;
    scaleY = scale;
  } else if (!Number.isFinite(scaleX) && !Number.isFinite(scaleY)) {
    scaleX = 1;
    scaleY = 1;
  } else if (!Number.isFinite(scaleX)) {
    scaleX = scaleY;
  } else if (!Number.isFinite(scaleY)) {
    scaleY = scaleX;
  }

  // Slack (leftover inner space) centers the content: nonzero when the
  // aspect is preserved or an axis is degenerate.
  const slackX = innerWidth - spanX * scaleX;
  const slackY = innerHeight - spanY * scaleY;
  const originX = padding + slackX / 2;
  const topY = padding + slackY / 2;
  const bottomY = options.height - padding - slackY / 2;

  return {
    width: options.width,
    height: options.height,
    padding,
    bounds,
    scaleX,
    scaleY,
    flipY,
    toScreen(point: WorldPoint): ScreenPoint {
      return {
        x: originX + (point.x - bounds.minX) * scaleX,
        y: flipY
          ? bottomY - (point.y - bounds.minY) * scaleY
          : topY + (point.y - bounds.minY) * scaleY,
      };
    },
    toWorld(point: ScreenPoint): WorldPoint {
      return {
        x: bounds.minX + (point.x - originX) / scaleX,
        y: flipY
          ? bounds.minY + (bottomY - point.y) / scaleY
          : bounds.minY + (point.y - topY) / scaleY,
      };
    },
  };
}

/** Serialize screen points for an SVG `points` attribute (2-decimal precision). */
export function toSvgPoints(points: readonly ScreenPoint[]): string {
  return points
    .map((p) => `${Math.round(p.x * 100) / 100},${Math.round(p.y * 100) / 100}`)
    .join(' ');
}
