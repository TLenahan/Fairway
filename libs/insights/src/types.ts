import { Handedness, ShotIntent, ShotRecord } from '@golf/types';
import { z } from 'zod';

/**
 * @golf/insights — the analytics engine's contract (BUILD_SPEC §6).
 *
 * Everything in this lib is a pure, deterministic function over InsightShot
 * arrays + InsightsConfig. No I/O, no Date.now(), no randomness. The LLM
 * layer NEVER computes here; this engine NEVER narrates.
 *
 * Design philosophy enforced in types:
 * - There are no per-swing scores anywhere. Outputs are windowed stats,
 *   counts, and classifications.
 * - The dispersion baseline is computed over UNFILTERED buckets only —
 *   see UnfilteredBucket's brand. Filtering bad shots out of dispersion is
 *   the cardinal sin of the codebase.
 */

type Handed = z.infer<typeof Handedness>;

/** Engine-facing projection of a persisted shot. Null = not measured. */
export interface InsightShot {
  id: string;
  sessionId: string;
  clubId: string;
  clubCategory: 'driver' | 'wood' | 'hybrid' | 'iron' | 'wedge' | 'putter';
  intent: ShotIntent;
  warmup: boolean;
  discarded: boolean;
  ts: number;
  handedness: Handed;
  smash: number | null;
  ballSpeedMs: number;
  clubSpeedMs: number | null;
  launchDeg: number;
  launchDirDeg: number; // negative = left
  backspinRpm: number;
  sidespinRpm: number; // positive = right
  carryM: number | null;
  totalM: number | null;
  apexM: number | null;
  offlineM: number | null; // negative = left of target line
  curveM: number | null; // signed perpendicular from start-line ray, + = right
  /** strike location when available (sensor or CV) — optional field, §1 */
  strikeHMm: number | null;
  strikeVMm: number | null;
  /** wrist-sourced release flags/metrics when a swing was joined */
  flipFlag: boolean | null;
  wristExtTop: number | null;
  wristExtImpact: number | null;
  wristExtPeakDown: number | null;
}

export function toInsightShot(
  shot: ShotRecord,
  clubCategory: InsightShot['clubCategory'],
): InsightShot {
  return {
    id: shot.id,
    sessionId: shot.sessionId,
    clubId: shot.clubId,
    clubCategory,
    intent: shot.intent,
    warmup: shot.warmup,
    discarded: shot.discarded,
    ts: shot.capturedAt,
    handedness: shot.measured.handedness,
    smash: shot.measured.smashFactor,
    ballSpeedMs: shot.measured.ball.speedMs,
    clubSpeedMs: shot.measured.club.speedMs,
    launchDeg: shot.measured.ball.launchAngleDeg,
    launchDirDeg: shot.measured.ball.launchDirectionDeg,
    backspinRpm: shot.measured.ball.backspinRpm,
    sidespinRpm: shot.measured.ball.sidespinRpm,
    carryM: shot.flight?.carryM ?? null,
    totalM: shot.flight?.totalM ?? null,
    apexM: shot.flight?.apexM ?? null,
    offlineM: shot.flight?.offlineM ?? null,
    curveM: shot.flight?.curveM ?? null,
    strikeHMm: shot.measured.club.faceImpactHMm,
    strikeVMm: shot.measured.club.faceImpactVMm,
    flipFlag: null,
    wristExtTop: shot.wrist?.top.angles.extensionDeg ?? null,
    wristExtImpact: shot.wrist?.impact.angles.extensionDeg ?? null,
    wristExtPeakDown: null,
  };
}

/** Bucket key — the unit of every baseline and finding (§6.1). */
export interface BucketKey {
  clubId: string;
  intent: ShotIntent;
}

/**
 * The type-level cardinal-sin guard (§6.3): dispersion statistics accept
 * ONLY this branded collection, and the ONLY constructor is
 * `collectBucket`, which filters exclusively on bucket membership, warmup,
 * and discarded — never on quality. There is no other way to mint the brand.
 */
export interface UnfilteredBucket {
  readonly kind: 'unfiltered-bucket';
  readonly key: BucketKey;
  readonly shots: readonly InsightShot[];
}

/** The only brand mint. `untagged` intent is quarantine: callers may build
    its bucket for retro-tagging UIs, but baseline/trend functions must skip
    it (they check `key.intent !== 'untagged'`). */
