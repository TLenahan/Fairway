import { FlightResult, MeasuredShot } from '@golf/types';
import { tw } from '@golf/ui';
import { ScrollView, Text, View } from 'react-native';

import {
  distanceUnitLabel,
  formatDegrees,
  formatDistance,
  formatSmash,
  formatSpeed,
  formatSpin,
  speedUnitLabel,
} from '@/lib/format';
import { useSettings } from '@/services/context';

interface MetricTileStripProps {
  measured: MeasuredShot | null;
  flight: FlightResult | null;
}

interface Tile {
  label: string;
  value: string | null;
  unit?: string;
  estimate?: boolean;
}

/**
 * VIEW/Trackman-style bottom data strip: one horizontal row of big tiles.
 * Null = em dash (never a fake 0); flight-model values carry est. styling.
 */
export function MetricTileStrip({ measured, flight }: MetricTileStripProps) {
  const speedUnit = useSettings((s) => s.speedUnit);
  const distanceUnit = useSettings((s) => s.distanceUnit);
  const speed = speedUnitLabel[speedUnit];
  const distance = distanceUnitLabel[distanceUnit];

  const tiles: Tile[] = measured
    ? [
        {
          label: 'Carry',
          value: formatDistance(flight?.carryM ?? null, distanceUnit),
          unit: distance,
          estimate: true,
        },
        {
          label: 'Total',
          value: formatDistance(flight?.totalM ?? null, distanceUnit),
          unit: distance,
          estimate: true,
        },
        {
          label: 'Ball',
          value: formatSpeed(measured.ball.speedMs, speedUnit),
          unit: speed,
        },
        {
          label: 'Club',
          value: formatSpeed(measured.club.speedMs, speedUnit),
          unit: speed,
        },
        { label: 'Smash', value: formatSmash(measured.smashFactor) },
        {
          label: 'Launch',
          value: formatDegrees(measured.ball.launchAngleDeg),
        },
        {
          label: 'Direction',
          value: formatDegrees(measured.ball.launchDirectionDeg),
        },
        {
          label: 'Backspin',
          value: formatSpin(measured.ball.backspinRpm),
          unit: 'rpm',
        },
        {
          label: 'Sidespin',
          value: formatSpin(measured.ball.sidespinRpm),
          unit: 'rpm',
        },
        {
          label: 'Apex',
          value: formatDistance(flight?.apexM ?? null, distanceUnit),
          unit: distance,
          estimate: true,
        },
        { label: 'Path', value: formatDegrees(measured.club.pathDeg) },
        { label: 'Face', value: formatDegrees(measured.club.faceAngleDeg) },
        {
          label: 'Attack',
          value: formatDegrees(measured.club.attackAngleDeg),
        },
      ]
    : [];

  if (!measured) {
    return (
      <View style={tw`h-24 items-center justify-center`}>
        <Text style={tw`text-silver`}>
          Measured data tiles appear here after the first shot.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={tw`gap-2 px-3 pb-1`}
    >
      {tiles.map((tile) => (
        <View
          key={tile.label}
          style={tw`w-24 items-center rounded-2xl border border-green-100 bg-white px-2 py-3`}
        >
          <View style={tw`flex-row items-center gap-1`}>
            <Text style={tw`text-[11px] uppercase tracking-wide text-silver`}>
              {tile.label}
            </Text>
            {tile.estimate && (
              <Text style={tw`text-[9px] font-semibold text-computed`}>
                est.
              </Text>
            )}
          </View>
          <Text
            style={tw.style(
              'mt-1 text-2xl font-bold',
              tile.value === null
                ? 'text-silver'
                : tile.estimate
                  ? 'text-computed'
                  : 'text-ink',
            )}
          >
            {tile.value ?? '—'}
          </Text>
          {tile.value !== null && tile.unit && (
            <Text style={tw`text-[10px] text-silver`}>{tile.unit}</Text>
          )}
        </View>
      ))}
    </ScrollView>
  );
}
