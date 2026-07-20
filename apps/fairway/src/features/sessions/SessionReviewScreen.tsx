import {
  GappingView,
  GroupSeries,
  MultiGroupingView,
  TrajectoryView,
} from '@golf/viz';
import {
  Club,
  DEFAULT_TRACER_COLOR,
  Session,
  SessionSummary,
  ShotRecord,
} from '@golf/types';
import { Button, Card, SectionTitle, StatTile, tw } from '@golf/ui';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';

import {
  distanceUnitLabel,
  formatDegrees,
  formatDistance,
  formatLateral,
  formatSmash,
  formatSpeed,
  speedUnitLabel,
} from '@/lib/format';
import { useServices, useSettings } from '@/services/context';

export default function SessionReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { analytics, data } = useServices();
  const speedUnit = useSettings((s) => s.speedUnit);
  const distanceUnit = useSettings((s) => s.distanceUnit);
  const { width } = useWindowDimensions();
  const vizWidth = Math.min(width - 64, 640);

  const [session, setSession] = useState<Session | null>(null);
  const [shots, setShots] = useState<ShotRecord[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [focusClubId, setFocusClubId] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!id) return;
    void Promise.all([
      data.getSession(id),
      data.listShots(id),
      data.listClubs({ includeArchived: true }),
    ]).then(([loadedSession, loadedShots, loadedClubs]) => {
      setSession(loadedSession);
      setShots(loadedShots);
      setClubs(loadedClubs);
    });
  }, [data, id]);
  useFocusEffect(reload);

  const summary: SessionSummary | null = useMemo(() => {
    if (!session || shots.length === 0) return null;
    return analytics.summarizeSession(shots, session.environment, clubs);
  }, [analytics, session, shots, clubs]);

  const clubIdsInSession = useMemo(
    () => [...new Set(shots.map((s) => s.clubId))],
    [shots],
  );
  const focusId = focusClubId ?? clubIdsInSession[0] ?? null;
  const focusShots = shots.filter((s) => s.clubId === focusId && !s.discarded);
  const focusFlights = focusShots.flatMap((s) => (s.flight ? [s.flight] : []));
  const focusSummary = summary?.clubs.find((c) => c.clubId === focusId) ?? null;

  // one dispersion series per group, each in its group color — overlaid so
  // patterns compare directly
  const groupSeries: GroupSeries[] = useMemo(
    () =>
      (summary?.clubs ?? []).flatMap((clubSummary) => {
        const landings = shots
          .filter((s) => s.clubId === clubSummary.clubId && !s.discarded)
          .flatMap((s) => (s.flight ? [s.flight.landing] : []));
        if (landings.length === 0) return [];
        return [
          {
            clubId: clubSummary.clubId,
            color:
              clubs.find((c) => c.id === clubSummary.clubId)?.tracerColor ??
              DEFAULT_TRACER_COLOR,
            landings,
            dispersion: clubSummary.dispersion,
          },
        ];
      }),
    [summary, shots, clubs],
  );

  if (!session) {
    return (
      <View style={tw`flex-1 items-center justify-center bg-ivory`}>
        <Text style={tw`text-silver`}>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={tw`flex-1 bg-ivory`}
      contentContainerStyle={tw`p-4 pb-12`}
    >
      <View style={tw`flex-row items-center justify-between`}>
        <Text style={tw`text-lg font-semibold text-ink`}>
          {session.name ?? 'Session'} · {summary?.shotCount ?? 0} shots
        </Text>
        <Button
          label="AI analysis"
          compact
          variant="secondary"
          onPress={() => router.push(`/analysis/${session.id}`)}
        />
      </View>

      {summary && summary.gapping.length > 0 && (
        <>
          <SectionTitle title="Gapping (carry, est.)" />
          <Card>
            <GappingView
              entries={summary.gapping}
              width={vizWidth}
              unit={distanceUnit}
              colorForClub={(clubId) =>
                clubs.find((c) => c.id === clubId)?.tracerColor ?? undefined
              }
            />
          </Card>
        </>
      )}

      <SectionTitle title="Clubs" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={tw`flex-row gap-2 py-1`}>
          {clubIdsInSession.map((clubId) => {
            // (name + color) is the group identity, so two same-named groups
            // must be told apart by their swatch here
            const club = clubs.find((c) => c.id === clubId);
            const color = club?.tracerColor ?? DEFAULT_TRACER_COLOR;
            const selected = clubId === focusId;
            return (
              <Pressable
                key={clubId}
                onPress={() => setFocusClubId(clubId)}
                style={tw.style(
                  'flex-row items-center gap-2 rounded-full border px-3 py-1.5',
                  selected
                    ? 'border-green-700 bg-green-700'
                    : 'border-silver bg-white',
                )}
              >
                <View
                  style={[tw`h-3 w-3 rounded-full`, { backgroundColor: color }]}
                />
                <Text
                  style={tw.style(
                    'text-sm font-medium',
                    selected ? 'text-ivory' : 'text-ink',
                  )}
                >
                  {club?.name ?? clubId}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      {focusSummary && (
        <>
          <Card style={tw`mt-2`}>
            <View style={tw`flex-row flex-wrap justify-between gap-x-4`}>
              <StatTile
                label={`Ball (n=${focusSummary.metrics['ballSpeedMs']?.n ?? 0})`}
                value={formatSpeed(
                  focusSummary.metrics['ballSpeedMs']?.mean ?? null,
                  speedUnit,
                )}
                unit={speedUnitLabel[speedUnit]}
              />
              <StatTile
                label="Carry avg"
                value={formatDistance(
                  focusSummary.carryM?.mean ?? null,
                  distanceUnit,
                )}
                unit={distanceUnitLabel[distanceUnit]}
                estimate
              />
              <StatTile
                label="Smash"
                value={formatSmash(focusSummary.contact.smashMean)}
              />
              <StatTile
                label="Face−path"
                value={formatDegrees(focusSummary.pathFaceGapDeg)}
              />
              <StatTile
                label="Lateral σ"
                value={formatDistance(
                  focusSummary.dispersion.lateralSpreadM,
                  distanceUnit,
                  1,
                )}
                unit={distanceUnitLabel[distanceUnit]}
                estimate
              />
            </View>
          </Card>

          {focusFlights.length > 0 && (
            <>
              <SectionTitle title="Trajectories (est.)" />
              <Card>
                <TrajectoryView
                  results={focusFlights.slice(-8)}
                  width={vizWidth}
                  height={180}
                />
              </Card>
            </>
          )}
        </>
      )}

      {groupSeries.length > 0 && (
        <>
          <SectionTitle title="Grouping — all clubs (est.)" />
          <Card>
            <MultiGroupingView
              series={groupSeries}
              width={vizWidth}
              height={260}
            />
            <View style={tw`mt-2 flex-row flex-wrap gap-x-4 gap-y-1`}>
              {groupSeries.map((s) => (
                <View key={s.clubId} style={tw`flex-row items-center gap-1.5`}>
                  <View
                    style={[
                      tw`h-3 w-3 rounded-full`,
                      { backgroundColor: s.color },
                    ]}
                  />
                  <Text style={tw`text-xs text-ink`}>
                    {clubs.find((c) => c.id === s.clubId)?.name ?? s.clubId}
                  </Text>
                </View>
              ))}
            </View>
          </Card>
        </>
      )}

      <SectionTitle title="Shots" />
      {shots.map((shot, index) => (
        <View
          key={shot.id}
          style={tw.style(
            'flex-row items-center justify-between border-b border-green-100 py-2',
            shot.discarded && 'opacity-40',
          )}
        >
          <Text style={tw`w-8 text-xs text-silver`}>#{index + 1}</Text>
          <Text style={tw`flex-1 text-sm text-ink`}>
            {clubs.find((c) => c.id === shot.clubId)?.name ?? shot.clubId}
          </Text>
          <Text style={tw`flex-1 text-sm text-ink`}>
            {formatSpeed(shot.measured.ball.speedMs, speedUnit)}{' '}
            {speedUnitLabel[speedUnit]}
          </Text>
          <Text style={tw`flex-1 text-sm text-computed`}>
            {shot.flight
              ? `${formatDistance(shot.flight.carryM, distanceUnit)} ${
                  distanceUnitLabel[distanceUnit]
                } · ${formatLateral(shot.flight.offlineM, distanceUnit)} est.`
              : '—'}
          </Text>
          <Button
            label={shot.discarded ? 'Restore' : 'Discard'}
            variant="ghost"
            compact
            onPress={() => {
              void data.setShotDiscarded(shot.id, !shot.discarded).then(reload);
            }}
          />
        </View>
      ))}
    </ScrollView>
  );
}
