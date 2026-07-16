import { MIN_FULL_REPS } from '@golf/drill';
import {
  Club,
  DEFAULT_TRACER_COLOR,
  DistanceUnit,
  DrillOutcome,
  DrillPlan,
  DrillRung,
  DrillRungPlan,
} from '@golf/types';
import { Button, Card, SectionTitle, tw } from '@golf/ui';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { z } from 'zod';

import { distanceUnitLabel, formatDistance } from '@/lib/format';
import { useFairwayStore, useServices, useSettings } from '@/services/context';
import { playCue, playOutcome } from '@/services/drill-feedback';

type Distance = z.infer<typeof DistanceUnit>;

const rungLabel: Record<DrillRung, string> = {
  full: 'Full',
  mid: 'Mid',
  low: 'Low',
};

const outcomeLabel: Record<DrillOutcome, string> = {
  match: 'Match',
  over: 'Over — backswing too long',
  under: 'Under — backswing too short',
  calibrating: 'Calibrating',
};

const outcomeColor: Record<DrillOutcome, string> = {
  match: 'text-green-700',
  over: 'text-danger',
  under: 'text-sky',
  calibrating: 'text-silver',
};

/** Signed whole-degree delta, e.g. "+7°" / "-5°". */
const signedDeg = (deg: number): string => {
  const rounded = Math.round(deg);
  return `${rounded >= 0 ? '+' : ''}${rounded}°`;
};

/** RN percent dimension — typed so it satisfies DimensionValue. */
const pctOf = (fraction: number): `${number}%` =>
  `${Math.max(0, Math.min(100, fraction * 100))}%`;

/** Radio tile for a wedge (ClubPicker's ClubTile pattern). */
function WedgeTile({
  club,
  selected,
  onPress,
}: {
  club: Club;
  selected: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={tw.style(
        'mb-2 w-[31%] items-center rounded-xl border px-1 py-2',
        selected ? 'border-green-700 bg-green-50' : 'border-silver bg-white',
      )}
    >
      <View
        style={[
          tw`mb-1 h-3 w-3 rounded-full`,
          { backgroundColor: club.tracerColor ?? DEFAULT_TRACER_COLOR },
        ]}
      />
      <Text
        numberOfLines={1}
        style={tw.style(
          'text-center text-xs',
          selected ? 'font-semibold text-green-700' : 'text-ink',
        )}
      >
        {club.name}
      </Text>
    </Pressable>
  );
}

/** One cell of the 3×3 matrix — status-aware, selected = green ring. */
function RungCell({
  plan,
  selected,
  unit,
  onPress,
}: {
  plan: DrillRungPlan;
  selected: boolean;
  unit: Distance;
  onPress(): void;
}) {
  const carry = formatDistance(plan.targetCarryM, unit);
  return (
    <Pressable
      onPress={onPress}
      style={tw.style(
        'mb-2 min-h-[84px] items-center rounded-xl border px-1 py-2',
        selected ? 'border-green-700 bg-green-50' : 'border-silver bg-white',
      )}
    >
      <Text style={tw`text-[10px] uppercase text-silver`}>
        {rungLabel[plan.rung]}
      </Text>
      {plan.status === 'collecting' && (
        <Text style={tw`mt-1 text-center text-xs text-ink`}>
          Hit {Math.max(1, MIN_FULL_REPS - plan.repCount)} more full swings
        </Text>
      )}
      {plan.status === 'needsFulls' && (
        <>
          <Text style={tw`mt-0.5 text-lg font-bold text-silver`}>—</Text>
          <Text style={tw`text-center text-[10px] text-silver`}>
            needs full swings first
          </Text>
        </>
      )}
      {plan.status === 'ready' && (
        <>
          <Text style={tw`mt-0.5 text-lg font-bold text-ink`}>
            {carry !== null ? `${carry} ${distanceUnitLabel[unit]}` : '—'}
          </Text>
          {plan.targetAngleDeg !== null && (
            <Text style={tw`text-[10px] text-silver`}>
              θ {Math.round(plan.targetAngleDeg)}° ±
              {Math.round(plan.toleranceDeg)}°
            </Text>
          )}
          {plan.carry && (
            <Text style={tw`text-[10px] text-silver`}>
              {plan.carry.n} · {formatDistance(plan.carry.meanM, unit)}±
              {formatDistance(plan.carry.sdM, unit)}
            </Text>
          )}
          {plan.cue && (
            <Text style={tw`mt-0.5 text-[10px] text-green-700`}>
              {'●'.repeat(plan.cue.beats)}○
            </Text>
          )}
        </>
      )}
    </Pressable>
  );
}

