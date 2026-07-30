import { ReferenceBaseline } from '@golf/insights';

import { Drill, DrillSchema } from './drill-content';
import {
  allDrills,
  deriveTolerance,
  drillById,
  drillsForFailureMode,
  DRILL_IDS,
  loadDrillLibrary,
  parseDrillLibrary,
} from './library';

/** The ids the curated content ships with (BUILD_SPEC §6.10). Hard-coded so
    adding or renaming a drill has to be a deliberate edit here too. */
const EXPECTED_IDS = [
  'wedge-distance-control',
  'flexion-through-impact',
  'start-line-gate',
  'strike-centering',
  'tempo-ladder',
  'curve-control',
];

/** A raw (unparsed) drill object, for exercising the content failure paths.
    Deliberately a plain record so tests can plant invalid values. */
function rawDrill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test-drill',
    version: 1,
    name: 'Test drill',
    summary: 'A drill built by hand for the loader tests.',
    targets: ['carryM'],
    addresses: ['short'],
    protocol: 'Hit ten balls.',
    tolerance: { metric: 'carryM', iqrMultiple: 1 },
    graduation: {
      remeasureShots: 10,
      metricGapClosed: 0.5,
      outcomeImprovement: 0.25,
    },
    clubCategories: [],
    ...overrides,
  };
}

/** A hand-built baseline: median 24 deg, IQR 6 deg over 12 great shots. */
function referenceWith(
  perMetric: ReferenceBaseline['perMetric'],
  nGreat = 12,
): ReferenceBaseline {
  return {
    kind: 'reference',
    key: { clubId: 'sw', intent: 'stock' },
    nGreat,
    perMetric,
  };
}

/** A drill whose tolerance targets wristExtTop at an arbitrary IQR multiple. */
function toleranceDrill(iqrMultiple: number): Drill {
  return DrillSchema.parse(
    rawDrill({
      id: 'wrist-band',
      targets: ['wristExtTop'],
      tolerance: { metric: 'wristExtTop', iqrMultiple },
    }),
  );
}

describe('drill library content', () => {
  it('parses at module load and every drill re-validates', () => {
    const library = loadDrillLibrary();
    expect(library.libraryVersion).toBe(1);
    expect(library.drills).toHaveLength(EXPECTED_IDS.length);
    for (const drill of library.drills) {
      expect(DrillSchema.safeParse(drill).success).toBe(true);
    }
  });

  it('DRILL_IDS covers the content exactly, in content order', () => {
    expect(DRILL_IDS).toEqual(EXPECTED_IDS);
    expect(allDrills().map((drill) => drill.id)).toEqual(EXPECTED_IDS);
  });

  it('allDrills hands back a copy, so callers cannot mutate the library', () => {
    const first = allDrills();
    first.length = 0;
    expect(allDrills()).toHaveLength(EXPECTED_IDS.length);
  });

  it('every drill declares a tolerance metric it also targets', () => {
    for (const drill of allDrills()) {
      expect(drill.targets).toContain(drill.tolerance.metric);
    }
  });
});

describe('drillById', () => {
  it('finds a drill by id', () => {
    const drill = drillById('start-line-gate');
    expect(drill?.name).toBe('Start-line gate');
    expect(drill?.addresses).toEqual(['pull', 'push']);
  });

  it('returns null for an unknown id', () => {
    expect(drillById('no-such-drill')).toBeNull();
    expect(drillById('')).toBeNull();
  });
});

describe('drillsForFailureMode', () => {
  it('matches on addresses', () => {
    expect(drillsForFailureMode('pull').map((d) => d.id)).toEqual([
      'start-line-gate',
    ]);
    expect(drillsForFailureMode('over-curve').map((d) => d.id)).toEqual([
      'curve-control',
    ]);
    expect(drillsForFailureMode('short').map((d) => d.id)).toEqual([
      'wedge-distance-control',
      'flexion-through-impact',
      'tempo-ladder',
    ]);
  });

  it('excludes a wedge-only drill for an iron, keeps the all-club ones', () => {
    // wedge-distance-control is clubCategories: ['wedge']; the other two are
    // empty = all clubs.
    expect(drillsForFailureMode('short', 'iron').map((d) => d.id)).toEqual([
      'flexion-through-impact',
      'tempo-ladder',
    ]);
  });

  it('keeps the wedge-only drill for a wedge', () => {
    expect(drillsForFailureMode('short', 'wedge').map((d) => d.id)).toEqual([
      'wedge-distance-control',
      'flexion-through-impact',
      'tempo-ladder',
    ]);
  });

  it('returns an empty list when nothing addresses the mode for that club', () => {
    // 'long' is addressed by wedge-distance-control (wedge) and tempo-ladder
    // (all clubs); a driver keeps only the latter.
    expect(drillsForFailureMode('long', 'driver').map((d) => d.id)).toEqual([
      'tempo-ladder',
    ]);
    expect(drillsForFailureMode('pull', 'putter').map((d) => d.id)).toEqual([
      'start-line-gate',
    ]);
  });
});

