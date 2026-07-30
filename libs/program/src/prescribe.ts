import {
  Finding,
  InsightMetricKey,
  InsightShot,
  ReferenceBaseline,
  median,
  metricSeries,
} from '@golf/insights';
import { TrainingBlock, TrainingBlockStatus } from '@golf/types';

import { Drill } from './drill-content';
import { deriveTolerance, drillsForFailureMode } from './library';

/**
 * The closed prescription loop (BUILD_SPEC §6.10).
 *
 * `prescribe` turns engine findings into training blocks; `evaluateBlock`
 * closes the loop by judging a block once its re-measure window has filled.
 * Both are pure and deterministic — no clock, no randomness, no I/O — so the
 * same inputs always yield the same blocks and the same verdicts.
 *
 * Two invariants run through the whole module:
 * - §6.6: a pure bias never earns a drill. Only variance does. The gate lives
 *   in `prescribe` and is the first thing checked after de-duplication.
 * - §6.10: every band comes from the user's OWN reference baseline via
 *   `deriveTolerance`. Nothing here invents a number, and no drill is issued
 *   without a band to judge it against.
 *
 * There are no per-swing scores anywhere: a block is judged on a windowed
 * median and a windowed failure-mode rate, never on individual shots.
 */

/** A block ready to be persisted — `id` and `createdAt` belong to the store. */
export type PrescribedBlock = Omit<TrainingBlock, 'id' | 'createdAt'>;

type BucketIntent = Finding['key']['intent'];

/**
 * Stable identity for a finding: `clubId|intent|failureMode|metric`.
 *
 * The engine recomputes findings from scratch on every analysis pass, so a
 * Finding object has no persistent identity of its own. This key is derived
 * purely from what the finding IS, which lets a block issued weeks ago still
 * recognise "its" finding when it reappears — and lets `prescribe` refuse to
 * double-prescribe it.
 */
export function findingKey(f: Finding): string {
  return `${f.key.clubId}|${f.key.intent}|${f.failureMode}|${f.metric}`;
}

/** Bucket identity for the input maps — the (club, intent) pair, same shape
    as the first two segments of a finding key. */
function bucketId(clubId: string, intent: BucketIntent): string {
  return `${clubId}|${intent}`;
}

export interface PrescribeInput {
  findings: readonly Finding[];
  /** reference baselines by `${clubId}|${intent}` — the source of every band */
  references: ReadonlyMap<string, ReferenceBaseline>;
  /** metrics classified 'variance-driver' by §6.6, by `${clubId}|${intent}` */
  varianceDrivers: ReadonlyMap<string, readonly InsightMetricKey[]>;
  /** club category by clubId — narrows the library to club-appropriate drills */
  clubCategories: ReadonlyMap<string, InsightShot['clubCategory']>;
  /** blocks already on file, so a live finding is never prescribed twice */
  existing: readonly TrainingBlock[];
  /** issue timestamp, passed in so this stays a pure function */
  now: number;
}

/**
 * Emits at most ONE new block per finding.
 *
 * A finding is skipped when any of these hold:
 * 1. an existing non-abandoned block already carries its findingKey — an
 *    active, graduated or escalated block means the loop has already had its
 *    say; only an abandoned block frees the finding to be prescribed again;
 * 2. THE §6.6 BIAS GATE — the finding's metric is not among that bucket's
 *    variance drivers. A systematic, repeatable offset is an aim, setup or
 *    fitting note, and drilling it just grooves a compensation for something
 *    a one-time adjustment fixes. Only a metric whose SPREAD drives the
 *    outcome's spread earns practice time. This is the single most important
 *    check in the module and deliberately sits ahead of drill matching, so a
 *    bias can never reach the library at all;
 * 3. no drill in the library addresses that failure mode for that club
 *    category (§6.12 rule 1 — nothing here invents a drill);
 * 4. no band can be derived from the user's own reference baseline for the
 *    chosen drill (§6.10 — a block with no band could only ever escalate).
 *
 * Drill choice among matches prefers one whose `targets` includes the
 * finding's metric — that drill is aimed at the thing the finding actually
 * flagged — and breaks remaining ties on drill id so the same inputs always
 * pick the same drill. The tolerance check applies to the CHOSEN drill only:
 * silently falling back to a worse-matched drill because it happens to have a
 * baseline would prescribe practice for the wrong reason.
 *
 * Output is ordered by findingKey, independent of input order.
 */
export function prescribe(input: PrescribeInput): PrescribedBlock[] {
  const covered = new Set<string>();
  for (const block of input.existing) {
    if (block.findingKey === null) continue;
    if (block.status === 'abandoned') continue;
    covered.add(block.findingKey);
  }

  const emitted: { key: string; block: PrescribedBlock }[] = [];
  for (const finding of input.findings) {
    const key = findingKey(finding);
    if (covered.has(key)) continue;

    const bucket = bucketId(finding.key.clubId, finding.key.intent);

    // §6.6 — bias never earns a drill; only variance does.
    const drivers = input.varianceDrivers.get(bucket);
    if (drivers === undefined || !drivers.includes(finding.metric)) continue;

    const candidates = drillsForFailureMode(
      finding.failureMode,
      input.clubCategories.get(finding.key.clubId),
    );
    if (candidates.length === 0) continue;

    const drill = chooseDrill(candidates, finding.metric);

    const reference = input.references.get(bucket);
    if (reference === undefined) continue;
    const tolerance = deriveTolerance(drill, reference);
    if (tolerance === null) continue;

    // Marking it covered as we go keeps the "at most one block per finding"
    // promise even if the caller hands us the same finding twice.
    covered.add(key);
    emitted.push({
      key,
      block: {
        source: 'finding',
        findingKey: key,
        drillId: drill.id,
        drillVersion: drill.version,
        clubId: finding.key.clubId,
        intent: finding.key.intent,
        tolerance,
        remeasureShots: drill.graduation.remeasureShots,
        status: 'active',
        startedAt: input.now,
        resolvedAt: null,
        resolutionNote: null,
      },
    });
  }

  emitted.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return emitted.map((entry) => entry.block);
}

