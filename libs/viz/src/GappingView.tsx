import { GappingEntry } from '@golf/types';
import { View } from 'react-native';
import Svg, { G, Rect, Text as SvgText } from 'react-native-svg';

import { buildGappingRows } from './lib/gapping-layout';
import { formatDistanceLabel, VizDistanceUnit } from './lib/units';

interface GappingViewProps {
  entries: GappingEntry[];
  width: number;
  unit?: VizDistanceUnit;
  rowHeight?: number;
  color?: string;
  warnColor?: string;
  /** per-club bar color (the club's tracer color) — distinguishes same-named
   *  groups; falls back to `color`. A flagged row still wins with warnColor. */
  colorForClub?: (clubId: string) => string | undefined;
}

const LABEL_WIDTH = 96;

/**
 * Carry-by-club ladder (BUILD_SPEC §10.2): bars ordered longest first, red
 * treatment for overlaps (two clubs at the same carry) and oversized gaps
 * (> 25 m hole in the bag). Carries are COMPUTED estimates.
 */
export function GappingView({
  entries,
  width,
  unit = 'yards',
  rowHeight = 26,
  color = '#1f5631',
  warnColor = '#b8433c',
  colorForClub,
}: GappingViewProps) {
  const rows = buildGappingRows(entries);
  const height = rows.length * rowHeight;
  const barMax = width - LABEL_WIDTH - 64;

  return (
    <View style={{ height, width }}>
      <Svg width={width} height={height}>
        {rows.map((row, index) => {
          const y = index * rowHeight;
          const flagged = row.overlap || row.oversizedGap;
          const barColor = flagged
            ? warnColor
            : (colorForClub?.(row.clubId) ?? color);
          return (
            <G key={row.clubId}>
              <SvgText
                x={LABEL_WIDTH - 8}
                y={y + rowHeight / 2 + 4}
                fontSize={12}
                fill="#131a16"
                textAnchor="end"
              >
                {row.clubName}
              </SvgText>
              <Rect
                x={LABEL_WIDTH}
                y={y + 5}
                width={Math.max(row.barFraction * barMax, 2)}
                height={rowHeight - 10}
                rx={3}
                fill={barColor}
                fillOpacity={flagged ? 0.85 : 0.9}
              />
              <SvgText
                x={LABEL_WIDTH + Math.max(row.barFraction * barMax, 2) + 6}
                y={y + rowHeight / 2 + 4}
                fontSize={11}
                fill={flagged ? warnColor : '#131a16'}
              >
                {formatDistanceLabel(row.carryMeanM, unit)}
              </SvgText>
            </G>
          );
        })}
      </Svg>
    </View>
  );
}
