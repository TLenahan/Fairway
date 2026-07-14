import { ShotRecord } from '@golf/types';
import { tw } from '@golf/ui';
import { classifyShotShape, SimTracerView, TopDownView } from '@golf/viz';
import { useState } from 'react';
import { Text, View } from 'react-native';

interface ShotTracerProps {
  /** newest first (the live session list order) */
  sessionShots: ShotRecord[];
  /** px to lift bottom-anchored overlays (floating tile strip height) */
  overlayBottomOffset?: number;
  /** px to drop top-anchored overlays (floating buttons / notch) */
  overlayTopOffset?: number;
  /** active club tracer color */
  tracerColor?: string;
}

const MAX_GHOSTS = 5;

const LABEL_SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.75)',
  textShadowOffset: { height: 1, width: 0 },
  textShadowRadius: 4,
} as const;

/**
 * Sim-style tracer that fills whatever space its parent gives it: side-view
 * arc (ghost-overlaid with previous same-club shots) with a top-down shape
 * inset, VIEW/Trackman style. All COMPUTED (est.) — measured numbers live in
 * the tile strip.
 */
export function ShotTracer({
  sessionShots,
  overlayBottomOffset = 0,
  overlayTopOffset = 0,
  tracerColor,
}: ShotTracerProps) {
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
      {size.width > 0 ? (
        <>
          <SimTracerView
            result={latest?.flight ?? null}
            ghosts={ghosts}
            width={size.width}
            height={size.height}
            animateKey={latest?.shotGuid}
            color={tracerColor}
          />
          {latest?.flight && (
            <>
              <View
                style={[
                  tw`absolute right-2 rounded-xl border border-white/40 bg-white/85`,
                  { bottom: 8 + overlayBottomOffset },
                  { width: size.width * 0.32, height: size.height * 0.2 },
                ]}
              >
                <TopDownView
                  result={latest.flight}
                  launchDirectionDeg={latest.measured.ball.launchDirectionDeg}
                  width={size.width * 0.32}
                  height={size.height * 0.2}
                />
              </View>
              <View
                style={[
                  tw`absolute left-4 flex-row items-center gap-2`,
                  { top: overlayTopOffset },
                ]}
              >
                <Text style={[tw`text-lg font-bold text-white`, LABEL_SHADOW]}>
                  {shape}
                </Text>
                <Text style={[tw`text-xs text-white/85`, LABEL_SHADOW]}>
                  {ghosts.length > 0 ? `${ghosts.length} ghosts · ` : ''}est.
                </Text>
              </View>
            </>
          )}
          {!latest?.flight && (
            <Text
              style={[
                tw`absolute inset-x-0 text-center text-xs text-white/90`,
                { top: overlayTopOffset },
              ]}
            >
              Hit a ball — the tracer draws here
            </Text>
          )}
        </>
      ) : null}
    </View>
  );
}
