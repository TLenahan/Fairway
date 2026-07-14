import { Baseline, BaselineSet, ClubCategory } from '@golf/types';
import { z } from 'zod';

/**
 * Curated, CITED reference numbers (BUILD_SPEC §10.4). STRICT SOURCING RULE:
 * an entry exists only when the number is attributable to a published source
 * — an absent baseline is correct behavior (the gap simply isn't claimed),
 * and Claude never generates or estimates baseline numbers.
 *
 * Values are converted to this app's SI metric keys (m/s, deg, rpm, meters)
 * from TrackMan's published PGA Tour averages: club speed / ball speed /
 * launch / spin / carry per club. Source: "TrackMan Average Tour Stats",
 * TrackMan A/S, blog.trackmangolf.com (2017 dataset — the widely republished
 * tour-average table). Conversions: mph × 0.44704 = m/s; yd × 0.9144 = m.
 *
 * Only 'tour' level ships in v1; add more levels ONLY with citations.
 */
const TRACKMAN_TOUR = {
  citation: 'TrackMan Average Tour Stats (PGA Tour), TrackMan A/S, 2017',
  url: 'https://blog.trackmangolf.com/trackman-average-tour-stats/',
};

const entry = (
  category: z.infer<typeof ClubCategory>,
  metrics: Record<string, number>,
): Baseline => ({
  category,
  level: 'tour',
  source: TRACKMAN_TOUR,
  metrics,
});

export const CURATED_BASELINES: Baseline[] = [
  // Driver: 113 mph club, 167 mph ball, 10.9° launch, 2686 rpm, 275 yd carry
  entry('driver', {
    clubSpeedMs: 50.52,
    ballSpeedMs: 74.66,
    launchAngleDeg: 10.9,
    backspinRpm: 2686,
    carryM: 251.5,
    smashFactor: 1.48,
  }),
  // 7-iron: 90 mph club, 120 mph ball, 16.3° launch, 7097 rpm, 172 yd carry
  entry('iron', {
    clubSpeedMs: 40.23,
    ballSpeedMs: 53.64,
    launchAngleDeg: 16.3,
    backspinRpm: 7097,
    carryM: 157.3,
    smashFactor: 1.33,
  }),
  // Pitching wedge: 83 mph club, 102 mph ball, 24.2° launch, 9304 rpm, 136 yd
  entry('wedge', {
    clubSpeedMs: 37.1,
    ballSpeedMs: 45.6,
    launchAngleDeg: 24.2,
    backspinRpm: 9304,
    carryM: 124.4,
    smashFactor: 1.23,
  }),
];

/** BaselineSet over the curated data. Returns null rather than guessing. */
export function createBaselineSet(
  baselines: Baseline[] = CURATED_BASELINES,
): BaselineSet {
  return {
    get(category, level) {
      return (
        baselines.find((b) => b.category === category && b.level === level) ??
        null
      );
    },
    list() {
      return [...baselines];
    },
  };
}
