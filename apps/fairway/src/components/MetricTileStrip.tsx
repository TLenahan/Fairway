import { FlightResult, MeasuredShot } from '@golf/types';
import { tw } from '@golf/ui';
import { ScrollView, Text, View } from 'react-native';

import {
  apexUnitLabel,
  distanceUnitLabel,
  formatApexHeight,
  formatDegrees,
  formatDistance,
  formatSmash,
  formatSpeed,
  formatSpin,
  speedUnitLabel,
} from '@/lib/format';
import { useSettings } from '@/services/context';

const SHADOW_STYLE = {
  textShadowColor: 'rgba(0,0,0,0.75)',
  textShadowOffset: { height: 1, width: 0 },
  textShadowRadius: 4,
} as const;

interface MetricTileStripProps {
  measured: MeasuredShot | null;
  flight: FlightResult | null;
  /** chromeless: white text floating over the backdrop, no tile cards */
  floating?: boolean;
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
export function MetricTileStrip({
  measured,
  flight,
  floating = false,
}: MetricTileStripProps) {
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
          value: formatApexHeight(flight?.apexM ?? null, distanceUnit),
          unit: apexUnitLabel[distanceUnit],
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
      <View style={tw`h-20 items-center justify-center`}>
        <Text
          style={[
            tw.style(floating ? 'text-white/90' : 'text-silver'),
            floating && SHADOW_STYLE,
          ]}
        >
          Measured data appears here after the first shot.
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
          style={tw.style(
            'w-24 items-center px-2',
            floating
              ? 'py-1.5'
              : 'rounded-2xl border border-green-100 bg-white py-3',
          )}
        >
          <View style={tw`flex-row items-center gap-1`}>
            <Text
              style={[
                tw.style(
                  'text-[11px] uppercase tracking-wide',
                  floating ? 'text-white/85' : 'text-silver',
                ),
                floating && SHADOW_STYLE,
              ]}
            >
              {tile.label}
            </Text>
            {tile.estimate && (
              <Text
                style={[
                  tw.style(
                    'text-[9px] font-semibold',
                    floating ? 'text-gold-300' : 'text-computed',
                  ),
                  floating && SHADOW_STYLE,
                ]}
              >
                est.
              </Text>
            )}
          </View>
          <Text
            style={[
              tw.style(
                'mt-1 text-2xl font-bold',
                tile.value === null
                  ? floating
                    ? 'text-white/50'
                    : 'text-silver'
                  : tile.estimate
                    ? floating
                      ? 'text-gold-300'
                      : 'text-computed'
                    : floating
                      ? 'text-white'
                      : 'text-ink',
              ),
              floating && SHADOW_STYLE,
            ]}
          >
            {tile.value ?? '—'}
          </Text>
          {tile.value !== null && tile.unit && (
            <Text
              style={[
                tw.style(
                  'text-[10px]',
                  floating ? 'text-white/75' : 'text-silver',
                ),
                floating && SHADOW_STYLE,
              ]}
            >
              {tile.unit}
            </Text>
          )}
        </View>
      ))}
    </ScrollView>
  );
}
