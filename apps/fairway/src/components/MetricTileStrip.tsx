import { FlightResult, MeasuredShot } from '@golf/types';
import { tw } from '@golf/ui';
import { ChevronDown, ChevronUp } from 'lucide-react-native';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  LayoutAnimation,
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  Text,
  View,
} from 'react-native';

import { MetricTileKey, sanitizeTileOrder } from '@/constants/metric-tiles';
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

// slot geometry must match the tile classes below: w-24 (96) + gap-2 (8);
// tile height is fixed so every grid row is the same size and drag math can
// treat the wrapped layout as uniform slots
const TILE_WIDTH = 96;
const TILE_HEIGHT = 88;
const TILE_GAP = 8;
const SLOT_WIDTH = TILE_WIDTH + TILE_GAP;
const SLOT_HEIGHT = TILE_HEIGHT + TILE_GAP;
const GRID_H_PADDING = 12; // px-3
const CHEVRON_HEIGHT = 28; // h-7
const CHEVRON_GAP = 4; // mb-1
const STRIP_BOTTOM_PADDING = 4; // pb-1

/** collapsed strip height, for the practice screen's overlay offsets */
export const METRIC_TILE_STRIP_HEIGHT =
  CHEVRON_HEIGHT + CHEVRON_GAP + TILE_HEIGHT + STRIP_BOTTOM_PADDING;

const SPRING = { friction: 9, tension: 80, useNativeDriver: true } as const;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

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

interface TileDragController {
  pressIn(index: number): void;
  move(dx: number, dy: number): void;
  release(): void;
  terminate(): void;
  isDragging(): boolean;
}

/**
 * Drag-and-drop reordering for the expanded tile grid. Touching a tile lifts
 * it; as it crosses slot boundaries the other tiles spring into their
 * displaced grid positions (including wrapping between rows); on release the
 * tile springs into its target slot and the order is committed to settings.
 * Only active in the expanded state, where the grid is fully visible, so
 * there is no scrolling to negotiate with.
 */
