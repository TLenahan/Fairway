import {
  Club,
  ClubCategory,
  DEFAULT_TRACER_COLOR,
  SwingTag,
  tracerColorName,
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

/** Compact color dropdown: a button showing the current color that expands
 *  into the swatch list. */
function ColorDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange(hex: string): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={tw`flex-row items-center gap-2 rounded-xl border border-silver px-3 py-2.5`}
      >
        <View style={[tw`h-4 w-4 rounded-full`, { backgroundColor: value }]} />
        <Text style={tw`flex-1 text-base text-ink`}>
          {tracerColorName(value)}
        </Text>
        <Text style={tw`text-silver`}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      {open && (
        <View style={tw`mt-1 rounded-xl border border-green-100 bg-white`}>
          {TRACER_COLORS.map((c) => (
            <Pressable
              key={c.hex}
              onPress={() => {
                onChange(c.hex);
                setOpen(false);
              }}
              style={tw.style(
                'flex-row items-center gap-2 px-3 py-2.5',
                c.hex === value && 'bg-green-50',
              )}
            >
              <View
                style={[
                  tw`h-4 w-4 rounded-full border border-silver`,
                  { backgroundColor: c.hex },
                ]}
              />
              <Text style={tw`text-base text-ink`}>{c.name}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

/** Small radio tile for a club (selected state = green ring + fill). */
function ClubTile({
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

/**
 * Club changer (BUILD_SPEC F3 + per-club color/focus). A button opens a
 * dialog whose top is a grid of radio-tile clubs; picking one loads its
 * config into the editor below — tracer color (dropdown), display name
 * (defaults to the club's name, editable to "9 iron draw" etc.), and an
 * optional focus note fed to AI analysis. "Apply" saves any edits and
 * activates the club without ending the session; a quick-add creates a new
 * club inline.
 */
export function ClubPicker() {
  const { data } = useServices();
  const activeClub = useFairwayStore((s) => s.activeClub);
  const selectClub = useFairwayStore((s) => s.selectClub);
  const createClub = useFairwayStore((s) => s.createClub);

  const [clubs, setClubs] = useState<Club[]>([]);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(DEFAULT_TRACER_COLOR);
  const [focus, setFocus] = useState('');
  const [adding, setAdding] = useState(false);
  const [newCategory, setNewCategory] = useState<Category>('wedge');
  const [newSwing, setNewSwing] = useState<Swing>('full');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void data.listClubs().then(setClubs);
  };
  useEffect(refresh, [data, activeClub?.id, open]);

  const loadClub = (club: Club) => {
    setSelectedId(club.id);
    setAdding(false);
    setName(club.name);
    setColor(club.tracerColor ?? DEFAULT_TRACER_COLOR);
    setFocus(club.focusNote ?? '');
  };

  const openDialog = () => {
    const current = activeClub ?? null;
    if (current) loadClub(current);
    setOpen(true);
  };

  const apply = async () => {
    const club = clubs.find((c) => c.id === selectedId);
    if (!club) return;
    setBusy(true);
    setError(null);
    try {
      await data.updateClub(club.id, {
        name: name.trim() || club.name,
        tracerColor: color,
        focusNote: focus.trim() || null,
      });
      await selectClub(club.id);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitQuickAdd = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createClub({
        name: name.trim(),
        category: newCategory,
        swingTag: newCategory === 'putter' ? null : newSwing,
        loftDeg: null,
        notes: null,
        tracerColor: color,
        focusNote: focus.trim() || null,
        archived: false,
      });
      setOpen(false);
      setAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startAdd = () => {
    setAdding(true);
    setSelectedId(null);
    setName('');
    setColor(DEFAULT_TRACER_COLOR);
    setFocus('');
    setNewCategory('wedge');
    setNewSwing('full');
  };

  return (
    <View>
      <Button label={activeClub?.name ?? 'Change club'} onPress={openDialog} />

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          style={tw`flex-1 justify-center bg-ink/50 p-4`}
          onPress={() => setOpen(false)}
        >
          <Pressable
            style={tw`max-h-[88%] rounded-2xl bg-white p-4`}
            onPress={() => undefined}
          >
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={tw`mb-2 text-lg font-semibold text-ink`}>
                Change club
              </Text>

              <View style={tw`flex-row flex-wrap justify-between`}>
                {clubs.map((club) => (
                  <ClubTile
                    key={club.id}
                    club={club}
                    selected={!adding && club.id === selectedId}
                    onPress={() => loadClub(club)}
                  />
                ))}
                <Pressable
                  onPress={startAdd}
                  style={tw.style(
                    'mb-2 w-[31%] items-center justify-center rounded-xl border px-1 py-2',
                    adding
                      ? 'border-green-700 bg-green-50'
                      : 'border-dashed border-silver',
                  )}
                >
                  <Text style={tw`text-center text-xs text-green-700`}>
                    + New
                  </Text>
                </Pressable>
              </View>

              {(selectedId || adding) && (
                <View style={tw`mt-2`}>
                  {adding && (
                    <>
                      <Text style={tw`mb-1 text-xs uppercase text-silver`}>
                        Category
                      </Text>
                      <View style={tw`mb-2 flex-row flex-wrap gap-2`}>
                        {CATEGORIES.map((c) => (
                          <Pill
                            key={c}
                            label={c}
                            selected={c === newCategory}
                            onPress={() => setNewCategory(c)}
                          />
                        ))}
                      </View>
                      {newCategory !== 'putter' && (
                        <View style={tw`mb-2 flex-row gap-2`}>
                          {SWINGS.map((s) => (
                            <Pill
                              key={s}
                              label={swingLabel[s]}
                              selected={s === newSwing}
                              onPress={() => setNewSwing(s)}
                            />
                          ))}
                        </View>
                      )}
                    </>
                  )}

                  <Text style={tw`mb-1 text-xs uppercase text-silver`}>
                    Name
                  </Text>
                  <TextInput
                    style={tw`mb-3 rounded-xl border border-silver px-3 py-2.5 text-base`}
                    placeholder='e.g. "9 iron draw"'
                    value={name}
                    onChangeText={setName}
                  />

                  <Text style={tw`mb-1 text-xs uppercase text-silver`}>
                    Tracer color
                  </Text>
                  <View style={tw`mb-3`}>
                    <ColorDropdown value={color} onChange={setColor} />
                  </View>

                  <Text style={tw`mb-1 text-xs uppercase text-silver`}>
                    Focus (optional — helps AI analysis)
                  </Text>
                  <TextInput
                    style={tw`mb-3 rounded-xl border border-silver px-3 py-2.5 text-base`}
                    placeholder='e.g. "shallow the club, hold the finish"'
                    value={focus}
                    onChangeText={setFocus}
                    multiline
                  />

                  {error && (
                    <Text style={tw`mb-2 text-sm text-danger`}>{error}</Text>
                  )}
                  <View style={tw`flex-row justify-end gap-2`}>
                    <Button
                      label="Cancel"
                      variant="ghost"
                      compact
                      onPress={() => setOpen(false)}
                    />
                    <Button
                      label={adding ? 'Create & select' : 'Apply & select'}
                      compact
                      loading={busy}
                      onPress={() => void (adding ? submitQuickAdd() : apply())}
                    />
                  </View>
                </View>
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
