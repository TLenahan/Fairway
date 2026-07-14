import { FlightResult } from '@golf/types';
import { View } from 'react-native';
import Svg, { Circle, Line, Polyline, Text as SvgText } from 'react-native-svg';

import { projectTopDown } from './lib/project-topdown';
import { classifyShotShape } from './lib/shot-shape';

interface TopDownViewProps {
  result: FlightResult;
  launchDirectionDeg: number;
  width: number;
  height: number;
  color?: string;
}

/**
 * Plan view / shot shape (BUILD_SPEC §10.2): target line down the middle,
 * the CURVED path (a straight arc ignoring sidespin is a bug — the curve
 * comes from the flight model's path), landing dot, derived shape label.
 */
export function TopDownView({
  result,
  launchDirectionDeg,
  width,
  height,
  color = '#1f5631',
}: TopDownViewProps) {
  const projection = projectTopDown(result, { width, height });
  const shape = classifyShotShape(result, { launchDirectionDeg });

  return (
    <View style={{ height, width }}>
      <Svg width={width} height={height}>
        <Line
          x1={projection.targetLine.from.x}
          y1={projection.targetLine.from.y}
          x2={projection.targetLine.to.x}
          y2={projection.targetLine.to.y}
          stroke="#d9d4c5"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        <Polyline
          points={projection.svgPoints}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
        />
        <Circle
          cx={projection.tee.x}
          cy={projection.tee.y}
          r={3}
          fill="#9aa4a0"
        />
        <Circle
          cx={projection.landing.x}
          cy={projection.landing.y}
          r={4.5}
          fill={color}
        />
        <SvgText
          x={width - 8}
          y={16}
          fill={color}
          fontSize={12}
          fontWeight="600"
          textAnchor="end"
        >
          {shape}
        </SvgText>
      </Svg>
    </View>
  );
}
