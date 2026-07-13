import { categoryToSensorMode, Club } from '@golf/types';

/**
 * Default club set seeded on first run (BUILD_SPEC F3). Fully editable /
 * archivable by the user afterwards.
 */
export type SeedClub = Omit<Club, 'id' | 'createdAt'>;

const club = (
  name: string,
  category: Club['category'],
  loftDeg: number | null,
): SeedClub => ({
  name,
  category,
  sensorMode: categoryToSensorMode[category],
  swingTag: 'full',
  loftDeg,
  notes: null,
  archived: false,
});

export const DEFAULT_CLUBS: SeedClub[] = [
  club('Driver', 'driver', 10.5),
  club('3 Wood', 'wood', 15),
  club('4 Hybrid', 'hybrid', 22),
  club('5 Iron', 'iron', 26),
  club('6 Iron', 'iron', 30),
  club('7 Iron', 'iron', 34),
  club('8 Iron', 'iron', 38),
  club('9 Iron', 'iron', 42),
  club('Pitching Wedge', 'wedge', 46),
  club('52° Wedge', 'wedge', 52),
  club('56° Wedge', 'wedge', 56),
  club('60° Wedge', 'wedge', 60),
  { ...club('Putter', 'putter', null), swingTag: null },
];
