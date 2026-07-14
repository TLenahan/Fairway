import { Club, ClubCategory, SwingTag } from '@golf/types';
import { Button, Pill, tw } from '@golf/ui';
import { useEffect, useState } from 'react';
import { Modal, ScrollView, Text, TextInput, View } from 'react-native';
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

/**
 * Club selection + quick-add (BUILD_SPEC F3): switching re-tags subsequent
 * shots (the store only round-trips the sensor when the mode changes);
 * quick-add creates AND selects in a couple taps without ending the session.
 */
export function ClubPicker() {
  const { data } = useServices();
  const activeClub = useFairwayStore((s) => s.activeClub);
  const selectClub = useFairwayStore((s) => s.selectClub);
  const createClub = useFairwayStore((s) => s.createClub);

  const [clubs, setClubs] = useState<Club[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<Category>('wedge');
  const [swing, setSwing] = useState<Swing>('full');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void data.listClubs().then(setClubs);
  };
  useEffect(refresh, [data, activeClub?.id]);

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
        archived: false,
      });
      setAdding(false);
      setName('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={tw`flex-row gap-2 py-1`}>
          {clubs.map((club) => (
            <Pill
              key={club.id}
              label={club.name}
              selected={club.id === activeClub?.id}
              onPress={() => void selectClub(club.id)}
            />
          ))}
          <Pill label="+ New" onPress={() => setAdding(true)} />
        </View>
      </ScrollView>

      <Modal visible={adding} transparent animationType="fade">
        <View style={tw`flex-1 items-center justify-center bg-ink/50 p-6`}>
          <View style={tw`w-full max-w-md rounded-2xl bg-white p-5`}>
            <Text style={tw`mb-3 text-lg font-semibold text-ink`}>
              New club
            </Text>
            <TextInput
              style={tw`mb-3 rounded-xl border border-silver px-3 py-2.5 text-base`}
              placeholder='Name (e.g. "60° ½ swing")'
              value={name}
              onChangeText={setName}
              autoFocus
            />
            <View style={tw`mb-3 flex-row flex-wrap gap-2`}>
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
              <View style={tw`mb-3 flex-row gap-2`}>
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
            {error && <Text style={tw`mb-2 text-sm text-danger`}>{error}</Text>}
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
        </View>
      </Modal>
    </View>
  );
}
