import { FlightResult } from '@golf/types';
import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Image, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import rangePhoto from './assets/range-photo.jpg';
import { polylineLength, projectBehind } from './lib/project-behind';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** a static arc drawn behind the animated latest shot, in its club's color */
export interface TracerArc {
  /** stable identity (shot id) */
  key: string;
  flight: FlightResult;
  color: string;
  /** faint history styling (same-club ghosts in last-shot mode) */
  ghost?: boolean;
}

interface SimTracerViewProps {
  /** the animated, boldest arc; null renders the empty range (idle state) */
  latest: { flight: FlightResult; color: string } | null;
  /** earlier shots drawn as static arcs, each in its own club color */
  arcs?: TracerArc[];
  width: number;
  height: number;
  /** re-triggers the draw-on animation when it changes (use the shotGuid) */
  animateKey?: string;
}

/**
 * Photo backdrop: Uneekor VIEW range scene (BG4), personal use. The image is
 * shown resizeMode="cover" full-screen; on a portrait phone it fills height
 * exactly, so PHOTO_HORIZON_FRACTION is simply the vertical fraction of the
 * source frame where the fairway's ground plane vanishes (meets the far tree
 * line down the middle). To swap backdrops: replace assets/range-photo.jpg
 * and re-measure that line.
 */
const PHOTO_HORIZON_FRACTION = 0.46;
/** BG4 backdrop native aspect (1920×1080). */
const BACKDROP_ASPECT = 16 / 9;

const TRACER_GLOW = '#ffffff';
const SHADOW = '#182f1b';

/** empty-range projection input when there is no shot yet */
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
 * Golf-sim tracer over a real range photograph: behind-the-ball perspective
 * (lib/project-behind, horizon matched to the photo), the latest arc drawing
 * on over ~1.2 s with a white glow under a colored core so it reads on both
 * sky and grass, its shadow racing the turf, earlier arcs held static behind
 * it — each in its own club's color.
 */
export function SimTracerView({
  latest,
  arcs = [],
  width,
  height,
  animateKey,
}: SimTracerViewProps) {
  const size = useMemo(
    () => ({ width, height, horizonFraction: PHOTO_HORIZON_FRACTION }),
    [width, height],
  );
  const projection = useMemo(
    () => projectBehind(latest?.flight ?? IDLE_SCENE, size),
    [latest, size],
  );
  const staticArcs = useMemo(
    () =>
      arcs.map((arc) => ({
        key: arc.key,
        color: arc.color,
        ghost: arc.ghost ?? false,
        path: projectBehind(arc.flight, size).tracerPath,
      })),
    [arcs, size],
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

  // Fill full height, center horizontally: RN's resizeMode="cover" was
  // left-anchoring the wide backdrop. Size the image to the container height
  // at its native 16:9 aspect and offset so the overflow is split evenly.
  const imageWidth = height * BACKDROP_ASPECT;
  const imageLeft = (width - imageWidth) / 2;

  return (
    <View style={{ height, overflow: 'hidden', width }}>
      <Image
        source={rangePhoto}
        resizeMode="stretch"
        style={{
          position: 'absolute',
          top: 0,
          left: imageLeft,
          width: imageWidth,
          height,
        }}
      />
      {(latest !== null || staticArcs.length > 0) && (
        <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
          {staticArcs.map((arc) => (
            <Path
              key={arc.key}
              d={arc.path}
              fill="none"
              stroke={arc.color}
              strokeWidth={arc.ghost ? 1.5 : 2}
              strokeLinecap="round"
              opacity={arc.ghost ? 0.3 : 0.8}
            />
          ))}
          {latest !== null && (
            <>
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
                stroke={TRACER_GLOW}
                strokeWidth={5}
                strokeLinecap="round"
                opacity={0.55}
                strokeDasharray={`${tracerLength} ${tracerLength}`}
                strokeDashoffset={tracerOffset}
              />
              <AnimatedPath
                d={projection.tracerPath}
                fill="none"
                stroke={latest.color}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeDasharray={`${tracerLength} ${tracerLength}`}
                strokeDashoffset={tracerOffset}
              />
              <AnimatedCircle
                cx={projection.landing.x}
                cy={projection.landing.y}
                r={6}
                fill={TRACER_GLOW}
                opacity={markerOpacity}
              />
              <AnimatedCircle
                cx={projection.landing.x}
                cy={projection.landing.y}
                r={3.5}
                fill={latest.color}
                opacity={markerOpacity}
              />
            </>
          )}
        </Svg>
      )}
    </View>
  );
}