/** Targets-match first, then id — deterministic for any candidate order. */
function chooseDrill(
  candidates: readonly Drill[],
  metric: InsightMetricKey,
): Drill {
  const ranked = [...candidates].sort((a, b) => {
    const aTargets = a.targets.includes(metric) ? 0 : 1;
    const bTargets = b.targets.includes(metric) ? 0 : 1;
    if (aTargets !== bTargets) return aTargets - bTargets;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return ranked[0];
}

export interface EvaluateInput {
  block: TrainingBlock;
  /** qualifying shots in the block's bucket recorded since it was issued */
  shotsSince: readonly InsightShot[];
  /** the linked failure mode's rate over the window before the block */
  failureModeRateBefore: number;
  /** the same rate over `shotsSince` */
  failureModeRateAfter: number;
  /** the drill the block was issued against, at the block's version */
  drill: Drill;
}

export interface BlockVerdict {
  status: TrainingBlockStatus;
  note: string;
}

/**
 * Judges a block once its re-measure window has filled (§6.10).
 *
 * Graduation requires BOTH conditions — a metric that moved without the
 * outcome following is a drill that trained the wrong thing, and an outcome
 * that improved without the metric moving is luck or a compensation:
 *
 * (a) the target metric's median over `shotsSince` has closed enough of its
 *     gap to the band [center − halfWidth, center + halfWidth];
 * (b) the failure mode's rate fell by at least `outcomeImprovement`.
 *
 * APPROXIMATION, stated honestly: a block does not record the metric median
 * that was in force when it was issued, so the true issue-time gap is not
 * recoverable here. We stand in the band's own halfWidth for it — a shot
 * sitting one full half-width outside the band is the reference "gap of 1".
 * The requirement therefore reads: the current median must sit within
 * halfWidth × (1 − metricGapClosed) of the nearest band edge, with a median
 * INSIDE the band counting as a fully closed gap. This is generous to a block
 * whose issue-time gap was larger than one half-width and harsh on one whose
 * gap was smaller; recording the issue-time median on the block would remove
 * the approximation entirely.
 *
 * Returns 'active' — never 'escalated' — whenever the evidence is missing
 * rather than bad: window not yet full, no band on the block, or fewer than
 * three values of the target metric. Escalating on missing data would blame
 * the user for a sensor that did not report.
 */
export function evaluateBlock(input: EvaluateInput): BlockVerdict {
  const { block, shotsSince, drill } = input;

  if (shotsSince.length < block.remeasureShots) {
    return {
      status: 'active',
      note: `Re-measure window open: ${shotsSince.length} of ${block.remeasureShots} qualifying shots since issue.`,
    };
  }

  const tolerance = block.tolerance;
  if (tolerance === null) {
    return {
      status: 'active',
      note: 'Cannot judge: this block carries no tolerance band, so there is nothing to measure the metric against.',
    };
  }

  const metric = drill.tolerance.metric;
  if (tolerance.metric !== metric) {
    return {
      status: 'active',
      note: `Cannot judge: block band is on ${tolerance.metric} but drill ${drill.id} is banded on ${metric}.`,
    };
  }

  const values = metricSeries(shotsSince, metric);
  if (values.length < 3) {
    return {
      status: 'active',
      note: `Cannot judge: ${metric} has ${values.length} value(s) in the ${shotsSince.length} shots since issue (need 3).`,
    };
  }

  const lo = tolerance.center - tolerance.halfWidth;
  const hi = tolerance.center + tolerance.halfWidth;
  const current = median(values);
  const gap = current < lo ? lo - current : current > hi ? current - hi : 0;
  const allowedGap = tolerance.halfWidth * (1 - drill.graduation.metricGapClosed);
  const metricMoved = gap <= allowedGap;

  const before = input.failureModeRateBefore;
  const after = input.failureModeRateAfter;
  // A zero 'before' rate has no gap to close: it counts as satisfied only if
  // the mode also stayed absent. Dividing by it would give ±Infinity.
  const closed = before > 0 ? (before - after) / before : null;
  const outcomeImproved =
    closed === null ? after === 0 : closed >= drill.graduation.outcomeImprovement;

  const metricClause =
    `${metric} median ${fmt(current)} vs band [${fmt(lo)}, ${fmt(hi)}] — ` +
    `gap ${fmt(gap)}, allowed ${fmt(allowedGap)}`;
  const outcomeClause =
    `failure-mode rate ${fmt(before)} -> ${fmt(after)}` +
    (closed === null
      ? ' (no rate at issue; required it stay at zero)'
      : ` — ${fmt(closed)} closed, ${fmt(drill.graduation.outcomeImprovement)} required`);

  if (metricMoved && outcomeImproved) {
    return {
      status: 'graduated',
      note: `Graduated: ${metricClause}; ${outcomeClause}.`,
    };
  }

  const failed =
    !metricMoved && !outcomeImproved
      ? 'metric did not move and outcome did not improve'
      : metricMoved
        ? 'outcome did not improve'
        : 'metric did not move';
  return {
    status: 'escalated',
    note: `Escalated (${failed}): ${metricClause}; ${outcomeClause}.`,
  };
}

/** Two decimals everywhere, so a note reads the same on every platform. */
function fmt(x: number): string {
  return x.toFixed(2);
}