describe('deriveTolerance (§6.10 — the user\'s own baseline, never a constant)', () => {
  it('centres the band on the great-shot median with halfWidth = multiple x IQR', () => {
    const reference = referenceWith({
      wristExtTop: { n: 12, median: 24, iqr: 6 },
    });

    // iqrMultiple 1 -> 1 * 6 = 6
    expect(deriveTolerance(toleranceDrill(1), reference)).toEqual({
      metric: 'wristExtTop',
      center: 24,
      halfWidth: 6,
      nGreat: 12,
    });

    // iqrMultiple 1.5 -> 1.5 * 6 = 9
    expect(deriveTolerance(toleranceDrill(1.5), reference)).toEqual({
      metric: 'wristExtTop',
      center: 24,
      halfWidth: 9,
      nGreat: 12,
    });
  });

  it('carries a negative median through unchanged (signed metrics)', () => {
    const drill = DrillSchema.parse(
      rawDrill({
        targets: ['launchDirDeg'],
        tolerance: { metric: 'launchDirDeg', iqrMultiple: 2 },
      }),
    );
    const reference = referenceWith(
      { launchDirDeg: { n: 9, median: -1.5, iqr: 0.8 } },
      9,
    );

    expect(deriveTolerance(drill, reference)).toEqual({
      metric: 'launchDirDeg',
      center: -1.5,
      halfWidth: 1.6, // 2 * 0.8
      nGreat: 9,
    });
  });

  it('uses the drill content library drill against a real baseline', () => {
    const wedgeLadder = drillById('wedge-distance-control');
    expect(wedgeLadder).not.toBeNull();
    if (wedgeLadder === null) return;

    const reference = referenceWith(
      { wristExtTop: { n: 20, median: 31, iqr: 4 } },
      20,
    );
    expect(deriveTolerance(wedgeLadder, reference)).toEqual({
      metric: 'wristExtTop', // the drill's own tolerance metric
      center: 31,
      halfWidth: 4, // iqrMultiple 1
      nGreat: 20,
    });
  });

  it('returns null when the baseline has no stat for the drill metric', () => {
    // A carry-rich baseline says nothing about the wrist angle this drill is
    // banded on — prescribing it would need an invented constant.
    const reference = referenceWith({ carryM: { n: 15, median: 80, iqr: 4 } });
    expect(deriveTolerance(toleranceDrill(1), reference)).toBeNull();
  });

  it('returns null on a degenerate IQR rather than a zero-width band', () => {
    expect(
      deriveTolerance(
        toleranceDrill(1),
        referenceWith({ wristExtTop: { n: 12, median: 24, iqr: 0 } }),
      ),
    ).toBeNull();

    expect(
      deriveTolerance(
        toleranceDrill(1),
        referenceWith({ wristExtTop: { n: 12, median: 24, iqr: -2 } }),
      ),
    ).toBeNull();

    expect(
      deriveTolerance(
        toleranceDrill(1),
        referenceWith({ wristExtTop: { n: 12, median: 24, iqr: Number.NaN } }),
      ),
    ).toBeNull();
  });
});

describe('parseDrillLibrary', () => {
  it('accepts hand-built valid content', () => {
    const library = parseDrillLibrary({
      libraryVersion: 3,
      drills: [rawDrill()],
    });
    expect(library.libraryVersion).toBe(3);
    expect(library.drills[0].id).toBe('test-drill');
  });

  it('names the offending drill id when a field is invalid', () => {
    expect(() =>
      parseDrillLibrary({
        libraryVersion: 1,
        drills: [
          rawDrill(),
          rawDrill({
            id: 'broken-drill',
            tolerance: { metric: 'carryM', iqrMultiple: -1 },
          }),
        ],
      }),
    ).toThrow(/drill "broken-drill": tolerance\.iqrMultiple/);
  });

  it('names the offending drill id when its target metric is unknown', () => {
    expect(() =>
      parseDrillLibrary({
        libraryVersion: 1,
        drills: [rawDrill({ id: 'bad-metric', targets: ['vibes'] })],
      }),
    ).toThrow(/drill "bad-metric": targets\.0/);
  });

  it('falls back to the index when the drill has no usable id', () => {
    expect(() =>
      parseDrillLibrary({
        libraryVersion: 1,
        drills: [rawDrill(), rawDrill({ id: 42 })],
      }),
    ).toThrow(/drill #1: id/);
  });

  it('rejects duplicate ids, which would make drillById ambiguous', () => {
    expect(() =>
      parseDrillLibrary({
        libraryVersion: 1,
        drills: [rawDrill(), rawDrill()],
      }),
    ).toThrow(/drill "test-drill": id — duplicate drill id/);
  });

  it('rejects content that is not a library at all', () => {
    expect(() => parseDrillLibrary({ drills: [] })).toThrow(
      /Invalid drill library content/,
    );
    expect(() => parseDrillLibrary(null)).toThrow(/Invalid drill library content/);
  });
});
