import { ShotIntent } from '@golf/types';

import { DEFAULT_INSIGHTS_CONFIG } from './config';
import { InsightMetricKey, InsightShot } from './types';

/**
 * Phase 4 acceptance harness — deterministic synthetic shot generator
 * (BUILD_SPEC §3 Phase 4 / §8.4).
 *
 * Everything here is seeded: no Math.random, no Date.now(). The same
 * SyntheticBucketSpec always yields byte-identical shot arrays, and a spec
 * that differs only in `planted` consumes the PRNG identically, so the
 * planted and clean runs are per-shot twins outside the planted mutations.
 * That twin property is what the dispersion-honesty acceptance test leans
 * on: σ(with plant) vs σ(without plant) compares the exact same base draws.
 */

/** Deterministic 32-bit PRNG (mulberry32). Returns uniforms in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller over a mulberry32 stream (2 uniforms/draw). */
function gaussian(rng: () => number): number {
  const u1 = 1 - rng(); // (0, 1] — keeps log() finite
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export interface SyntheticBucketSpec {
  clubId: string;
  clubCategory: InsightShot['clubCategory'];
  intent: ShotIntent;
  sessions: number;
  shotsPerSession: number;
  carryMeanM: number;
  carrySdM: number;
  smashMean: number;
  smashSd: number;
  offlineSdM: number;
  seed: number;
  planted?: {
    /** fraction of shots planted, spread evenly across the whole stream */
    failureFraction: number;
    failureMode: 'low-smash' | 'pull';
    /** metric additionally shifted on every planted shot */
    affectedMetric: InsightMetricKey;
    /** shift in units of that metric's generation σ; positive = higher */
    shiftSigma: number;
  };
}

/* ── fixed generation constants (per-category nominals + noise σ) ── */

const BALL_SPEED_SD = 0.25; // m/s of independent ball-speed noise
const CARRY_PER_BALL_SPEED = 2; // m of carry per m/s of ball speed
const LAUNCH_DEG_SD = 1.5;
const BACKSPIN_SD = 250;
const CURVE_SD = 2;
const APEX_SD = 1.5;
const WRIST_TOP_MEAN = 22;
const WRIST_TOP_SD = 4;
const WRIST_IMPACT_MEAN = -4;
const WRIST_IMPACT_SD = 3;
const WRIST_PEAK_DOWN_MEAN = -14;
const WRIST_PEAK_DOWN_SD = 4;
const TS_BASE = 1_750_000_000_000;
const TS_STEP_MS = 45_000;

const LAUNCH_NOMINAL: Record<InsightShot['clubCategory'], number> = {
  driver: 12,
  wood: 13,
  hybrid: 16,
  iron: 20,
  wedge: 28,
  putter: 2,
};

const BACKSPIN_NOMINAL: Record<InsightShot['clubCategory'], number> = {
  driver: 2600,
  wood: 3400,
  hybrid: 4200,
  iron: 6500,
  wedge: 9200,
  putter: 100,
};

/** Right-handed corridor used for launch-direction sampling. 'untagged'
    shots borrow the stock corridor — quarantine is a tagging state, not a
    different swing. */
function corridorFor(intent: ShotIntent): [number, number] {
  const key = intent === 'untagged' ? 'stock' : intent;
  return DEFAULT_INSIGHTS_CONFIG.greatShot.corridors[key].startLineDeg;
}

/**
 * Generation σ per metric — the scale `planted.shiftSigma` multiplies.
 * Spec-driven where the spec provides the σ, fixed constants elsewhere
 * (documented approximations for derived metrics). Strike metrics are
 * generated as null and cannot host a plant.
 */
function metricGenerationSd(
  spec: SyntheticBucketSpec,
  key: InsightMetricKey,
): number {
  switch (key) {
    case 'smash':
      return spec.smashSd;
    case 'carryM':
      return spec.carrySdM;
    case 'offlineM':
      return spec.offlineSdM;
    case 'ballSpeedMs':
      return BALL_SPEED_SD;
    case 'clubSpeedMs':
      return BALL_SPEED_SD / spec.smashMean;
    case 'launchDeg':
      return LAUNCH_DEG_SD;
    case 'launchDirDeg': {
      const [lo, hi] = corridorFor(spec.intent);
      return (hi - lo) / 6; // matches the corridor-interior sampling below
    }
    case 'backspinRpm':
      return BACKSPIN_SD;
    case 'sidespinRpm':
      return Math.hypot(45 * CURVE_SD, 30); // curve-coupled + independent noise
    case 'curveM':
      return CURVE_SD;
    case 'apexM':
      return APEX_SD;
    case 'wristExtTop':
      return WRIST_TOP_SD;
    case 'wristExtImpact':
      return WRIST_IMPACT_SD;
    case 'wristExtPeakDown':
      return WRIST_PEAK_DOWN_SD;
    case 'strikeHMm':
    case 'strikeVMm':
      throw new Error(
        `cannot plant on ${key}: synthetic strike fields are null`,
      );
  }
}

/** Additive shift on a generated (non-null) metric field. */
function shiftMetric(
  shot: InsightShot,
  key: InsightMetricKey,
  delta: number,
): void {
  const current = shot[key];
  if (current === null) {
    throw new Error(`cannot plant on ${key}: generated value is null`);
  }
  shot[key] = current + delta;
}

const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

/**
 * Deterministic synthetic bucket (§8.4).
 *
 * Base shots: gaussian metrics with realistic co-variation —
 * ballSpeed = clubSpeed × smash exactly; carry weakly coupled to ball speed
 * (coupling kept weak so carry-tail shots do NOT drag process metrics with
 * them — the negative-control acceptance test depends on that); launch
 * direction sampled strictly inside the intent corridor; curve sign obeys
 * the intent (draw < 0, fade > 0, right-handed convention).
 *
 * Planted shots (evenly spread so every session sees its share):
 * - 'low-smash': smash forced to ceiling × lowSmashFactor × 0.92, ball speed
 *   recomputed as clubSpeed × plantedSmash (mechanically entailed drop);
 *   club speed and carry keep their sampled values.
 * - 'pull': launchDirDeg pushed left of the corridor's low edge by more than
 *   the start-line margin (negative = left, right-handed convention).
 * Then `affectedMetric` is shifted by shiftSigma × its generation σ.
 *
 * The PRNG draw order per shot is fixed and identical whether or not the
 * shot is planted, so specs differing only in `planted` are per-shot twins.
 */
export function generateSyntheticShots(spec: SyntheticBucketSpec): InsightShot[] {
  const rng = mulberry32(spec.seed);
  const n = spec.sessions * spec.shotsPerSession;
  const fraction = spec.planted?.failureFraction ?? 0;

  const [corridorLo, corridorHi] = corridorFor(spec.intent);
  const corridorCenter = (corridorLo + corridorHi) / 2;
  const corridorHalf = (corridorHi - corridorLo) / 2;

  const ballSpeedMean = 15 + 0.35 * spec.carryMeanM;
  const carryResidualSd = Math.sqrt(
    Math.max(
      spec.carrySdM ** 2 - (CARRY_PER_BALL_SPEED * BALL_SPEED_SD) ** 2,
      0.01,
    ),
  );

  const shots: InsightShot[] = [];
  for (let i = 0; i < n; i += 1) {
    // Fixed per-shot draw order — never varies with plant status.
    const smashG = gaussian(rng);
    const ballSpeedG = gaussian(rng);
    const carryResidG = gaussian(rng);
    const dirG = gaussian(rng);
    const curveG = gaussian(rng);
    const sideG = gaussian(rng);
    const launchG = gaussian(rng);
    const spinG = gaussian(rng);
    const apexG = gaussian(rng);
    const offlineG = gaussian(rng);
    const wristTopG = gaussian(rng);
    const wristImpactG = gaussian(rng);
    const wristPeakG = gaussian(rng);
    const spareG = gaussian(rng); // consumed by plant mutations only

    const smash = spec.smashMean + spec.smashSd * smashG;
    const ballSpeedMs = ballSpeedMean + BALL_SPEED_SD * ballSpeedG;
    const clubSpeedMs = ballSpeedMs / smash;
    const carryM =
      spec.carryMeanM +
      CARRY_PER_BALL_SPEED * (ballSpeedMs - ballSpeedMean) +
      carryResidualSd * carryResidG;

    const launchDirDeg = clamp(
      corridorCenter + (corridorHalf / 3) * dirG,
      corridorCenter - 0.9 * corridorHalf,
      corridorCenter + 0.9 * corridorHalf,
    );

    const curveMagnitude = Math.max(0.5, 5 + 1.5 * curveG);
    const intentKey = spec.intent === 'untagged' ? 'stock' : spec.intent;
    const curveM =
      intentKey === 'draw'
        ? -curveMagnitude
        : intentKey === 'fade'
          ? curveMagnitude
          : CURVE_SD * curveG;

    const shot: InsightShot = {
      id: `syn-${spec.seed}-${i}`,
      sessionId: `session-${Math.floor(i / spec.shotsPerSession)}`,
      clubId: spec.clubId,
      clubCategory: spec.clubCategory,
      intent: spec.intent,
      warmup: false,
      discarded: false,
      ts: TS_BASE + i * TS_STEP_MS,
      handedness: 'right',
      smash,
      ballSpeedMs,
      clubSpeedMs,
      launchDeg: LAUNCH_NOMINAL[spec.clubCategory] + LAUNCH_DEG_SD * launchG,
      launchDirDeg,
      backspinRpm: BACKSPIN_NOMINAL[spec.clubCategory] + BACKSPIN_SD * spinG,
      sidespinRpm: 45 * curveM + 30 * sideG,
      carryM,
      totalM: carryM + 4,
      apexM: 0.18 * carryM + APEX_SD * apexG,
      offlineM: spec.offlineSdM * offlineG,
      curveM,
      strikeHMm: null,
      strikeVMm: null,
      flipFlag: null,
      wristExtTop: WRIST_TOP_MEAN + WRIST_TOP_SD * wristTopG,
      wristExtImpact: WRIST_IMPACT_MEAN + WRIST_IMPACT_SD * wristImpactG,
      wristExtPeakDown: WRIST_PEAK_DOWN_MEAN + WRIST_PEAK_DOWN_SD * wristPeakG,
    };

    // Even spread: shot i is planted iff floor((i+1)·f) > floor(i·f).
    const planted =
      spec.planted !== undefined &&
      Math.floor((i + 1) * fraction) > Math.floor(i * fraction);

    if (planted && spec.planted !== undefined) {
      if (spec.planted.failureMode === 'low-smash') {
        const ceiling =
          DEFAULT_INSIGHTS_CONFIG.greatShot.smashCeiling[spec.clubCategory];
        const plantedSmash =
          ceiling * DEFAULT_INSIGHTS_CONFIG.failureModes.lowSmashFactor * 0.92;
        shot.smash = plantedSmash;
        shot.ballSpeedMs = clubSpeedMs * plantedSmash;
      } else {
        // 'pull': left of corridor low edge, beyond the start-line margin.
        shot.launchDirDeg =
          corridorLo -
          DEFAULT_INSIGHTS_CONFIG.failureModes.startLineMarginDeg -
          1.5 -
          Math.abs(spareG);
      }
      shiftMetric(
        shot,
        spec.planted.affectedMetric,
        spec.planted.shiftSigma *
          metricGenerationSd(spec, spec.planted.affectedMetric),
      );
    }

    shots.push(shot);
  }
  return shots;
}
