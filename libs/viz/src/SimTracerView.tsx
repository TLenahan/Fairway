import { FlightResult } from '@golf/types';
import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  Line,
  LinearGradient,
  Path,
  Polygon,
  RadialGradient,
  Rect,
  Stop,
  Text as SvgText,
} from 'react-native-svg';

import {
  polylineLength,
  projectBehind,
  BehindProjection,
} from './lib/project-behind';
import { VizDistanceUnit } from './lib/units';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

interface SimTracerViewProps {
  /** null renders the empty range (idle state, no tracer) */
  result: FlightResult | null;
  /** earlier same-club shots, drawn as faint static arcs */
  ghosts?: FlightResult[];
  width: number;
  height: number;
  /** re-triggers the draw-on animation when it changes (use the shotGuid) */
  animateKey?: string;
  unit?: VizDistanceUnit;
}

const TRACER = '#ffffff';
const SHADOW = '#14301c';
const STRIPE_LIGHT = '#5a9a58';
const STRIPE_DARK = '#4c8a4c';
const YD_PER_M = 1.0936132983377078;

/** empty-range scene depth when there is no shot yet (~250 yd of boards) */
const IDLE_SCENE: FlightResult = {
  path: [],
  carryM: 230,
  totalM: 230,
  apexM: 0,
  descentDeg: 0,
  flightTimeS: 0,
  offlineM: 0,
  landing: { x: 0, z: 0 },
  rolloutM: 0,
  computed: true,
};

/**
 * Golf-sim tracer: behind-the-ball perspective of a driving range — sky with
 * sun and clouds, mountain layers, tree line, mowed stripes converging on the
 * vanishing point, yardage boards — with the flight arc drawn on over ~1.2 s
 * and its shadow racing along the turf. Projection math (and therefore the
 * geometry of everything here) lives in lib/project-behind.
 */
