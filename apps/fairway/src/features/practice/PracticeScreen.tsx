import { Club, DEFAULT_TRACER_COLOR } from '@golf/types';
import { tw } from '@golf/ui';
import { useKeepAwake } from 'expo-keep-awake';
import { Menu } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import {
  PermissionsAndroid,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  METRIC_TILE_STRIP_HEIGHT,
  MetricTileStrip,
} from '@/components/MetricTileStrip';
import { PracticeDrawer } from '@/components/PracticeDrawer';
import { ShotTracer } from '@/components/ShotTracer';
import { useFairwayStore, useServices } from '@/services/context';

/** Floating toggle chip: colored dot + label, white when toggled on. */
function TracerChip({
  label,
  dotColor,
  selected,
  onPress,
}: {
  label: string;
  dotColor?: string;
  selected: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) =>
        tw.style(
          'flex-row items-center gap-2 rounded-full px-3 py-1.5',
          selected ? 'bg-white/90' : 'bg-ink/60',
          pressed && 'opacity-70',
        )
      }
    >
      {dotColor && (
        <View
          style={[
            tw`h-2.5 w-2.5 rounded-full border border-ink/20`,
            { backgroundColor: dotColor },
          ]}
        />
      )}
      <Text
        style={tw.style(
          'text-xs font-medium',
          selected ? 'text-ink' : 'text-white',
        )}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Immersive practice view: the tracer photo fills the whole screen; the only
 * chrome is a floating hamburger (drawer holds connect/session/clubs/nav), a
 * status chip, the per-club tracer chips under it, and the chromeless data
 * tiles floating along the bottom.
 */
export default function PracticeScreen() {
  // display stays on while practicing; with the screen off the keep-alive
  // foreground service (started on connect) holds the sockets open
  useKeepAwake();
  // Android 13+: the keep-alive foreground service's notification needs this;
  // service runs either way, the notification is just hidden if denied
  useEffect(() => {
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      void PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS');
    }
  }, []);

  const insets = useSafeAreaInsets();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { data } = useServices();
  const connection = useFairwayStore((s) => s.connection);
  const ballReady = useFairwayStore((s) => s.ballReady);
  const lastShot = useFairwayStore((s) => s.lastShot);
  const sessionShots = useFairwayStore((s) => s.sessionShots);
  const activeClub = useFairwayStore((s) => s.activeClub);
  const session = useFairwayStore((s) => s.session);

  // all clubs (for chip names + arc colors); mid-session quick-adds always
  // activate the new club, so refreshing on activeClub covers them
  const [clubs, setClubs] = useState<Club[]>([]);
  useEffect(() => {
    void data.listClubs({ includeArchived: true }).then(setClubs);
  }, [data, activeClub?.id]);

  // clubs whose shots are toggled on in the tracer; empty = last shot only
  const [visibleClubIds, setVisibleClubIds] = useState<string[]>([]);
  useEffect(() => {
    setVisibleClubIds([]);
  }, [session?.id]);
  const toggleClub = (clubId: string) =>
    setVisibleClubIds((ids) =>
      ids.includes(clubId)
        ? ids.filter((id) => id !== clubId)
        : [...ids, clubId],
    );

  const clubColors = useMemo(() => {
    const map = new Map<string, string>();
    for (const club of clubs) {
      map.set(club.id, club.tracerColor ?? DEFAULT_TRACER_COLOR);
    }
    if (activeClub) {
      map.set(activeClub.id, activeClub.tracerColor ?? DEFAULT_TRACER_COLOR);
    }
    return map;
  }, [clubs, activeClub]);

  // one chip per club used this session (first-use order), active club last
  const sessionClubs = useMemo(() => {
    const byId = new Map(clubs.map((club) => [club.id, club]));
    if (activeClub) byId.set(activeClub.id, activeClub);
    const used: Club[] = [];
    const seen = new Set<string>();
    for (let i = sessionShots.length - 1; i >= 0; i--) {
      const shot = sessionShots[i];
      if (shot.discarded || shot.flight === null || seen.has(shot.clubId)) {
        continue;
      }
      seen.add(shot.clubId);
      const club = byId.get(shot.clubId);
      if (club) used.push(club);
    }
    if (activeClub && !seen.has(activeClub.id)) used.push(activeClub);
    return used;
  }, [clubs, activeClub, sessionShots]);

  const latest = sessionShots[0] ?? null;

  const statusText =
    connection === 'connected'
      ? `${activeClub?.name ?? 'No club'} · ${sessionShots.length}`
      : connection === 'connecting' || connection === 'discovering'
        ? 'Connecting…'
        : 'Not connected';

  const tilesBottom = insets.bottom + 6;

  return (
    <View style={tw`flex-1 bg-ink`}>
      {/* full-screen tracer scene */}
      <View style={tw`absolute inset-0`}>
        <ShotTracer
          sessionShots={sessionShots}
          clubColors={clubColors}
          visibleClubIds={visibleClubIds}
          overlayTopOffset={insets.top + 64}
          overlayBottomOffset={METRIC_TILE_STRIP_HEIGHT + tilesBottom}
        />
      </View>

      {/* floating hamburger */}
      <Pressable
        accessibilityRole="button"
        onPress={() => setDrawerOpen(true)}
        style={({ pressed }) => [
          tw.style(
            'absolute left-4 z-10 h-11 w-11 items-center justify-center rounded-full bg-ink/60',
            pressed && 'opacity-70',
          ),
          { top: insets.top + 8 },
        ]}
      >
        <Menu color="#ffffff" size={22} />
      </Pressable>

      {/* floating status chip */}
      <View
        style={[
          tw`absolute right-4 z-10 flex-row items-center gap-2 rounded-full bg-ink/60 px-3 py-2`,
          { top: insets.top + 12 },
        ]}
      >
        <View
          style={tw.style(
            'h-2.5 w-2.5 rounded-full',
            connection === 'connected'
              ? ballReady
                ? 'bg-green-300'
                : 'bg-gold-300'
              : 'bg-silver',
          )}
        />
        <Text style={tw`text-xs font-medium text-white`}>{statusText}</Text>
      </View>

      {/* tracer chips: last-shot mode + one per club used this session */}
      <View
        style={[
          tw`absolute right-4 z-10 items-end gap-2`,
          { top: insets.top + 52 },
        ]}
      >
        <TracerChip
          label="Last shot"
          selected={visibleClubIds.length === 0}
          onPress={() => setVisibleClubIds([])}
        />
        {sessionClubs.map((club) => (
          <TracerChip
            key={club.id}
            label={club.name}
            dotColor={club.tracerColor ?? DEFAULT_TRACER_COLOR}
            selected={visibleClubIds.includes(club.id)}
            onPress={() => toggleClub(club.id)}
          />
        ))}
      </View>

      {/* chromeless data tiles floating over the backdrop */}
      <View style={[tw`absolute inset-x-0`, { bottom: tilesBottom }]}>
        <MetricTileStrip
          measured={lastShot}
          flight={latest && !latest.discarded ? latest.flight : null}
          floating
        />
      </View>

      <PracticeDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </View>
  );
}
