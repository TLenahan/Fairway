import { FlightResult } from '@golf/types';
import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  Rect,
  Stop,
  Text as SvgText,
} from 'react-native-svg';

import { polylineLength, projectBehind } from './lib/project-behind';
import { metersToYards, VizDistanceUnit } from './lib/units';

const AnimatedPath = Animated.createAnimatedComponent(Path);

interface SimTracerViewProps {
  result: FlightResult;
  /** earlier same-club shots, drawn as faint static arcs */
  ghosts?: FlightResult[];
  width: number;
  height: number;
  /** re-triggers the draw-on animation when it changes (use the shotGuid) */
  animateKey?: string;
  unit?: VizDistanceUnit;
}

const SKY_TOP = '#8fbcdb';
const SKY_HORIZON = '#dcebf5';
const GRASS_FAR = '#77a86b';
const GRASS_NEAR = '#3e7d46';
const TRACER = '#ffffff';
const SHADOW = '#1c3a24';

/**
 * Golf-sim tracer: behind-the-ball perspective with sky, fairway, distance
 * lines, the flight arc drawn on over ~1.2 s, and its shadow racing along
 * the ground beneath it. Projection math lives in lib/project-behind.
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
    () => projectBehind(result, { width, height }),
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

  // draw-on: dashoffset animates length → 0; shadow runs in lockstep
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

  const formatLine = (m: number): string =>
    unit === 'yards' ? `${Math.round(metersToYards(m))}` : `${Math.round(m)}`;

  return (
    <View style={{ height, width }}>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={SKY_TOP} />
            <Stop offset="1" stopColor={SKY_HORIZON} />
          </LinearGradient>
          <LinearGradient id="grass" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={GRASS_FAR} />
            <Stop offset="1" stopColor={GRASS_NEAR} />
          </LinearGradient>
        </Defs>

        {/* backdrop */}
        <Rect
          x={0}
          y={0}
          width={width}
          height={projection.horizonY}
          fill="url(#sky)"
        />
        <Rect
          x={0}
          y={projection.horizonY}
          width={width}
          height={height - projection.horizonY}
          fill="url(#grass)"
        />
        <Line
          x1={0}
          y1={projection.horizonY}
          x2={width}
          y2={projection.horizonY}
          stroke="#c8d8c2"
          strokeWidth={1}
        />

        {/* perspective distance lines + labels */}
        {projection.distanceLines.map((line) => (
          <Line
            key={line.distanceM}
            x1={width / 2 - line.halfWidth}
            y1={line.y}
            x2={width / 2 + line.halfWidth}
            y2={line.y}
            stroke="#ffffff"
            strokeWidth={1}
            opacity={0.35}
          />
        ))}
        {projection.distanceLines
          .filter((line) => line.distanceM % 50 === 0)
          .map((line) => (
            <SvgText
              key={`label-${line.distanceM}`}
              x={width / 2 + line.halfWidth + 4}
              y={line.y + 3}
              fontSize={9}
              fill="#ffffff"
              opacity={0.7}
            >
              {formatLine(line.distanceM)}
            </SvgText>
          ))}

        {/* ghosts (previous same-club shots) */}
        {ghostPaths.map((path, index) => (
          <Path
            key={index}
            d={path}
            fill="none"
            stroke={TRACER}
            strokeWidth={1.5}
            opacity={0.28}
          />
        ))}

        {/* ground shadow, then the tracer above it */}
        <AnimatedPath
          d={projection.shadowPath}
          fill="none"
          stroke={SHADOW}
          strokeWidth={2.5}
          opacity={0.3}
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

        {/* landing marker fades in as the tracer arrives */}
        <AnimatedCircleGroup
          x={projection.landing.x}
          y={projection.landing.y}
          opacity={markerOpacity}
        />
      </Svg>
    </View>
  );
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

function AnimatedCircleGroup({
  x,
  y,
  opacity,
}: {
  x: number;
  y: number;
  opacity: Animated.AnimatedInterpolation<number>;
}) {
  return (
    <>
      <AnimatedCircle cx={x} cy={y} r={6} fill={TRACER} opacity={opacity} />
      <AnimatedCircle cx={x} cy={y} r={3} fill={GRASS_NEAR} opacity={opacity} />
    </>
  );
}