function useTileDrag(
  order: MetricTileKey[],
  commitOrder: (next: MetricTileKey[]) => void,
) {
  const columns = useRef(1);

  const orderRef = useRef(order);
  useEffect(() => {
    orderRef.current = order;
  }, [order]);

  const commitRef = useRef(commitOrder);
  useEffect(() => {
    commitRef.current = commitOrder;
  }, [commitOrder]);

  const [dragKey, setDragKey] = useState<MetricTileKey | null>(null);
  const [dragXY] = useState(() => new Animated.ValueXY());
  const [liftScale] = useState(() => new Animated.Value(1));
  const [shiftValues] = useState(
    () => new Map<MetricTileKey, Animated.ValueXY>(),
  );

  const dragging = useRef(false);
  const settling = useRef(false);
  const pendingReset = useRef(false);
  const fromIndex = useRef(0);
  const proposedIndex = useRef(0);

  const shiftValueFor = useCallback(
    (key: MetricTileKey) => {
      let value = shiftValues.get(key);
      if (!value) {
        value = new Animated.ValueXY();
        shiftValues.set(key, value);
      }
      return value;
    },
    [shiftValues],
  );

  const controller = useMemo<TileDragController>(() => {
    const slotPos = (index: number) => ({
      x: (index % columns.current) * SLOT_WIDTH,
      y: Math.floor(index / columns.current) * SLOT_HEIGHT,
    });

    // where tile i sits once the dragged tile moves from -> to
    const displacedIndex = (i: number, from: number, to: number) =>
      from < to && i > from && i <= to
        ? i - 1
        : to < from && i >= to && i < from
          ? i + 1
          : i;

    const shiftSpring = (key: MetricTileKey, i: number) => {
      const base = slotPos(i);
      const target = slotPos(
        displacedIndex(i, fromIndex.current, proposedIndex.current),
      );
      return Animated.spring(shiftValueFor(key), {
        ...SPRING,
        toValue: { x: target.x - base.x, y: target.y - base.y },
      });
    };

    const applyShifts = () => {
      orderRef.current.forEach((key, i) => {
        if (i === fromIndex.current) return;
        shiftSpring(key, i).start();
      });
    };

    const settle = (
      rest: { x: number; y: number },
      next: MetricTileKey[] | null,
    ) => {
      settling.current = true;
      // the parallel re-declares every neighbor's end target so the commit
      // waits for the whole formation to land, not just the dragged tile
      const springs = [
        Animated.spring(dragXY, { ...SPRING, toValue: rest }),
        Animated.spring(liftScale, { ...SPRING, toValue: 1 }),
      ];
      orderRef.current.forEach((key, i) => {
        if (i === fromIndex.current) return;
        springs.push(shiftSpring(key, i));
      });
      Animated.parallel(springs).start(() => {
        if (next) {
          // transforms are reset by the layout effect once the reordered
          // list renders, so nothing flashes back to its old slot
          pendingReset.current = true;
          commitRef.current(next);
        } else {
          settling.current = false;
          setDragKey(null);
        }
      });
    };

    return {
      pressIn(index) {
        if (dragging.current || settling.current) return;
        dragging.current = true;
        fromIndex.current = index;
        proposedIndex.current = index;
        dragXY.setValue({ x: 0, y: 0 });
        Animated.spring(liftScale, { ...SPRING, toValue: 1.06 }).start();
        setDragKey(orderRef.current[index] ?? null);
      },
      move(dx, dy) {
        if (!dragging.current) return;
        dragXY.setValue({ x: dx, y: dy });
        const count = orderRef.current.length;
        const rows = Math.ceil(count / columns.current);
        const base = slotPos(fromIndex.current);
        const col = clamp(
          Math.round((base.x + dx) / SLOT_WIDTH),
          0,
          columns.current - 1,
        );
        const row = clamp(Math.round((base.y + dy) / SLOT_HEIGHT), 0, rows - 1);
        const proposed = Math.min(row * columns.current + col, count - 1);
        if (proposed !== proposedIndex.current) {
          proposedIndex.current = proposed;
          applyShifts();
        }
      },
      release() {
        if (!dragging.current) return;
        dragging.current = false;
        const from = fromIndex.current;
        const to = proposedIndex.current;
        if (to !== from) {
          const next = [...orderRef.current];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          const a = slotPos(from);
          const b = slotPos(to);
          settle({ x: b.x - a.x, y: b.y - a.y }, next);
        } else {
          settle({ x: 0, y: 0 }, null);
        }
      },
      terminate() {
        if (!dragging.current) return;
        dragging.current = false;
        // proposed reverts to the origin, so every shift springs home
        proposedIndex.current = fromIndex.current;
        settle({ x: 0, y: 0 }, null);
      },
      isDragging: () => dragging.current,
    };
  }, [dragXY, liftScale, shiftValueFor]);

  // reset transforms in the same commit that renders the new order: the
  // reorder moves each shifted tile's layout slot by exactly the offset its
  // transform was holding, so zeroing both together is visually seamless
  useLayoutEffect(() => {
    if (!pendingReset.current) return;
    pendingReset.current = false;
    dragXY.setValue({ x: 0, y: 0 });
    liftScale.setValue(1);
    shiftValues.forEach((value) => value.setValue({ x: 0, y: 0 }));
    settling.current = false;
    setDragKey(null);
  }, [order, dragXY, liftScale, shiftValues]);

  const onGridLayout = useCallback((event: LayoutChangeEvent) => {
    const available = event.nativeEvent.layout.width - GRID_H_PADDING * 2;
    columns.current = Math.max(
      1,
      Math.floor((available + TILE_GAP) / SLOT_WIDTH),
    );
  }, []);

  return {
    dragKey,
    dragXY,
    liftScale,
    shiftValueFor,
    controller,
    onGridLayout,
  };
}

interface DraggableTileProps {
  tile: Tile;
  index: number;
  floating: boolean;
  dragEnabled: boolean;
  isDragging: boolean;
  shift: Animated.ValueXY;
  dragXY: Animated.ValueXY;
  liftScale: Animated.Value;
  controller: TileDragController;
}

function DraggableTile({
  tile,
  index,
  floating,
  dragEnabled,
  isDragging,
  shift,
  dragXY,
  liftScale,
  controller,
}: DraggableTileProps) {
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => controller.pressIn(index),
        onPanResponderMove: (_evt, gesture) =>
          controller.move(gesture.dx, gesture.dy),
        onPanResponderRelease: () => controller.release(),
        onPanResponderTerminate: () => controller.terminate(),
        onPanResponderTerminationRequest: () => !controller.isDragging(),
      }),
    [controller, index],
  );

  return (
    <Animated.View
      {...(dragEnabled ? panResponder.panHandlers : {})}
      style={[
        tw.style(isDragging && 'z-10'),
        {
          transform: isDragging
            ? [...dragXY.getTranslateTransform(), { scale: liftScale }]
            : shift.getTranslateTransform(),
        },
      ]}
    >
      <View
        style={[
          tw.style(
            'w-24 items-center justify-center rounded-2xl px-2',
            // translucent scrim: readable over sky and turf without the
            // solid-white-card look
            floating ? 'bg-ink/40' : 'border border-green-100 bg-white',
            isDragging && (floating ? 'bg-ink/70' : 'border-green-300'),
          ),
          { height: TILE_HEIGHT },
        ]}
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
    </Animated.View>
  );
}

