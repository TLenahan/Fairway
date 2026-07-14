import { Dispersion, ShotRecord } from '@golf/types';
import { View } from 'react-native';
import Svg, { Circle, Ellipse, Line } from 'react-native-svg';

import { buildGroupingGeometry } from './lib/dispersion-geometry';

interface GroupingViewProps {
  /** discarded shots and shots without a computed flight are excluded */
  shots: ShotRecord[];
  dispersion: Dispersion;
  width: number;
  height: number;
  color?: string;
  outlierColor?: string;
}

/**
 * Landing-pattern scatter with the analytics 1σ ellipse, pattern center, and
 * outlier flagging (BUILD_SPEC §10.2). Respects the discard flag and the
 * null rule — junk shots don't distort the picture.
 */
export function GroupingView({
  shots,
  dispersion,
  width,
  height,
  color = '#1f5631',
  outlierColor = '#b8433c',
}: GroupingViewProps) {
  const landings = shots.flatMap((shot) =>
    shot.discarded || shot.flight === null ? [] : [shot.flight.landing],
  );
  const geometry = buildGroupingGeometry(landings, dispersion, {
    width,
    height,
  });

  return (
    <View style={{ height, width }}>
      <Svg width={width} height={height}>
        <Line
          x1={geometry.targetLineX}
          y1={0}
          x2={geometry.targetLineX}
          y2={height}
          stroke="#d9d4c5"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        {geometry.ellipse && (
          <Ellipse
            cx={geometry.ellipse.cx}
            cy={geometry.ellipse.cy}
            rx={geometry.ellipse.rx}
            ry={geometry.ellipse.ry}
            rotation={geometry.ellipse.rotationDeg}
            originX={geometry.ellipse.cx}
            originY={geometry.ellipse.cy}
            fill={color}
            fillOpacity={0.08}
            stroke={color}
            strokeWidth={1}
          />
        )}
        {geometry.marks.map((mark, index) => (
          <Circle
            key={`${mark.landing.x}-${mark.landing.z}-${index}`}
            cx={mark.screen.x}
            cy={mark.screen.y}
            r={mark.outlier ? 4.5 : 3.5}
            fill={mark.outlier ? 'none' : color}
            stroke={mark.outlier ? outlierColor : 'none'}
            strokeWidth={mark.outlier ? 2 : 0}
          />
        ))}
        <Line
          x1={geometry.center.x - 5}
          y1={geometry.center.y}
          x2={geometry.center.x + 5}
          y2={geometry.center.y}
          stroke={color}
          strokeWidth={1.5}
        />
        <Line
          x1={geometry.center.x}
          y1={geometry.center.y - 5}
          x2={geometry.center.x}
          y2={geometry.center.y + 5}
          stroke={color}
          strokeWidth={1.5}
        />
      </Svg>
    </View>
  );
}
