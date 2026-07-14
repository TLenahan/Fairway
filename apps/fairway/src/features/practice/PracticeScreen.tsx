import { Button, tw } from '@golf/ui';
import { useKeepAwake } from 'expo-keep-awake';
import { Link } from 'expo-router';
import { Text, View } from 'react-native';

import { ConnectionDot } from '@/components/ConnectionDot';
import { ClubPicker } from '@/components/ClubPicker';
import { MetricTileStrip } from '@/components/MetricTileStrip';
import { ShotTracer } from '@/components/ShotTracer';
import { useFairwayStore, useServices, useSettings } from '@/services/context';

/**
 * Sim-style practice display (VIEW/Trackman layout): tracer fills the top of
 * the screen, measured/computed data tiles strip along the bottom. Fixed
 * layout — built to be glanced at between swings, not scrolled.
 */
export default function PracticeScreen() {
  // practice = display stays on; the LAN connection survives because the
  // screen never times out (true screen-off streaming needs a foreground
  // service — future work)
  useKeepAwake();
  const { data, store } = useServices();
  const connection = useFairwayStore((s) => s.connection);
  const ballReady = useFairwayStore((s) => s.ballReady);
  const lastShot = useFairwayStore((s) => s.lastShot);
  const sessionShots = useFairwayStore((s) => s.sessionShots);
  const session = useFairwayStore((s) => s.session);
  const startSession = useFairwayStore((s) => s.startSession);
  const endSession = useFairwayStore((s) => s.endSession);
  const environment = useSettings((s) => s.environment);

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

  return (
    <View style={tw`flex-1 bg-ivory`}>
      {/* header: connection + nav */}
      <View style={tw`flex-row items-center justify-between px-4 pt-2`}>
        {connection === 'connected' ? (
          <Link href="/connect">
            <ConnectionDot state={connection} />
          </Link>
        ) : (
          <Link href="/connect" asChild>
            <Button
              label={
                connection === 'connecting' || connection === 'discovering'
                  ? 'Connecting…'
                  : 'Connect to EYE MINI'
              }
              compact
              variant="secondary"
              onPress={() => undefined}
            />
          </Link>
        )}
        <View style={tw`flex-row items-center gap-3`}>
          <Link href="/sessions" style={tw`text-sm font-medium text-green-700`}>
            Sessions
          </Link>
          <Link href="/settings" style={tw`text-sm font-medium text-green-700`}>
            Settings
          </Link>
        </View>
      </View>

      {/* tracer fills the top portion */}
      <ShotTracer sessionShots={sessionShots} />

      {/* status strip */}
      <View style={tw`flex-row items-center justify-between px-4 py-1`}>
        <View style={tw`flex-row items-center gap-2`}>
          <View
            style={tw.style(
              'h-3 w-3 rounded-full',
              ballReady ? 'bg-green-500' : 'bg-silver',
            )}
          />
          <Text style={tw`text-xs text-ink`}>
            {ballReady ? 'Ready' : 'No ball'}
            {session ? ` · ${sessionShots.length} shots` : ''}
          </Text>
        </View>
        <View style={tw`flex-row items-center gap-2`}>
          {latest && !latest.discarded && (
            <Button
              label="Discard last"
              variant="ghost"
              compact
              onPress={() => void discardLatest()}
            />
          )}
          {session ? (
            <Button
              label="End session"
              variant="ghost"
              compact
              onPress={() => void endSession()}
            />
          ) : (
            <Button
              label="Start session"
              compact
              onPress={() => void startSession(environment)}
            />
          )}
        </View>
      </View>

      {/* club row */}
      <View style={tw`px-3`}>
        <ClubPicker />
      </View>

      {/* data tiles along the bottom */}
      <View style={tw`pb-2 pt-1`}>
        <MetricTileStrip
          measured={lastShot}
          flight={latest && !latest.discarded ? latest.flight : null}
        />
      </View>
    </View>
  );
}
