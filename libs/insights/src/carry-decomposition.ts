import { InsightsConfig } from './config';
import { standardizedOls } from './stats';
import { CarryDecomposition, InsightShot, UnfilteredBucket } from './types';

/**
 * Carry-variance decomposition (BUILD_SPEC §6.7).
 *
 * Regresses carryM (standardized) on four standardized delivery predictors
 * — clubSpeedMs, smash, launchDeg, backspinRpm — over shots where all five
 * are non-null. The resulting |beta| magnitudes are grouped into three
 * physically-meaningful buckets and normalized to sum to 1:
 *   - speed:      |beta_clubSpeedMs|
 *   - smash:      |beta_smash|
 *   - launchSpin: |beta_launchDeg| + |beta_backspinRpm|
 * `dominant` is whichever of those three shares is largest (ties broken in
 * speed > smash > launchSpin order, so the result is deterministic).
 *
 * Returns { n, r2: null, shares: null, dominant: null } when there aren't
 * enough usable shots, when the design is singular (e.g. two predictors
 * planted collinear), or in the degenerate case where every beta is exactly
 * zero (nothing to normalize). `untagged` is quarantine — returns n: 0 and
 * the same all-null shape without inspecting shots.
 */

type UsableShot = InsightShot & {
  carryM: number;
  clubSpeedMs: number;
  smash: number;
};

const isUsable = (shot: InsightShot): shot is UsableShot =>
  shot.carryM !== null && shot.clubSpeedMs !== null && shot.smash !== null;

const NULL_RESULT = (
  key: UnfilteredBucket['key'],
  n: number,
): CarryDecomposition => ({ key, n, r2: null, shares: null, dominant: null });

export function decomposeCarryVariance(
  bucket: UnfilteredBucket,
  config: InsightsConfig,
): CarryDecomposition {
  if (bucket.key.intent === 'untagged') return NULL_RESULT(bucket.key, 0);

  const usable = bucket.shots.filter(isUsable);
  const n = usable.length;
  if (n < config.carryDecomposition.minShots) return NULL_RESULT(bucket.key, n);

  const y = usable.map((s) => s.carryM);
  const xs = [
    usable.map((s) => s.clubSpeedMs),
    usable.map((s) => s.smash),
    usable.map((s) => s.launchDeg),
    usable.map((s) => s.backspinRpm),
  ];

  const result = standardizedOls(y, xs);
  if (result === null) return NULL_RESULT(bucket.key, n);

  const [betaSpeed, betaSmash, betaLaunch, betaBackspin] = result.beta;
  const speed = Math.abs(betaSpeed);
  const smash = Math.abs(betaSmash);
  const launchSpin = Math.abs(betaLaunch) + Math.abs(betaBackspin);
  const sum = speed + smash + launchSpin;
  if (sum === 0) return { key: bucket.key, n, r2: result.r2, shares: null, dominant: null };

  const shares = { speed: speed / sum, smash: smash / sum, launchSpin: launchSpin / sum };
  const dominant: CarryDecomposition['dominant'] =
    shares.speed >= shares.smash && shares.speed >= shares.launchSpin
      ? 'speed'
      : shares.smash >= shares.launchSpin
        ? 'smash'
        : 'launchSpin';

  return { key: bucket.key, n, r2: result.r2, shares, dominant };
}
