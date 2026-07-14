import { ShotRecord } from '@golf/types';
import { tw } from '@golf/ui';
import { classifyShotShape, TopDownView, TrajectoryView } from '@golf/viz';
import { Text, useWindowDimensions, View } from 'react-native';

interface ShotTracerProps {
  /** newest first (the live session list order) */
  sessionShots: ShotRecord[];
}

const MAX_GHOSTS = 5;

/**
 * Live tracer for the most recent shot: side-profile arc ghost-overlaid with
 * the previous shots of the same club, plus the top-down shape view. All of
 * it is COMPUTED flight-model output (est.) — measured numbers live in the
 * metrics grid above.
 */
export function ShotTracer({ sessionShots }: ShotTracerProps) {
  const { width } = useWindowDimensions();

  const latest = sessionShots.find((s) => !s.discarded && s.flight !== null);
  if (!latest?.flight) {
    return (
      <Text style={tw`py-6 text-center text-silver`}>
        The tracer draws here after the first full shot (putts don't fly).
      </Text>
    );
  }

  const ghosts = sessionShots
    .filter(
      (s) =>
        s.id !== latest.id &&
        !s.discarded &&
        s.flight !== null &&
        s.clubId === latest.clubId,
    )
    .slice(0, MAX_GHOSTS)
    .map((s) => s.flight)
    .filter((f) => f !== null)
    .reverse(); // oldest first so the newest draws last/boldest

  const shape = classifyShotShape(latest.flight, {
    launchDirectionDeg: latest.measured.ball.launchDirectionDeg,
  });

  // side-by-side on wide screens (tablet/landscape), stacked on a phone
  const wide = width >= 700;
  const cardInnerWidth = Math.min(width - 64, 1000);
  const trajectoryWidth = wide ? cardInnerWidth * 0.62 : cardInnerWidth;
  const topDownWidth = wide ? cardInnerWidth * 0.34 : cardInnerWidth * 0.7;

  return (
    <View
      style={tw.style(
        wide ? 'flex-row items-end justify-between' : 'items-center',
      )}
    >
      <View>
        <TrajectoryView
          results={[...ghosts, latest.flight]}
          width={trajectoryWidth}
          height={170}
        />
        <Text style={tw`mt-1 text-center text-xs text-computed`}>
          side view ·{' '}
          {ghosts.length > 0
            ? `${ghosts.length} ghost${ghosts.length > 1 ? 's' : ''} · `
            : ''}
          est.
        </Text>
      </View>
      <View style={tw.style(!wide && 'mt-3')}>
        <TopDownView
          result={latest.flight}
          launchDirectionDeg={latest.measured.ball.launchDirectionDeg}
          width={topDownWidth}
          height={170}
        />
        <Text style={tw`mt-1 text-center text-xs text-computed`}>
          top view · {shape} · est.
        </Text>
      </View>
    </View>
  );
}
