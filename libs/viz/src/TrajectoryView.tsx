import { FlightResult } from '@golf/types';
import { View } from 'react-native';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';

import { projectTrajectories } from './lib/project-trajectory';

interface TrajectoryViewProps {
  /** last entry is the "current" shot; earlier ones render as ghosts */
  results: FlightResult[];
  width: number;
  height: number;
  color?: string;
  ghostColor?: string;
}

/**
 * Side-profile tracer (BUILD_SPEC §10.2). Pure projection of
 * FlightResult.path — zero math here (see lib/project-trajectory). All
 * distances shown by the surrounding screen are COMPUTED — pair with
 * EstimateBadge.
 */
export function TrajectoryView({
  results,
  width,
  height,
  color = '#1f5631',
  ghostColor = '#9aa4a0',
}: TrajectoryViewProps) {
  const projection = projectTrajectories(results, { width, height });
  const last = projection.shots.length - 1;

  return (
    <View style={{ height, width }}>
      <Svg width={width} height={height}>
        <Line
          x1={0}
          y1={projection.groundY}
          x2={width}
          y2={projection.groundY}
          stroke="#d9d4c5"
          strokeWidth={1}
        />
        {projection.shots.map((shot, index) => (
          <Polyline
            key={shot.result.landing.x + '-' + index}
            points={shot.svgPoints}
            fill="none"
            stroke={index === last ? color : ghostColor}
            strokeWidth={index === last ? 2.5 : 1.25}
            opacity={index === last ? 1 : 0.55}
          />
        ))}
        {projection.shots.length > 0 && (
          <>
            <Circle
              cx={projection.shots[last].apex.x}
              cy={projection.shots[last].apex.y}
              r={3}
              fill={color}
            />
            <Circle
              cx={projection.shots[last].landing.x}
              cy={projection.shots[last].landing.y}
              r={4}
              fill={color}
            />
          </>
        )}
      </Svg>
    </View>
  );
}
