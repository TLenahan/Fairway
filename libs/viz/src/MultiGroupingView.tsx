import { Fragment } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Ellipse, Line } from 'react-native-svg';

import {
  buildMultiGroupGeometry,
  GroupSeries,
} from './lib/dispersion-geometry';

interface MultiGroupingViewProps {
  /** one entry per group; each renders in its own color on a shared plot */
  series: GroupSeries[];
  width: number;
  height: number;
}

/**
 * Multi-group dispersion overlay: every group's landing scatter + 1σ ellipse
 * + pattern center on ONE shared viewport, each in the group's color, so a
 * red 6-iron and a yellow 6-iron patterns compare at a glance. Outliers get a
 * hollow ring. Pure geometry lives in lib/dispersion-geometry.
 */
export function MultiGroupingView({
  series,
  width,
  height,
}: MultiGroupingViewProps) {
  const geometry = buildMultiGroupGeometry(series, { width, height });

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
        {geometry.groups.map((group) => (
          <Fragment key={group.clubId}>
            {group.ellipse && (
              <Ellipse
                cx={group.ellipse.cx}
                cy={group.ellipse.cy}
                rx={group.ellipse.rx}
                ry={group.ellipse.ry}
                rotation={group.ellipse.rotationDeg}
                originX={group.ellipse.cx}
                originY={group.ellipse.cy}
                fill={group.color}
                fillOpacity={0.1}
                stroke={group.color}
                strokeWidth={1}
              />
            )}
            {group.marks.map((mark, index) => (
              <Circle
                key={`${group.clubId}-${index}`}
                cx={mark.screen.x}
                cy={mark.screen.y}
                r={mark.outlier ? 4.5 : 3.5}
                fill={mark.outlier ? 'none' : group.color}
                stroke={mark.outlier ? group.color : 'none'}
                strokeWidth={mark.outlier ? 2 : 0}
              />
            ))}
            <Line
              x1={group.center.x - 5}
              y1={group.center.y}
              x2={group.center.x + 5}
              y2={group.center.y}
              stroke={group.color}
              strokeWidth={2}
            />
            <Line
              x1={group.center.x}
              y1={group.center.y - 5}
              x2={group.center.x}
              y2={group.center.y + 5}
              stroke={group.color}
              strokeWidth={2}
            />
          </Fragment>
        ))}
      </Svg>
    </View>
  );
}