export function SimTracerView({
  result,
  ghosts = [],
  width,
  height,
  animateKey,
  unit = 'yards',
}: SimTracerViewProps) {
  const projection = useMemo(
    () => projectBehind(result ?? IDLE_SCENE, { width, height }),
    [result, width, height],
  );
  const ghostPaths = useMemo(
    () => ghosts.map((g) => projectBehind(g, { width, height }).tracerPath),
    [ghosts, width, height],
  );
  const tracerLength = useMemo(
    () => polylineLength(projection.tracerPath),
    [projection.tracerPath],
  );
  const shadowLength = useMemo(
    () => polylineLength(projection.shadowPath),
    [projection.shadowPath],
  );

  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: 1200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // SVG props animate on the JS thread
    }).start();
  }, [animateKey, progress]);

  const tracerOffset = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [tracerLength, 0],
  });
  const shadowOffset = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [shadowLength, 0],
  });
  const markerOpacity = progress.interpolate({
    inputRange: [0, 0.85, 1],
    outputRange: [0, 0, 1],
  });

  const horizon = projection.horizonY;

  return (
    <View style={{ height, width }}>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#4a90c4" />
            <Stop offset="0.55" stopColor="#8fbcdb" />
            <Stop offset="1" stopColor="#e8f2f7" />
          </LinearGradient>
          <RadialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#fff6d8" stopOpacity="0.95" />
            <Stop offset="0.4" stopColor="#ffefb8" stopOpacity="0.45" />
            <Stop offset="1" stopColor="#ffefb8" stopOpacity="0" />
          </RadialGradient>
          <LinearGradient id="grass" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#6aa668" />
            <Stop offset="0.25" stopColor="#579757" />
            <Stop offset="1" stopColor="#3a7a44" />
          </LinearGradient>
          <LinearGradient id="haze" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#e8f2f7" stopOpacity="0" />
            <Stop offset="1" stopColor="#e8f2f7" stopOpacity="0.8" />
          </LinearGradient>
        </Defs>

        {/* sky, sun, clouds */}
        <Rect x={0} y={0} width={width} height={horizon} fill="url(#sky)" />
        <Circle
          cx={width * 0.78}
          cy={horizon * 0.38}
          r={horizon * 0.9}
          fill="url(#sun)"
        />
        <Cloud x={width * 0.16} y={horizon * 0.32} s={width * 0.045} />
        <Cloud x={width * 0.48} y={horizon * 0.2} s={width * 0.03} />
        <Cloud x={width * 0.66} y={horizon * 0.55} s={width * 0.038} />

        {/* mountains + atmospheric haze */}
        <Polygon
          points={mountainPoints(width, horizon, 0.55, 0)}
          fill="#7d9bb5"
          opacity={0.7}
        />
        <Polygon
          points={mountainPoints(width, horizon, 0.32, 40)}
          fill="#5f8299"
          opacity={0.8}
        />
        <Rect
          x={0}
          y={horizon * 0.55}
          width={width}
          height={horizon * 0.45}
          fill="url(#haze)"
        />

        {/* tree line hugging the horizon */}
        {treeline(width, horizon).map((tree, i) => (
          <Ellipse
            key={i}
            cx={tree.cx}
            cy={tree.cy}
            rx={tree.rx}
            ry={tree.ry}
            fill="#2e5c38"
          />
        ))}
        <Rect x={0} y={horizon - 1.5} width={width} height={4} fill="#2e5c38" />

        {/* turf + mow stripes converging on the vanishing point */}
        <Rect
          x={0}
          y={horizon}
          width={width}
          height={height - horizon}
          fill="url(#grass)"
        />
        {mowStripes(projection).map((stripe, i) => (
          <Polygon
            key={i}
            points={stripe.points}
            fill={stripe.light ? STRIPE_LIGHT : STRIPE_DARK}
            opacity={0.35}
          />
        ))}

        {/* faint cross lines + yardage boards */}
        {projection.distanceLines.map((line) => (
          <Line
            key={line.distanceM}
            x1={width / 2 - line.halfWidth}
            y1={line.y}
            x2={width / 2 + line.halfWidth}
            y2={line.y}
            stroke="#ffffff"
            strokeWidth={0.8}
            opacity={0.22}
          />
        ))}
        {yardageBoards(projection, result ?? IDLE_SCENE, unit).map((board) => (
          <G key={board.label}>
            <Line
              x1={board.x}
              y1={board.baseY}
              x2={board.x}
              y2={board.topY}
              stroke="#e8e4d8"
              strokeWidth={board.w * 0.08}
            />
            <Rect
              x={board.x - board.w / 2}
              y={board.topY - board.h}
              width={board.w}
              height={board.h}
              rx={board.h * 0.18}
              fill="#f5f2e8"
              stroke="#2e5c38"
              strokeWidth={board.h * 0.06}
            />
            <SvgText
              x={board.x}
              y={board.topY - board.h * 0.28}
              fontSize={board.h * 0.62}
              fontWeight="bold"
              fill="#1c3a24"
              textAnchor="middle"
            >
              {board.label}
            </SvgText>
          </G>
        ))}

        {/* hitting mat at the tee */}
        <Rect
          x={width / 2 - projection.lateralScale * 2}
          y={projection.groundNearY - projection.lateralScale * 0.5}
          width={projection.lateralScale * 4}
          height={projection.lateralScale * 0.6}
          rx={3}
          fill="#2c5e36"
          opacity={0.9}
        />

        {/* ghosts, shadow, tracer, landing marker — real shots only */}
        {result !== null && (
          <>
            {ghostPaths.map((path, index) => (
              <Path
                key={index}
                d={path}
                fill="none"
                stroke={TRACER}
                strokeWidth={1.5}
                opacity={0.3}
              />
            ))}
            <AnimatedPath
              d={projection.shadowPath}
              fill="none"
              stroke={SHADOW}
              strokeWidth={2.5}
              opacity={0.28}
              strokeDasharray={`${shadowLength} ${shadowLength}`}
              strokeDashoffset={shadowOffset}
            />
            <AnimatedPath
              d={projection.tracerPath}
              fill="none"
              stroke={TRACER}
              strokeWidth={3}
              strokeLinecap="round"
              strokeDasharray={`${tracerLength} ${tracerLength}`}
              strokeDashoffset={tracerOffset}
            />
            <AnimatedCircle
              cx={projection.landing.x}
              cy={projection.landing.y}
              r={6}
              fill={TRACER}
              opacity={markerOpacity}
            />
            <AnimatedCircle
              cx={projection.landing.x}
              cy={projection.landing.y}
              r={3}
              fill={STRIPE_DARK}
              opacity={markerOpacity}
            />
          </>
        )}
      </Svg>
    </View>
  );
}