/**
 * VIEW/Trackman-style bottom data strip: one row of big tiles, clipped to the
 * screen. Null = em dash (never a fake 0); flight-model values carry est.
 * styling. The chevron expands the strip into a grid of all tiles, where
 * drag-and-drop rearranges them; the order persists in settings.
 */
export function MetricTileStrip({
  measured,
  flight,
  floating = false,
}: MetricTileStripProps) {
  const speedUnit = useSettings((s) => s.speedUnit);
  const distanceUnit = useSettings((s) => s.distanceUnit);
  const tileOrder = useSettings((s) => s.tileOrder);
  const updateSettings = useSettings((s) => s.update);
  const speed = speedUnitLabel[speedUnit];
  const distance = distanceUnitLabel[distanceUnit];

  const [expanded, setExpanded] = useState(false);
  const order = useMemo(() => sanitizeTileOrder(tileOrder), [tileOrder]);
  const commitOrder = useCallback(
    (next: MetricTileKey[]) => updateSettings({ tileOrder: next }),
    [updateSettings],
  );
  const drag = useTileDrag(order, commitOrder);

  const toggleExpanded = () => {
    if (drag.dragKey !== null) return; // never collapse under an active drag
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((current) => !current);
  };

  if (!measured) {
    return (
      <View
        style={tw.style(
          'h-20 items-center justify-center',
          floating && 'mx-6 rounded-2xl bg-ink/40',
        )}
      >
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

  const tileByKey: Record<MetricTileKey, Tile> = {
    carry: {
      label: 'Carry',
      value: formatDistance(flight?.carryM ?? null, distanceUnit),
      unit: distance,
      estimate: true,
    },
    total: {
      label: 'Total',
      value: formatDistance(flight?.totalM ?? null, distanceUnit),
      unit: distance,
      estimate: true,
    },
    ball: {
      label: 'Ball',
      value: formatSpeed(measured.ball.speedMs, speedUnit),
      unit: speed,
    },
    club: {
      label: 'Club',
      value: formatSpeed(measured.club.speedMs, speedUnit),
      unit: speed,
    },
    smash: { label: 'Smash', value: formatSmash(measured.smashFactor) },
    launch: {
      label: 'Launch',
      value: formatDegrees(measured.ball.launchAngleDeg),
    },
    direction: {
      label: 'Direction',
      value: formatDegrees(measured.ball.launchDirectionDeg),
    },
    backspin: {
      label: 'Backspin',
      value: formatSpin(measured.ball.backspinRpm),
      unit: 'rpm',
    },
    sidespin: {
      label: 'Sidespin',
      value: formatSpin(measured.ball.sidespinRpm),
      unit: 'rpm',
    },
    apex: {
      label: 'Apex',
      value: formatApexHeight(flight?.apexM ?? null, distanceUnit),
      unit: apexUnitLabel[distanceUnit],
      estimate: true,
    },
    path: { label: 'Path', value: formatDegrees(measured.club.pathDeg) },
    face: { label: 'Face', value: formatDegrees(measured.club.faceAngleDeg) },
    attack: {
      label: 'Attack',
      value: formatDegrees(measured.club.attackAngleDeg),
    },
  };

  const Chevron = expanded ? ChevronDown : ChevronUp;

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Show fewer tiles' : 'Show all tiles'}
        onPress={toggleExpanded}
        style={({ pressed }) => [
          tw.style(
            'mb-1 w-12 items-center justify-center self-center rounded-full',
            floating ? 'bg-ink/40' : 'border border-green-100 bg-white',
            pressed && 'opacity-70',
          ),
          { height: CHEVRON_HEIGHT },
        ]}
      >
        <Chevron
          color={floating ? '#ffffff' : (tw.color('silver') ?? '#6b7280')}
          size={18}
        />
      </Pressable>
      <View
        onLayout={drag.onGridLayout}
        style={tw.style(
          'flex-row gap-2 px-3 pb-1',
          expanded ? 'flex-wrap' : 'overflow-hidden',
        )}
      >
        {order.map((key, index) => (
          <DraggableTile
            key={key}
            tile={tileByKey[key]}
            index={index}
            floating={floating}
            dragEnabled={expanded}
            isDragging={drag.dragKey === key}
            shift={drag.shiftValueFor(key)}
            dragXY={drag.dragXY}
            liftScale={drag.liftScale}
            controller={drag.controller}
          />
        ))}
      </View>
    </View>
  );
}
