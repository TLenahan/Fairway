import { FailureMode, InsightShot, ReferenceBaseline } from '@golf/insights';
import { BlockTolerance } from '@golf/types';
import { z } from 'zod';

import libraryContent from '../content/drills.json';
import { Drill, DrillLibrary, DrillLibrarySchema } from './drill-content';

/**
 * The curated drill library's accessors + the §6.10 tolerance derivation.
 *
 * ONE library (§6.12 rule 1): every consumer — the prescription loop and the
 * coaching agent alike — selects a drill by `id` from this content. Nothing
 * downstream invents a drill, so the re-measure loop always has something
 * concrete to judge.
 *
 * This module deliberately does NOT decide *whether* to prescribe. §6.6 puts
 * that gate upstream: a pure bias (a systematic, repeatable offset) is an
 * aim/setup/fitting note and never earns a drill; only variance does. All
 * this module answers is "which drills are indicated for this failure mode"
 * and "what band do the user's own great shots imply for it".
 *
 * Content is parsed and validated ONCE at module load so malformed content
 * fails at app startup — loudly, naming the drill — instead of silently at
 * prescription time when a user is standing on the range.
 */

/** Just enough shape to name a drill in an error message; the real validation
    is DrillLibrarySchema. Kept separate so a drill whose `id` is itself the
    invalid field still degrades to an index rather than throwing here. */
const RawDrillIdSchema = z.object({ id: z.string().min(1) });
const RawDrillListSchema = z.object({ drills: z.array(z.unknown()) });

/** Render one zod issue as "drill "<id>": <field> — <message>" so a content
    typo points straight at the drill that carries it. */
function describeIssue(issue: z.ZodIssue, rawDrills: readonly unknown[]): string {
  const [head, index, ...rest] = issue.path;
  if (head === 'drills' && typeof index === 'number') {
    const named = RawDrillIdSchema.safeParse(rawDrills[index]);
    const who = named.success ? `"${named.data.id}"` : `#${index}`;
    const field = rest.length > 0 ? rest.join('.') : '(drill)';
    return `drill ${who}: ${field} — ${issue.message}`;
  }
  const path = issue.path.join('.');
  return `${path.length > 0 ? path : '(root)'} — ${issue.message}`;
}

/**
 * Validate raw library content. Exported so content can be linted (and the
 * failure path tested) without going through the bundled JSON.
 *
 * Duplicate ids are rejected on top of the schema: ids are the only handle
 * blocks, findings and the coach's allow-list have on a drill, so two drills
 * sharing one would make `drillById` — and every block issued through it —
 * ambiguous.
 */
export function parseDrillLibrary(content: unknown): DrillLibrary {
  const rawList = RawDrillListSchema.safeParse(content);
  const rawDrills = rawList.success ? rawList.data.drills : [];

  const parsed = DrillLibrarySchema.safeParse(content);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => describeIssue(issue, rawDrills))
      .join('; ');
    throw new Error(`Invalid drill library content: ${detail}`);
  }

  const seen = new Set<string>();
  for (const drill of parsed.data.drills) {
    if (seen.has(drill.id)) {
      throw new Error(
        `Invalid drill library content: drill "${drill.id}": id — duplicate drill id`,
      );
    }
    seen.add(drill.id);
  }

  return parsed.data;
}

/** Validated at import time — bad content is a startup crash, by design. */
const LIBRARY: DrillLibrary = parseDrillLibrary(libraryContent);

/** Every id in the library, for the coach's allow-list (§6.12 rule 1). */
export const DRILL_IDS: readonly string[] = Object.freeze(
  LIBRARY.drills.map((drill) => drill.id),
);

/** The validated library, including `libraryVersion` for block provenance. */
export function loadDrillLibrary(): DrillLibrary {
  return LIBRARY;
}

/** Copy, so a caller iterating the library can never reorder or truncate it. */
export function allDrills(): Drill[] {
  return [...LIBRARY.drills];
}

export function drillById(id: string): Drill | null {
  return LIBRARY.drills.find((drill) => drill.id === id) ?? null;
}

/**
 * Drills indicated for a failure mode, optionally narrowed to a club
 * category. An empty `clubCategories` means "all clubs"; a non-empty one is a
 * hard filter, so a wedge-only drill is never offered for an iron finding.
 *
 * `mode` is the engine's FailureMode: if the content enum ever drifts from
 * it, the `addresses.includes` below stops compiling — the tripwire that
 * keeps a drill from being unmatchable in silence.
 */
export function drillsForFailureMode(
  mode: FailureMode,
  clubCategory?: InsightShot['clubCategory'],
): Drill[] {
  return LIBRARY.drills.filter((drill) => {
    if (!drill.addresses.includes(mode)) return false;
    if (clubCategory === undefined) return true;
    if (drill.clubCategories.length === 0) return true;
    return drill.clubCategories.includes(clubCategory);
  });
}

/**
 * §6.10: the band a block is judged against comes from the USER'S OWN
 * reference baseline — the median of their great shots for the drill's target
 * metric, ± a multiple of their IQR — never a universal constant.
 *
 * Returns null (do NOT prescribe this drill) when:
 * - the baseline has no stat for the drill's target metric: without the
 *   user's own great shots on that metric there is no honest band, and an
 *   invented one would be exactly the universal constant §6.10 forbids;
 * - the IQR is degenerate (zero or non-finite): a zero-width band is
 *   unsatisfiable, so a block issued against it could only ever escalate.
 */
export function deriveTolerance(
  drill: Drill,
  reference: ReferenceBaseline,
): BlockTolerance | null {
  const stat = reference.perMetric[drill.tolerance.metric];
  if (stat === undefined) return null;
  if (!Number.isFinite(stat.iqr) || stat.iqr <= 0) return null;

  return {
    metric: drill.tolerance.metric,
    center: stat.median,
    halfWidth: drill.tolerance.iqrMultiple * stat.iqr,
    nGreat: reference.nGreat,
  };
}