/** Horizontal floor→max carry bar: a mean±sd band per ready rung (tick at the
    target when no carries yet) in the wedge's tracer color — the coverage /
    overlap picture. Plain absolute-positioned Views. */
function LadderStrip({ plan, unit }: { plan: DrillPlan; unit: Distance }) {
  const bands: { color: string; fromM: number; toM: number }[] = [];
  const ticks: { color: string; atM: number }[] = [];
  let maxM = plan.floorM;
  for (const wedge of plan.wedges) {
    const color = wedge.club.tracerColor ?? DEFAULT_TRACER_COLOR;
    for (const rung of wedge.rungs) {
      if (rung.status !== 'ready') continue;
      if (rung.carry) {
        bands.push({
          color,
          fromM: rung.carry.meanM - rung.carry.sdM,
          toM: rung.carry.meanM + rung.carry.sdM,
        });
        maxM = Math.max(maxM, rung.carry.meanM + rung.carry.sdM);
      } else if (rung.targetCarryM !== null) {
        ticks.push({ color, atM: rung.targetCarryM });
      }
      if (rung.targetCarryM !== null) {
        maxM = Math.max(maxM, rung.targetCarryM);
      }
    }
  }
  if (bands.length === 0 && ticks.length === 0) return null;

  const span = Math.max(maxM - plan.floorM, 1);
  const pct = (m: number) => pctOf((m - plan.floorM) / span);
  return (
    <>
      <SectionTitle title="Carry coverage" />
      <View style={tw`h-6 rounded-lg border border-green-100 bg-white`}>
        {bands.map((band, i) => (
          <View
            key={`band-${i}`}
            style={[
              tw`absolute inset-y-1 rounded-sm opacity-60`,
              {
                left: pct(band.fromM),
                width: pctOf(Math.max((band.toM - band.fromM) / span, 0.01)),
                backgroundColor: band.color,
              },
            ]}
          />
        ))}
        {ticks.map((tick, i) => (
          <View
            key={`tick-${i}`}
            style={[
              tw`absolute inset-y-0.5 w-0.5 rounded-full`,
              { left: pct(tick.atM), backgroundColor: tick.color },
            ]}
          />
        ))}
      </View>
      <View style={tw`mt-1 flex-row justify-between`}>
        <Text style={tw`text-xs text-silver`}>
          {formatDistance(plan.floorM, unit)} {distanceUnitLabel[unit]}
        </Text>
        <Text style={tw`text-xs text-silver`}>
          {formatDistance(maxM, unit)} {distanceUnitLabel[unit]}
        </Text>
      </View>
    </>
  );
}

/**
 * Wedge distance-control drill (MEMORY: wedge-drill-vision). Setup picks up
 * to three wedges (persisted in settings); the drill itself is the 3×3
 * rung matrix — tap a cell to arm it, swing, and the wrist sensor's judgment
 * plays back instantly as sound + haptics while EYE MINI carries fill the
 * dispersion ladder. Leaving the screen ends the drill (unmount cleanup).
 */
