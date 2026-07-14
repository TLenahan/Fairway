import { FlightResult, MeasuredShot } from '@golf/types';
import { StatTile, tw } from '@golf/ui';
import { View } from 'react-native';

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

interface ShotMetricsGridProps {
  measured: MeasuredShot;
  /** COMPUTED flight-model output for the same shot (null before/without it) */
  flight: FlightResult | null;
}

/**
 * The live measured-metrics grid (BUILD_SPEC F4): every unmeasured value
 * renders as an em dash (never a fake 0), every flight-model value carries
 * the est. treatment.
 */
export function ShotMetricsGrid({ measured, flight }: ShotMetricsGridProps) {
  const speedUnit = useSettings((s) => s.speedUnit);
  const distanceUnit = useSettings((s) => s.distanceUnit);
  const speedLabel = speedUnitLabel[speedUnit];
  const distanceLabel = distanceUnitLabel[distanceUnit];

  return (
    <View>
      <View style={tw`flex-row flex-wrap justify-between gap-x-4`}>
        <StatTile
          label="Ball"
          value={formatSpeed(measured.ball.speedMs, speedUnit)}
          unit={speedLabel}
          large
        />
        <StatTile
          label="Club"
          value={formatSpeed(measured.club.speedMs, speedUnit)}
          unit={speedLabel}
          large
        />
        <StatTile
          label="Smash"
          value={formatSmash(measured.smashFactor)}
          large
        />
        <StatTile
          label="Carry"
          value={formatDistance(flight?.carryM ?? null, distanceUnit)}
          unit={distanceLabel}
          estimate
          large
        />
        <StatTile
          label="Total"
          value={formatDistance(flight?.totalM ?? null, distanceUnit)}
          unit={distanceLabel}
          estimate
          large
        />
      </View>
      <View style={tw`mt-2 flex-row flex-wrap justify-between gap-x-4`}>
        <StatTile
          label="Launch"
          value={formatDegrees(measured.ball.launchAngleDeg)}
        />
        <StatTile
          label="Direction"
          value={formatDegrees(measured.ball.launchDirectionDeg)}
        />
        <StatTile
          label="Backspin"
          value={formatSpin(measured.ball.backspinRpm)}
          unit="rpm"
        />
        <StatTile
          label="Sidespin"
          value={formatSpin(measured.ball.sidespinRpm)}
          unit="rpm"
        />
        <StatTile label="Path" value={formatDegrees(measured.club.pathDeg)} />
        <StatTile
          label="Face"
          value={formatDegrees(measured.club.faceAngleDeg)}
        />
        <StatTile
          label="Attack"
          value={formatDegrees(measured.club.attackAngleDeg)}
        />
        <StatTile
          label="Apex"
          value={formatDistance(flight?.apexM ?? null, distanceUnit)}
          unit={distanceLabel}
          estimate
        />
      </View>
    </View>
  );
}