export function collectBucket(
  shots: readonly InsightShot[],
  key: BucketKey,
): UnfilteredBucket {
  return {
    kind: 'unfiltered-bucket',
    key,
    shots: shots.filter(
      (s) =>
        s.clubId === key.clubId &&
        s.intent === key.intent &&
        !s.warmup &&
        !s.discarded,
    ),
  };
}

/* ── great-shot classification (§6.2) ── */

export type GreatCriterion = 'smash' | 'strike' | 'startLine' | 'curveDirection' | 'carryWindow';

export interface GreatShotResult {
  shotId: string;
  great: boolean;
  /** criterion → pass/fail; absent = not evaluable (missing data) */
  criteria: Partial<Record<GreatCriterion, boolean>>;
  /** low smash disambiguation (§6.2): null when smash passed or unknown */
  lowSmashCause: 'contact' | 'delivery' | 'ambiguous' | null;
}

/* ── baselines (§6.3/6.4) ── */

export interface MetricStat {
  n: number;
  median: number;
  iqr: number;
}

export interface ReferenceBaseline {
  kind: 'reference';
  key: BucketKey;
  nGreat: number;
  perMetric: Partial<Record<InsightMetricKey, MetricStat>>;
}

export interface DispersionBaseline {
  kind: 'dispersion';
  key: BucketKey;
  nTotal: number;
  carrySigma: number | null;
  offlineSigma: number | null;
  smashSigma: number | null;
  strikeScatterMm: number | null;
  perMetric: Partial<Record<InsightMetricKey, number>>; // sigma per metric
}

export type CertificationStatus = 'uncertified' | 'certified' | 'contact-before-shapes';

export interface Certification {
  key: BucketKey;
  status: CertificationStatus;
  nGreat: number;
  nTotal: number;
  greatRate: number | null;
  sigmaStable: boolean | null; // null until enough shots to test
}

export type ChangepointVerdict = 'new-swing' | 'bad-day' | null;

export interface ChangepointResult {
  key: BucketKey;
  verdict: ChangepointVerdict;
  centerShifted: boolean;
  dispersionSpiked: boolean;
}

/* ── findings (§6.5) ── */

export type FailureMode =
  | 'pull'
  | 'push'
  | 'over-curve'
  | 'under-curve'
  | 'low-smash'
  | 'short'
  | 'long';

export interface Finding {
  key: BucketKey;
  failureMode: FailureMode;
  metric: InsightMetricKey;
  effectSize: number; // Cohen's d, bad vs great
  direction: 'higher' | 'lower'; // bad bucket relative to great bucket
  pApprox: number; // rank-sum normal approximation
  sessionsSeen: number;
  counts: { bad: number; great: number; badBeyondGreatRange: number };
  firstSeenTs: number;
  lastSeenTs: number;
}

/* ── bias vs variance (§6.6) ── */

export interface BiasVarianceEntry {
  metric: InsightMetricKey;
  classification: 'bias' | 'variance-driver' | 'neutral';
  meanOffset: number | null; // for bias: systematic offset
  sigma: number | null;
  outcomeCorrelation: number | null; // |r| vs outcome dispersion, variance path
}

/* ── carry decomposition (§6.7) ── */

export interface CarryDecomposition {
  key: BucketKey;
  n: number;
  r2: number | null;
  shares: { speed: number; smash: number; launchSpin: number } | null;
  dominant: 'speed' | 'smash' | 'launchSpin' | null;
}

/* ── dispersion index (§6.8) ── */

export interface DispersionIndex {
  key: BucketKey;
  n: number;
  value: number | null; // windowed composite; null below minimum n
  components: {
    carrySigmaPct: number | null;
    offlineSigmaM: number | null;
    smashSigma: number | null;
    strikeScatterMm: number | null;
  };
}

/** Metric keys findings/baselines mine over — accessor map in metrics.ts. */
export type InsightMetricKey =
  | 'smash'
  | 'ballSpeedMs'
  | 'clubSpeedMs'
  | 'launchDeg'
  | 'launchDirDeg'
  | 'backspinRpm'
  | 'sidespinRpm'
  | 'carryM'
  | 'offlineM'
  | 'curveM'
  | 'apexM'
  | 'strikeHMm'
  | 'strikeVMm'
  | 'wristExtTop'
  | 'wristExtImpact'
  | 'wristExtPeakDown';
