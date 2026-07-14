import { DataStore } from '@golf/types';

import { DEFAULT_CLUBS } from './seed';

/** Seeds the default club set exactly once (no-op when any club exists). */
export async function seedDefaultClubs(store: DataStore): Promise<void> {
  const existing = await store.listClubs({ includeArchived: true });
  if (existing.length > 0) return;
  for (const club of DEFAULT_CLUBS) {
    await store.createClub({
      name: club.name,
      category: club.category,
      swingTag: club.swingTag,
      loftDeg: club.loftDeg,
      notes: club.notes,
      tracerColor: club.tracerColor,
      archived: club.archived,
    });
  }
}
