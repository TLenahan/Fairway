import { DEFAULT_TRACER_COLOR } from '@golf/types';
import { tw } from '@golf/ui';
import { useKeepAwake } from 'expo-keep-awake';
import { Menu } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  PermissionsAndroid,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MetricTileStrip } from '@/components/MetricTileStrip';
import { PracticeDrawer } from '@/components/PracticeDrawer';
import { ShotTracer } from '@/components/ShotTracer';
import { useFairwayStore, useServices } from '@/services/context';

const TILE_STRIP_HEIGHT = 96;

/**
 * Immersive practice view: the tracer photo fills the whole screen; the only
 * chrome is a floating hamburger (drawer holds connect/session/clubs/nav), a
 * status chip, and the chromeless data tiles floating along the bottom.
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
  const { data, store } = useServices();
  const connection = useFairwayStore((s) => s.connection);
  const ballReady = useFairwayStore((s) => s.ballReady);
  const lastShot = useFairwayStore((s) => s.lastShot);
  const sessionShots = useFairwayStore((s) => s.sessionShots);
  const activeClub = useFairwayStore((s) => s.activeClub);

  const latest = sessionShots[0] ?? null;

  const discardLatest = async () => {
    if (!latest) return;
    await data.setShotDiscarded(latest.id, true);
    store.setState({
      sessionShots: store
        .getState()
        .sessionShots.map((s) =>
          s.id === latest.id ? { ...s, discarded: true } : s,
        ),
      lastShot: null,
    });
  };

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
          overlayTopOffset={insets.top + 64}
          overlayBottomOffset={TILE_STRIP_HEIGHT + tilesBottom}
          tracerColor={activeClub?.tracerColor ?? DEFAULT_TRACER_COLOR}
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

      {/* discard last, floating above the tiles */}
      {latest && !latest.discarded && (
        <Pressable
          onPress={() => void discardLatest()}
          style={({ pressed }) => [
            tw.style(
              'absolute left-4 z-10 rounded-full bg-ink/60 px-3 py-1.5',
              pressed && 'opacity-70',
            ),
            { bottom: tilesBottom + TILE_STRIP_HEIGHT + 8 },
          ]}
        >
          <Text style={tw`text-xs font-medium text-white`}>Discard last</Text>
        </Pressable>
      )}

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
