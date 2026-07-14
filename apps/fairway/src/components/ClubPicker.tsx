import {
  Club,
  ClubCategory,
  DEFAULT_TRACER_COLOR,
  SwingTag,
  TRACER_COLORS,
} from '@golf/types';
import { Button, Pill, tw } from '@golf/ui';
import { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { z } from 'zod';

import { useFairwayStore, useServices } from '@/services/context';

type Category = z.infer<typeof ClubCategory>;
type Swing = z.infer<typeof SwingTag>;

const CATEGORIES: Category[] = [
  'driver',
  'wood',
  'hybrid',
  'iron',
  'wedge',
  'putter',
];
const SWINGS: Swing[] = ['full', 'three_quarter', 'half', 'chip'];
const swingLabel: Record<Swing, string> = {
  full: 'Full',
  three_quarter: '¾',
  half: '½',
  chip: 'Chip',
};

/** Row of selectable color swatches; the chosen one gets a ring. */
function ColorRow({
  value,
  onPick,
}: {
  value: string;
  onPick(color: string): void;
}) {
  return (
    <View style={tw`flex-row flex-wrap gap-2`}>
      {TRACER_COLORS.map((color) => (
        <Pressable
          key={color}
          onPress={() => onPick(color)}
          style={tw.style(
            'h-8 w-8 rounded-full border-2',
            value === color ? 'border-ink' : 'border-transparent',
          )}
        >
          <View
            style={[tw`h-full w-full rounded-full`, { backgroundColor: color }]}
          />
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Club selection dialog (BUILD_SPEC F3 + per-club tracer color): the trigger
 * shows the active club and its color; the dialog lists clubs (tap to select
 * + activate), lets each club's tracer color be changed inline, and quick-adds
 * a new club (name + category + swing + color) without ending the session.
 */
export function ClubPicker() {
  const { data } = useServices();
  const activeClub = useFairwayStore((s) => s.activeClub);
  const selectClub = useFairwayStore((s) => s.selectClub);
  const createClub = useFairwayStore((s) => s.createClub);

  const [clubs, setClubs] = useState<Club[]>([]);
  const [open, setOpen] = useState(false);
  const [expandedClubId, setExpandedClubId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<Category>('wedge');
  const [swing, setSwing] = useState<Swing>('full');
  const [newColor, setNewColor] = useState<string>(DEFAULT_TRACER_COLOR);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void data.listClubs().then(setClubs);
  };
  useEffect(refresh, [data, activeClub?.id, open]);

  const pick = (clubId: string) => {
    void selectClub(clubId);
    setOpen(false);
  };

  const setClubColor = async (club: Club, color: string) => {
    await data.updateClub(club.id, { tracerColor: color });
    refresh();
  };

  const submitQuickAdd = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createClub({
        name: name.trim(),
        category,
        swingTag: category === 'putter' ? null : swing,
        loftDeg: null,
        notes: null,
        tracerColor: newColor,
        archived: false,
      });
      setAdding(false);
      setName('');
      setNewColor(DEFAULT_TRACER_COLOR);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) =>
          tw.style(
            'flex-row items-center gap-2 rounded-xl border border-silver bg-white px-3 py-2.5',
            pressed && 'opacity-70',
          )
        }
      >
        <View
          style={[
            tw`h-4 w-4 rounded-full`,
            {
              backgroundColor: activeClub?.tracerColor ?? DEFAULT_TRACER_COLOR,
            },
          ]}
        />
        <Text style={tw`flex-1 text-base font-medium text-ink`}>
          {activeClub?.name ?? 'Select club'}
        </Text>
        <Text style={tw`text-silver`}>▾</Text>
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          style={tw`flex-1 justify-center bg-ink/50 p-5`}
          onPress={() => setOpen(false)}
        >
          <Pressable
            style={tw`max-h-[80%] rounded-2xl bg-white p-4`}
            onPress={() => undefined}
          >
            <Text style={tw`mb-2 text-lg font-semibold text-ink`}>Clubs</Text>
            <ScrollView>
              {clubs.map((club) => {
                const color = club.tracerColor ?? DEFAULT_TRACER_COLOR;
                const expanded = expandedClubId === club.id;
                return (
                  <View
                    key={club.id}
                    style={tw`border-b border-green-100 py-1`}
                  >
                    <View style={tw`flex-row items-center`}>
                      <Pressable
                        onPress={() => pick(club.id)}
                        style={tw`flex-1 flex-row items-center gap-2 py-2`}
                      >
                        <View
                          style={[
                            tw`h-4 w-4 rounded-full`,
                            { backgroundColor: color },
                          ]}
                        />
                        <Text
                          style={tw.style(
                            'text-base',
                            club.id === activeClub?.id
                              ? 'font-semibold text-green-700'
                              : 'text-ink',
                          )}
                        >
                          {club.name}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() =>
                          setExpandedClubId(expanded ? null : club.id)
                        }
                        style={tw`px-2 py-2`}
                      >
                        <Text style={tw`text-xs text-green-700`}>
                          {expanded ? 'Done' : 'Color'}
                        </Text>
                      </Pressable>
                    </View>
                    {expanded && (
                      <View style={tw`pb-2`}>
                        <ColorRow
                          value={color}
                          onPick={(c) => void setClubColor(club, c)}
                        />
                      </View>
                    )}
                  </View>
                );
              })}
            </ScrollView>

            {adding ? (
              <View style={tw`mt-3`}>
                <TextInput
                  style={tw`mb-2 rounded-xl border border-silver px-3 py-2.5 text-base`}
                  placeholder='Name (e.g. "60° ½ swing")'
                  value={name}
                  onChangeText={setName}
                  autoFocus
                />
                <View style={tw`mb-2 flex-row flex-wrap gap-2`}>
                  {CATEGORIES.map((c) => (
                    <Pill
                      key={c}
                      label={c}
                      selected={c === category}
                      onPress={() => setCategory(c)}
                    />
                  ))}
                </View>
                {category !== 'putter' && (
                  <View style={tw`mb-2 flex-row gap-2`}>
                    {SWINGS.map((s) => (
                      <Pill
                        key={s}
                        label={swingLabel[s]}
                        selected={s === swing}
                        onPress={() => setSwing(s)}
                      />
                    ))}
                  </View>
                )}
                <Text style={tw`mb-1 text-xs uppercase text-silver`}>
                  Tracer color
                </Text>
                <View style={tw`mb-2`}>
                  <ColorRow value={newColor} onPick={setNewColor} />
                </View>
                {error && (
                  <Text style={tw`mb-2 text-sm text-danger`}>{error}</Text>
                )}
                <View style={tw`flex-row justify-end gap-2`}>
                  <Button
                    label="Cancel"
                    variant="ghost"
                    compact
                    onPress={() => setAdding(false)}
                  />
                  <Button
                    label="Create & select"
                    compact
                    loading={busy}
                    onPress={() => void submitQuickAdd()}
                  />
                </View>
              </View>
            ) : (
              <Button
                label="+ New club"
                variant="ghost"
                onPress={() => setAdding(true)}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
