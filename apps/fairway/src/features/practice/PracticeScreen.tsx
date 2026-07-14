import { Button, Card, SectionTitle, tw } from '@golf/ui';
import { Link } from 'expo-router';
import { FlatList, Text, View } from 'react-native';

import { ConnectionDot } from '@/components/ConnectionDot';
import { ClubPicker } from '@/components/ClubPicker';
import { ShotMetricsGrid } from '@/components/ShotMetricsGrid';
import { ShotTracer } from '@/components/ShotTracer';
import { formatDistance, formatSpeed } from '@/lib/format';
import { useFairwayStore, useServices, useSettings } from '@/services/context';

export default function PracticeScreen() {
  const { data, store } = useServices();
  const connection = useFairwayStore((s) => s.connection);
  const ballReady = useFairwayStore((s) => s.ballReady);
  const lastShot = useFairwayStore((s) => s.lastShot);
  const sessionShots = useFairwayStore((s) => s.sessionShots);
  const session = useFairwayStore((s) => s.session);
  const startSession = useFairwayStore((s) => s.startSession);
  const endSession = useFairwayStore((s) => s.endSession);
  const environment = useSettings((s) => s.environment);
  const speedUnit = useSettings((s) => s.speedUnit);
  const distanceUnit = useSettings((s) => s.distanceUnit);

  const latest = sessionShots[0] ?? null;

  const toggleDiscard = async (shotId: string, discarded: boolean) => {
    await data.setShotDiscarded(shotId, discarded);
    store.setState({
      sessionShots: store
        .getState()
        .sessionShots.map((s) => (s.id === shotId ? { ...s, discarded } : s)),
    });
  };

  return (
    <View style={tw`flex-1 bg-ivory p-4`}>
      <View style={tw`flex-row items-center justify-between`}>
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

      <View style={tw`mt-3 flex-row items-center justify-between`}>
        <View style={tw`flex-row items-center gap-2`}>
          <View
            style={tw.style(
              'h-3 w-3 rounded-full',
              ballReady ? 'bg-green-500' : 'bg-silver',
            )}
          />
          <Text style={tw`text-sm text-ink`}>
            {ballReady ? 'Ball detected — ready' : 'No ball detected'}
          </Text>
        </View>
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

      <SectionTitle title="Club" />
      <ClubPicker />

      <SectionTitle title="Last shot" />
      <Card>
        {lastShot ? (
          <ShotMetricsGrid
            measured={lastShot}
            flight={latest?.flight ?? null}
          />
        ) : (
          <Text style={tw`py-6 text-center text-silver`}>
            Hit a ball — measured metrics appear here instantly.
          </Text>
        )}
      </Card>

      <SectionTitle title="Tracer" />
      <Card>
        <ShotTracer sessionShots={sessionShots} />
      </Card>

      <SectionTitle
        title={`Session shots${session ? ` · ${sessionShots.length}` : ''}`}
      />
      <FlatList
        style={tw`flex-1`}
        data={sessionShots}
        keyExtractor={(shot) => shot.id}
        ListEmptyComponent={
          <Text style={tw`py-4 text-center text-silver`}>
            {session
              ? 'No shots yet.'
              : 'Start a session (or just hit — a quick session opens automatically).'}
          </Text>
        }
        renderItem={({ item, index }) => (
          <View
            style={tw.style(
              'flex-row items-center justify-between border-b border-green-100 py-2',
              item.discarded && 'opacity-40',
            )}
          >
            <Text style={tw`w-8 text-xs text-silver`}>
              #{sessionShots.length - index}
            </Text>
            <Text style={tw`flex-1 text-sm text-ink`}>
              {formatSpeed(item.measured.ball.speedMs, speedUnit) ?? '—'}{' '}
              {speedUnit === 'mph' ? 'mph' : 'm/s'} ball
            </Text>
            <Text style={tw`flex-1 text-sm text-computed`}>
              {item.flight
                ? `${formatDistance(item.flight.carryM, distanceUnit)} ${
                    distanceUnit === 'yards' ? 'yd' : 'm'
                  } est.`
                : '—'}
            </Text>
            <Button
              label={item.discarded ? 'Restore' : 'Discard'}
              variant="ghost"
              compact
              onPress={() => void toggleDiscard(item.id, !item.discarded)}
            />
          </View>
        )}
      />
    </View>
  );
}
