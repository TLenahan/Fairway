import {
  DEFAULT_INSIGHTS_CONFIG,
  FailureMode,
  InsightMetricKey,
  InsightShot,
  InsightsConfig,
  InsightsReport,
  ReferenceBaseline,
  collectBucket,
  labelFailureModes,
  median,
  metricSeries,
} from '@golf/insights';
import { ShotIntent, TrainingBlock } from '@golf/types';

import { drillById } from './library';
import {
  BlockVerdict,
  PrescribedBlock,
  evaluateBlock,
  prescribe,
} from './prescribe';

/**
 * The composition that closes the §6.10 loop: engine report + shot history in,
 * "what to prescribe and what to judge" out.
 *
 * `prescribe` and `evaluateBlock` are deliberately narrow — each takes exactly
 * the numbers it needs and knows nothing about where they came from. This
 * module is the one place that knows how to derive those numbers from an
 * `InsightsReport` and a shot history, so the hub (and anything else driving
 * the loop) has a single call to make and cannot wire the pieces up wrongly:
 * the reference baselines and variance classifications that gate prescription
 * come from the SAME report the findings did, and the failure-mode rates that
 * decide a verdict are computed the same way on both sides of the split.
 *
 * Still pure and deterministic: `now` is a parameter, output ordering is
 * fixed, and nothing here reaches for a clock, a store, or randomness.
 */

/* ── finding keys ────────────────────────────────────────────────────────── */

/**
 * Runtime membership tables. Each is a total Record over its union, so adding
 * a metric key, failure mode or intent upstream is a compile error here rather
 * than a key that silently fails to parse — the same tripwire pattern the
 * engine uses for its metric list.
 */
const SHOT_INTENTS: Readonly<Record<ShotIntent, true>> = {
  stock: true,
  draw: true,
  fade: true,
  untagged: true,
};

const FAILURE_MODES: Readonly<Record<FailureMode, true>> = {
  pull: true,
  push: true,
  'over-curve': true,
  'under-curve': true,
  'low-smash': true,
  short: true,
  long: true,
};

const METRIC_KEYS: Readonly<Record<InsightMetricKey, true>> = {
  smash: true,
  ballSpeedMs: true,
  clubSpeedMs: true,
  launchDeg: true,
  launchDirDeg: true,
  backspinRpm: true,
  sidespinRpm: true,
  carryM: true,
  offlineM: true,
  curveM: true,
  apexM: true,
  strikeHMm: true,
  strikeVMm: true,
  wristExtTop: true,
  wristExtImpact: true,
  wristExtPeakDown: true,
};

/** Own-property test, so inherited names ('toString', 'constructor') are not
    mistaken for enum members. */
function isMember<T extends string>(
  table: Readonly<Record<T, true>>,
  value: string,
): value is T {
  return Object.prototype.hasOwnProperty.call(table, value);
}

/**
 * The inverse of `findingKey` — splits `clubId|intent|failureMode|metric`.
 *
 * Returns null rather than throwing on anything unexpected. A findingKey is
 * persisted on a block and outlives the code that wrote it: a key from an
 * older schema, a hand-edited row, or a renamed metric must degrade to "this
 * block cannot be judged automatically", never take a session down with it.
 *
 * clubIds are UUIDs and so never contain the separator, but the segment count
 * is checked anyway — the cost of being wrong about that is a mis-parsed key
 * that silently judges the wrong bucket.
 */
export function parseFindingKey(
  key: string,
): {
  clubId: string;
  intent: ShotIntent;
  failureMode: FailureMode;
  metric: InsightMetricKey;
} | null {
  const parts = key.split('|');
  if (parts.length !== 4) return null;

  const [clubId, intent, failureMode, metric] = parts;
  if (clubId.length === 0) return null;
  if (!isMember(SHOT_INTENTS, intent)) return null;
  if (!isMember(FAILURE_MODES, failureMode)) return null;
  if (!isMember(METRIC_KEYS, metric)) return null;

  return { clubId, intent, failureMode, metric };
}

/* ── the plan ────────────────────────────────────────────────────────────── */

export interface SessionPlanInput {
  /** the engine's own output — the source of findings, bands and §6.6 classes */
  report: InsightsReport;
  /** the same shot history the report was built from, for the re-measure split */
  shots: readonly InsightShot[];
  clubCategories: ReadonlyMap<string, InsightShot['clubCategory']>;
  existing: readonly TrainingBlock[];
  /** issue timestamp for new blocks, passed in so this stays pure */
  now: number;
  /** must match the config the report was produced with — it re-labels shots */
  config?: InsightsConfig;
}

