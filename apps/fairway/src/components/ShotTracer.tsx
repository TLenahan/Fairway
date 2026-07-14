import { ShotRecord } from '@golf/types';
import { tw } from '@golf/ui';
import { classifyShotShape, SimTracerView, TopDownView } from '@golf/viz';
import { useState } from 'react';
import { Text, View } from 'react-native';

interface ShotTracerProps {
  /** newest first (the live session list order) */
  sessionShots: ShotRecord[];
}

const MAX_GHOSTS = 5;

/**
 * Sim-style tracer that fills whatever space its parent gives it: side-view
 * arc (ghost-overlaid with previous same-club shots) with a top-down shape
 * inset, VIEW/Trackman style. All COMPUTED (est.) — measured numbers live in
 * the tile strip.
 */
export function ShotTracer({ sessionShots }: ShotTracerProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  const latest = sessionShots.find((s) => !s.discarded && s.flight !== null);

  const ghosts = latest
    ? sessionShots
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
        .reverse() // oldest first so the newest draws last/boldest
    : [];

  const shape =
    latest?.flight &&
    classifyShotShape(latest.flight, {
      launchDirectionDeg: latest.measured.ball.launchDirectionDeg,
    });

  return (
    <View
      style={tw`flex-1`}
      onLayout={(e) =>
        setSize({
          width: e.nativeEvent.layout.width,
          height: e.nativeEvent.layout.height,
        })
      }
    >
      {size.width > 0 && latest?.flight ? (
        <>
          <SimTracerView
            result={latest.flight}
            ghosts={ghosts}
            width={size.width}
            height={size.height}
            animateKey={latest.shotGuid}
          />
          {/* top-down inset, bottom-right, sim style */}
          <View
            style={[
              tw`absolute bottom-1 right-1 rounded-xl border border-green-100 bg-white/90`,
              { width: size.width * 0.3, height: size.height * 0.52 },
            ]}
          >
            <TopDownView
              result={latest.flight}
              launchDirectionDeg={latest.measured.ball.launchDirectionDeg}
              width={size.width * 0.3}
              height={size.height * 0.52}
            />
          </View>
          <View style={tw`absolute left-2 top-1 flex-row items-center gap-2`}>
            <Text style={tw`text-base font-semibold text-green-700`}>
              {shape}
            </Text>
            <Text style={tw`text-xs text-computed`}>
              {ghosts.length > 0 ? `${ghosts.length} ghosts · ` : ''}est.
            </Text>
          </View>
        </>
      ) : (
        <View style={tw`flex-1 items-center justify-center`}>
          <Text style={tw`text-center text-silver`}>
            {size.width > 0
              ? 'Hit a ball — the tracer draws here (putts don’t fly).'
              : ''}
          </Text>
        </View>
      )}
    </View>
  );
}