export default function DrillScreen() {
  const router = useRouter();
  const { data } = useServices();
  const drill = useFairwayStore((s) => s.drill);
  const startDrill = useFairwayStore((s) => s.startDrill);
  const endDrill = useFairwayStore((s) => s.endDrill);
  const selectDrillRung = useFairwayStore((s) => s.selectDrillRung);
  const wristConnection = useFairwayStore((s) => s.wristConnection);
  const session = useFairwayStore((s) => s.session);
  const sessionShots = useFairwayStore((s) => s.sessionShots);
  const distanceUnit = useSettings((s) => s.distanceUnit);
  const drillWedgeIds = useSettings((s) => s.drillWedgeIds);
  const updateSettings = useSettings((s) => s.update);

  const [clubs, setClubs] = useState<Club[]>([]);
  const [pickingSlot, setPickingSlot] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void data.listClubs().then(setClubs);
  }, [data]);

  // back-nav is the only exit — unmount ends the drill
  useEffect(() => endDrill, [endDrill]);

  // the instant sound+haptic verdict; keyed on `at` (a fresh epoch per rep)
  // so plan recomputes that keep the same lastRep don't replay it
  const lastRep = drill?.lastRep ?? null;
  const lastRepAt = lastRep?.at ?? null;
  const lastOutcome = lastRep?.outcome ?? null;
  useEffect(() => {
    if (lastRepAt !== null && lastOutcome !== null) playOutcome(lastOutcome);
  }, [lastRepAt, lastOutcome]);

  const wedges = useMemo(
    () => clubs.filter((c) => c.category === 'wedge' && !c.archived),
    [clubs],
  );
  const slots: (Club | null)[] = useMemo(
    () =>
      Array.from(
        { length: 3 },
        (_, i) => clubs.find((c) => c.id === drillWedgeIds[i]) ?? null,
      ),
    [clubs, drillWedgeIds],
  );
  const chosenIds = slots.filter((c): c is Club => c !== null).map((c) => c.id);

  const setSlot = (slot: number, clubId: string | null) => {
    const ids: (string | null)[] = Array.from(
      { length: 3 },
      (_, i) => drillWedgeIds[i] ?? null,
    );
    // a wedge can occupy only one slot — picking it again moves it here
    const cleared = ids.map((id, i) =>
      id === clubId && i !== slot ? null : id,
    );
    cleared[slot] = clubId;
    updateSettings({
      drillWedgeIds: cleared.filter((id): id is string => id !== null),
    });
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await startDrill(chosenIds);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (clubId: string, rung: DrillRungPlan) => {
    setError(null);
    try {
      await selectDrillRung(clubId, rung.rung);
      if (rung.cue) playCue(rung.cue);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const activeCell = useMemo(() => {
    if (!drill || !drill.active) return null;
    const { clubId, rung } = drill.active;
    const wedge = drill.plan.wedges.find((w) => w.club.id === clubId) ?? null;
    const rungPlan = wedge?.rungs.find((r) => r.rung === rung) ?? null;
    return wedge && rungPlan ? { wedge, rungPlan } : null;
  }, [drill]);

  // last carry: the newest session shot, but only when it landed after the
  // judged swing (drill doesn't own shots — they keep flowing to the session)
  const lastCarryM = useMemo(() => {
    const shot = sessionShots[0] ?? null;
    if (!shot || shot.discarded || !shot.flight || lastRepAt === null) {
      return null;
    }
    return shot.capturedAt >= lastRepAt - 2000 ? shot.flight.carryM : null;
  }, [sessionShots, lastRepAt]);

  const pickerSlot = pickingSlot ?? 0;
  const pickerCurrent = slots[pickerSlot]?.id ?? null;

  return (
    <ScrollView
      style={tw`flex-1 bg-ivory`}
      contentContainerStyle={tw`p-4 pb-8`}
    >
      {drill === null ? (
        <>
          <SectionTitle title="Wedges" />
          <Text style={tw`text-sm text-silver`}>
            Pick the wedges to train — three builds the full 9-shot matrix.
          </Text>
          <View style={tw`mt-3 flex-row gap-2`}>
            {slots.map((club, i) => (
              <Pressable
                key={i}
                onPress={() => setPickingSlot(i)}
                style={tw.style(
                  'flex-1 items-center rounded-xl border px-1 py-3',
                  club
                    ? 'border-green-700 bg-green-50'
                    : 'border-dashed border-silver bg-white',
                )}
              >
                {club ? (
                  <>
                    <View
                      style={[
                        tw`mb-1 h-3 w-3 rounded-full`,
                        {
                          backgroundColor:
                            club.tracerColor ?? DEFAULT_TRACER_COLOR,
                        },
                      ]}
                    />
                    <Text
                      numberOfLines={1}
                      style={tw`text-center text-xs font-semibold text-green-700`}
                    >
                      {club.name}
                    </Text>
                  </>
                ) : (
                  <Text style={tw`py-1 text-center text-xs text-silver`}>
                    + Choose wedge
                  </Text>
                )}
              </Pressable>
            ))}
          </View>
          <View style={tw`mt-4`}>
            <Button
              label="Start drill"
              loading={busy}
              disabled={chosenIds.length === 0}
              onPress={() => void start()}
            />
          </View>
        </>
      ) : (
        <>
          {wristConnection !== 'connected' && (
            <Card style={tw`mb-3 border-warning`}>
              <Text style={tw`font-semibold text-ink`}>
                Wrist sensor not connected — angle feedback is off
              </Text>
              <View style={tw`mt-2 self-start`}>
                <Button
                  label="Connect wrist sensor"
                  variant="secondary"
                  compact
                  onPress={() => router.push('/connect')}
                />
              </View>
            </Card>
          )}

          {activeCell && (
            <Card style={tw`mb-3`}>
              <View style={tw`flex-row items-center justify-between`}>
                <Text style={tw`text-xs uppercase text-silver`}>
                  {activeCell.wedge.club.name} ·{' '}
                  {rungLabel[activeCell.rungPlan.rung]}
                </Text>
                {activeCell.rungPlan.cue && (
                  <Button
                    label="Replay cue"
                    variant="ghost"
                    compact
                    onPress={() => {
                      const { cue } = activeCell.rungPlan;
                      if (cue) playCue(cue);
                    }}
                  />
                )}
              </View>
              {lastRep ? (
                <>
                  <View style={tw`flex-row items-end gap-2`}>
                    <Text
                      style={tw.style(
                        'text-4xl font-bold',
                        outcomeColor[lastRep.outcome],
                      )}
                    >
                      {Math.round(lastRep.topAngleDeg)}°
                    </Text>
                    {lastRep.targetAngleDeg !== null && (
                      <Text style={tw`pb-1 text-base text-silver`}>
                        target {Math.round(lastRep.targetAngleDeg)}°
                      </Text>
                    )}
                    {lastRep.deltaDeg !== null && (
                      <Text
                        style={tw.style(
                          'pb-1 text-base font-semibold',
                          outcomeColor[lastRep.outcome],
                        )}
                      >
                        {signedDeg(lastRep.deltaDeg)}
                      </Text>
                    )}
                  </View>
                  <Text
                    style={tw.style(
                      'mt-1 text-sm font-semibold',
                      outcomeColor[lastRep.outcome],
                    )}
                  >
                    {outcomeLabel[lastRep.outcome]}
                    {lastCarryM !== null
                      ? ` · carry ${formatDistance(lastCarryM, distanceUnit)} ${distanceUnitLabel[distanceUnit]}`
                      : ''}
                  </Text>
                </>
              ) : (
                <Text style={tw`mt-1 text-sm text-silver`}>
                  Awaiting swing…
                </Text>
              )}
            </Card>
          )}

          <SectionTitle title="The 9 shots" />
          <View style={tw`flex-row gap-2`}>
            {drill.plan.wedges.map((wedge) => (
              <View key={wedge.club.id} style={tw`flex-1`}>
                <View
                  style={tw`mb-1 flex-row items-center justify-center gap-1.5`}
                >
                  <View
                    style={[
                      tw`h-2.5 w-2.5 rounded-full`,
                      {
                        backgroundColor:
                          wedge.club.tracerColor ?? DEFAULT_TRACER_COLOR,
                      },
                    ]}
                  />
                  <Text
                    numberOfLines={1}
                    style={tw`text-xs font-semibold text-ink`}
                  >
                    {wedge.club.name}
                  </Text>
                </View>
                {wedge.rungs.map((rung) => (
                  <RungCell
                    key={rung.rung}
                    plan={rung}
                    selected={
                      drill.active?.clubId === wedge.club.id &&
                      drill.active?.rung === rung.rung
                    }
                    unit={distanceUnit}
                    onPress={() => void pick(wedge.club.id, rung)}
                  />
                ))}
              </View>
            ))}
          </View>

          <LadderStrip plan={drill.plan} unit={distanceUnit} />

          {session && (
            <Text style={tw`mt-3 text-xs text-silver`}>
              Recording to session · {sessionShots.length} shots
            </Text>
          )}
        </>
      )}

      {error && <Text style={tw`mt-3 text-sm text-danger`}>{error}</Text>}

      <Modal
        visible={pickingSlot !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPickingSlot(null)}
      >
        <Pressable
          style={tw`flex-1 justify-center bg-ink/50 p-4`}
          onPress={() => setPickingSlot(null)}
        >
          <Pressable
            style={tw`max-h-[88%] rounded-2xl bg-white p-4`}
            onPress={() => undefined}
          >
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={tw`mb-2 text-lg font-semibold text-ink`}>
                Choose wedge
              </Text>
              {wedges.length === 0 ? (
                <Text style={tw`text-sm text-silver`}>
                  No wedges yet — add them from the practice club picker.
                </Text>
              ) : (
                <View style={tw`flex-row flex-wrap justify-between`}>
                  {wedges.map((club) => (
                    <WedgeTile
                      key={club.id}
                      club={club}
                      selected={club.id === pickerCurrent}
                      onPress={() => {
                        setSlot(pickerSlot, club.id);
                        setPickingSlot(null);
                      }}
                    />
                  ))}
                </View>
              )}
              <View style={tw`mt-2 flex-row justify-end gap-2`}>
                {pickerCurrent !== null && (
                  <Button
                    label="Clear slot"
                    variant="ghost"
                    compact
                    onPress={() => {
                      setSlot(pickerSlot, null);
                      setPickingSlot(null);
                    }}
                  />
                )}
                <Button
                  label="Cancel"
                  variant="ghost"
                  compact
                  onPress={() => setPickingSlot(null)}
                />
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}