export interface SessionPlan {
  /** new blocks to persist, in `prescribe`'s order */
  prescribe: PrescribedBlock[];
  /** judgments on live blocks, ordered by block id; the caller decides which
      to persist (an 'active' verdict is usually just progress, not a change) */
  verdicts: { block: TrainingBlock; verdict: BlockVerdict }[];
}

/**
 * Runs both halves of the loop over one engine report.
 *
 * PRESCRIBE: every band comes from the bucket's own `reference` baseline and
 * every §6.6 gate from that bucket's `biasVariance` entries, so the numbers
 * that decide whether a finding earns a drill are the user's own — this
 * function never invents one, and never weakens the bias gate on prescribe's
 * behalf.
 *
 * JUDGE: only blocks that are 'active', carry a parseable findingKey, and
 * resolve to a drill in the library are evaluated. A block failing any of
 * those is left strictly alone — no verdict is emitted for it. Judging it
 * would mean guessing what it was measuring, and blaming the user for a
 * broken key or a retired drill is the one thing a verdict must never do.
 */
export function planTrainingBlocks(input: SessionPlanInput): SessionPlan {
  const config = input.config ?? DEFAULT_INSIGHTS_CONFIG;

  const references = new Map<string, ReferenceBaseline>();
  const varianceDrivers = new Map<string, readonly InsightMetricKey[]>();
  for (const bucket of input.report.buckets) {
    const id = `${bucket.key.clubId}|${bucket.key.intent}`;
    if (bucket.reference !== null) references.set(id, bucket.reference);
    varianceDrivers.set(
      id,
      bucket.biasVariance
        .filter((entry) => entry.classification === 'variance-driver')
        .map((entry) => entry.metric),
    );
  }

  const prescribed = prescribe({
    findings: input.report.findings,
    references,
    varianceDrivers,
    clubCategories: input.clubCategories,
    existing: input.existing,
    now: input.now,
  });

  const verdicts: { block: TrainingBlock; verdict: BlockVerdict }[] = [];
  for (const block of input.existing) {
    if (block.status !== 'active') continue;
    if (block.findingKey === null) continue;
    const parsed = parseFindingKey(block.findingKey);
    if (parsed === null) continue;
    // The library is the only source of graduation criteria (§6.12 rule 1);
    // a drillId it no longer answers to has nothing to judge against.
    const drill = drillById(block.drillId);
    if (drill === null) continue;
    // A finding block always carries its bucket; without one there is no
    // population to re-measure over.
    if (block.clubId === null || block.intent === null) continue;

    const bucket = collectBucket(input.shots, {
      clubId: block.clubId,
      intent: block.intent,
    });

    // Same carry median findings.ts labels against: the median over the WHOLE
    // unfiltered bucket, gated at 5 values. Using one median for both windows
    // is what makes the before/after rates comparable — re-deriving it per
    // window would move the goalposts between them.
    const carries = metricSeries(bucket.shots, 'carryM');
    const carryMedian = carries.length >= 5 ? median(carries) : null;

    const before: InsightShot[] = [];
    const since: InsightShot[] = [];
    for (const shot of bucket.shots) {
      if (shot.ts > block.startedAt) since.push(shot);
      else before.push(shot);
    }

    verdicts.push({
      block,
      verdict: evaluateBlock({
        block,
        shotsSince: since,
        failureModeRateBefore: failureModeRate(
          before,
          parsed.failureMode,
          carryMedian,
          config,
        ),
        failureModeRateAfter: failureModeRate(
          since,
          parsed.failureMode,
          carryMedian,
          config,
        ),
        drill,
      }),
    });
  }

  verdicts.sort((a, b) =>
    a.block.id < b.block.id ? -1 : a.block.id > b.block.id ? 1 : 0,
  );

  return { prescribe: prescribed, verdicts };
}

/**
 * The share of a window's shots carrying a failure mode. An empty window
 * scores 0 rather than NaN — "no shots, no failures" is the honest reading,
 * and `evaluateBlock` already refuses to graduate a block whose window has
 * not filled, so a zero here can never stand in for evidence.
 */
function failureModeRate(
  window: readonly InsightShot[],
  mode: FailureMode,
  bucketCarryMedian: number | null,
  config: InsightsConfig,
): number {
  if (window.length === 0) return 0;
  let hits = 0;
  for (const shot of window) {
    if (labelFailureModes(shot, bucketCarryMedian, config).includes(mode)) {
      hits += 1;
    }
  }
  return hits / window.length;
}
