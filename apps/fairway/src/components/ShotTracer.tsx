import { DEFAULT_TRACER_COLOR, FlightResult, ShotRecord } from '@golf/types';
import { tw } from '@golf/ui';
import {
  classifyShotShape,
  SimTracerView,
  TopDownView,
  TracerArc,
} from '@golf/viz';
import { useState } from 'react';
import { Text, View } from 'react-native';

interface ShotTracerProps {
  /** newest first (the live session list order) */
  sessionShots: ShotRecord[];
  /** clubId → tracer color for every club that may appear in the session */
  clubColors: ReadonlyMap<string, string>;
  /** clubs toggled on via the chips; empty = latest-shot-only mode */
  visibleClubIds: string[];
  /** px to lift bottom-anchored overlays (floating tile strip height) */
  overlayBottomOffset?: number;
  /** px to drop top-anchored overlays (floating buttons / notch) */
  overlayTopOffset?: number;
}

interface DrawableShot {
  record: ShotRecord;
  flight: FlightResult;
}

const MAX_GHOSTS = 5;

const LABEL_SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.75)',
  textShadowOffset: { height: 1, width: 0 },
  textShadowRadius: 4,
} as const;

/**
 * Sim-style tracer that fills whatever space its parent gives it: side-view
 * arcs with a top-down shape inset, VIEW/Trackman style. Two modes: with no
 * clubs toggled on, the latest shot animates over faint same-club ghosts;
 * with club chips toggled on, every one of those clubs' session shots stays
 * up, each arc in its club's color. All COMPUTED (est.) — measured numbers
 * live in the tile strip.
 */
export function ShotTracer({
  sessionShots,
  clubColors,
  visibleClubIds,
  overlayBottomOffset = 0,
  overlayTopOffset = 0,
}: ShotTracerProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  const colorFor = (clubId: string) =>
    clubColors.get(clubId) ?? DEFAULT_TRACER_COLOR;

  const drawable: DrawableShot[] = sessionShots.flatMap((record) =>
    !record.discarded && record.flight !== null
      ? [{ record, flight: record.flight }]
      : [],
  );
  const lastOnly = visibleClubIds.length === 0;
  const visible = lastOnly
    ? drawable
    : drawable.filter((s) => visibleClubIds.includes(s.record.clubId));
  const latest = visible[0] ?? null;

  // oldest first so newer arcs draw on top
  const arcs: TracerArc[] = (
    lastOnly
      ? latest === null
        ? []
        : visible
            .filter(
              (s) =>
                s.record.id !== latest.record.id &&
                s.record.clubId === latest.record.clubId,
            )
            .slice(0, MAX_GHOSTS)
            .map((s) => ({
              key: s.record.id,
              flight: s.flight,
              color: colorFor(s.record.clubId),
              ghost: true,
            }))
      : visible.slice(1).map((s) => ({
          key: s.record.id,
          flight: s.flight,
          color: colorFor(s.record.clubId),
        }))
  ).reverse();

  const shape =
    latest &&
    classifyShotShape(latest.flight, {
      launchDirectionDeg: latest.record.measured.ball.launchDirectionDeg,
    });

  const countLabel = lastOnly
    ? arcs.length > 0
      ? `${arcs.length} ghosts · est.`
      : 'est.'
    : `${visible.length} ${visible.length === 1 ? 'shot' : 'shots'} · est.`;

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
            latest={
              latest
                ? {
                    flight: latest.flight,
                    color: colorFor(latest.record.clubId),
                  }
                : null
            }
            arcs={arcs}
            width={size.width}
            height={size.height}
            animateKey={latest?.record.shotGuid}
          />
          {latest && (
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
                  launchDirectionDeg={
                    latest.record.measured.ball.launchDirectionDeg
                  }
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
                  {countLabel}
                </Text>
              </View>
            </>
          )}
          {!latest && (
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