function Cloud({ x, y, s }: { x: number; y: number; s: number }) {
  return (
    <G opacity={0.85}>
      <Ellipse cx={x} cy={y} rx={s * 1.6} ry={s * 0.62} fill="#ffffff" />
      <Ellipse
        cx={x - s}
        cy={y + s * 0.22}
        rx={s * 1.1}
        ry={s * 0.5}
        fill="#ffffff"
      />
      <Ellipse
        cx={x + s * 1.1}
        cy={y + s * 0.25}
        rx={s * 1.2}
        ry={s * 0.48}
        fill="#ffffff"
      />
    </G>
  );
}

/** jagged silhouette from the left edge to the right, peaks ∝ `rise`·horizon */
function mountainPoints(
  width: number,
  horizon: number,
  rise: number,
  seedOffset: number,
): string {
  const peaks = 7;
  const points: string[] = [`0,${horizon}`];
  for (let i = 0; i <= peaks; i += 1) {
    const px = (width / peaks) * i + seedOffset;
    // deterministic pseudo-random peak heights (no Math.random — stable frames)
    const wobble = Math.abs(Math.sin(i * 2.7 + seedOffset)) * 0.7 + 0.3;
    points.push(`${px},${horizon - horizon * rise * wobble}`);
  }
  points.push(`${width},${horizon}`);
  return points.join(' ');
}

function treeline(
  width: number,
  horizon: number,
): { cx: number; cy: number; rx: number; ry: number }[] {
  const trees: { cx: number; cy: number; rx: number; ry: number }[] = [];
  const count = 24;
  for (let i = 0; i <= count; i += 1) {
    const wobble = Math.abs(Math.sin(i * 1.93)) * 0.6 + 0.4;
    trees.push({
      cx: (width / count) * i,
      cy: horizon - 2,
      rx: (width / count) * 0.85,
      ry: 5 * wobble + 2.5,
    });
  }
  return trees;
}

interface Stripe {
  points: string;
  light: boolean;
}

/** lengthwise mow lanes: every 12 m of lateral world space, fanning to the VP */
function mowStripes(projection: BehindProjection): Stripe[] {
  const stripes: Stripe[] = [];
  const FAR = 400; // far enough that lane tops sit visually at the horizon
  for (let z = -48; z < 48; z += 12) {
    const nearLeft = projection.groundPoint(0, z);
    const nearRight = projection.groundPoint(0, z + 12);
    const farLeft = projection.groundPoint(FAR, z);
    const farRight = projection.groundPoint(FAR, z + 12);
    stripes.push({
      points: `${nearLeft.x},${projection.groundNearY} ${nearRight.x},${projection.groundNearY} ${farRight.x},${farRight.y} ${farLeft.x},${farLeft.y}`,
      light: (z / 12) % 2 === 0,
    });
  }
  return stripes;
}

interface Board {
  label: string;
  x: number;
  baseY: number;
  topY: number;
  w: number;
  h: number;
}

/** yardage boards every 50 display-units down the left side of the range */
function yardageBoards(
  projection: BehindProjection,
  result: FlightResult,
  unit: VizDistanceUnit,
): Board[] {
  const boards: Board[] = [];
  const maxDisplay =
    (unit === 'yards' ? result.totalM * YD_PER_M : result.totalM) + 60;
  for (let display = 50; display <= maxDisplay; display += 50) {
    const xM = unit === 'yards' ? display / YD_PER_M : display;
    const base = projection.groundPoint(xM, -27);
    const s = projection.scaleAt(xM);
    const w = projection.lateralScale * 9 * s;
    const h = w * 0.42;
    boards.push({
      label: `${display}`,
      x: base.x,
      baseY: base.y,
      topY: base.y - w * 0.5,
      w,
      h,
    });
  }
  return boards;
}
