import { ShotIntent } from '@golf/types';

import { IntentCorridor, InsightsConfig } from './config';
import { GreatShotResult, InsightShot, UnfilteredBucket } from './types';
import { median, metricSeries } from './stats';

/**
 * Great-shot classification (BUILD_SPEC §6.2).
 *
 * A shot is "great" iff every EVALUABLE criterion passes. A criterion whose
 * input data is missing is simply absent from `criteria` — it is not a
 * failure and does not block the verdict. `smash` and `startLine` are the
 * two criteria whose inputs (smash factor, launch direction) are ordinarily
 * present, so in practice they are almost always evaluated; `strike`,
 * `curveDirection`, and `carryWindow` are conditional on optional sensor
 * data / bucket size and are frequently absent.
 *
 * Dispersion/median inputs (e.g. the carry-window baseline) are always
 * drawn from the full `UnfilteredBucket.shots` — never re-filtered by
 * quality — per the cardinal-sin guard in types.ts.
 */

type TaggedIntent = Exclude<ShotIntent, 'untagged'>;

/** Mirror a right-handed-convention corridor for a left-handed shot. */
function corridorForHandedness(
  corridor: IntentCorridor,
  handedness: InsightShot['handedness'],
): IntentCorridor {
  if (handedness === 'right') return corridor;
  const [lo, hi] = corridor.startLineDeg;
  const mirroredDirection: IntentCorridor['curveDirection'] =
    corridor.curveDirection === 'either'
      ? 'either'
      : corridor.curveDirection === 'left'
        ? 'right'
        : 'left';
  return { startLineDeg: [-hi, -lo], curveDirection: mirroredDirection };
}

function lowSmashCause(
  shot: InsightShot,
  config: InsightsConfig,
): GreatShotResult['lowSmashCause'] {
  const strikeAvailable = shot.strikeHMm !== null && shot.strikeVMm !== null;
  if (!strikeAvailable) return 'ambiguous';
  const dist = Math.sqrt(shot.strikeHMm! ** 2 + shot.strikeVMm! ** 2);
  if (dist > config.greatShot.strikeContactMm) return 'contact';
  if (shot.flipFlag === true) return 'delivery';
  return 'ambiguous';
}

function classifyOne(
  shot: InsightShot,
  intent: TaggedIntent,
  config: InsightsConfig,
  carryMedian: number | null,
): GreatShotResult {
  if (shot.clubCategory === 'putter') {
    return { shotId: shot.id, great: false, criteria: {}, lowSmashCause: null };
  }

  const criteria: GreatShotResult['criteria'] = {};

  if (shot.smash !== null) {
    const ceiling = config.greatShot.smashCeiling[shot.clubCategory];
    criteria.smash = shot.smash >= ceiling * config.greatShot.smashFactor;
  }

  if (shot.strikeHMm !== null && shot.strikeVMm !== null) {
    const dist = Math.sqrt(shot.strikeHMm ** 2 + shot.strikeVMm ** 2);
    criteria.strike = dist <= config.greatShot.strikeRadiusMm;
  }

  const corridor = corridorForHandedness(
    config.greatShot.corridors[intent],
    shot.handedness,
  );
  const [lo, hi] = corridor.startLineDeg;
  criteria.startLine = shot.launchDirDeg >= lo && shot.launchDirDeg <= hi;

  if (shot.curveM !== null) {
    if (corridor.curveDirection === 'either') {
      criteria.curveDirection = true;
    } else if (corridor.curveDirection === 'left') {
      criteria.curveDirection = shot.curveM < 0;
    } else {
      criteria.curveDirection = shot.curveM > 0;
    }
  }

  if (shot.carryM !== null && carryMedian !== null) {
    const pct = config.greatShot.carryWindowPct;
    const low = carryMedian * (1 - pct);
    const high = carryMedian * (1 + pct);
    criteria.carryWindow = shot.carryM >= low && shot.carryM <= high;
  }

  const great = Object.values(criteria).every((v) => v === true);
  const cause = criteria.smash === false ? lowSmashCause(shot, config) : null;

  return { shotId: shot.id, great, criteria, lowSmashCause: cause };
}

/** Classifies every shot in the bucket (§6.2). `untagged` buckets are
    quarantine: every shot comes back great=false with empty criteria. */
export function classifyGreatShots(
  bucket: UnfilteredBucket,
  config: InsightsConfig,
): GreatShotResult[] {
  if (bucket.key.intent === 'untagged') {
    return bucket.shots.map((shot) => ({
      shotId: shot.id,
      great: false,
      criteria: {},
      lowSmashCause: null,
    }));
  }

  const intent = bucket.key.intent;
  const carries = metricSeries(bucket.shots, 'carryM');
  const carryMedian = carries.length >= 5 ? median(carries) : null;

  return bucket.shots.map((shot) =>
    classifyOne(shot, intent, config, carryMedian),
  );
}

/** The subset of the bucket's shots classified as great. */
export function greatShots(
  bucket: UnfilteredBucket,
  config: InsightsConfig,
): InsightShot[] {
  const results = classifyGreatShots(bucket, config);
  const greatIds = new Set(
    results.filter((r) => r.great).map((r) => r.shotId),
  );
  return bucket.shots.filter((shot) => greatIds.has(shot.id));
}
