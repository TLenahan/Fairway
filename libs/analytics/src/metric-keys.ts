import { ShotRecord } from '@golf/types';

/**
 * Canonical metric keys for `ClubSummary.metrics`.
 *
 * - Measured keys come straight from the sensor (`shot.measured`); club-delivery
 *   metrics are null when their assurance was 0 (the null rule) and are simply
 *   absent from the stat for that shot.
 * - Computed keys (`carryM`, `totalM`, `apexM`, `offlineM`, `curveM`) are taken
 *   ONLY from `shot.flight` when the flight model has run — they are estimates
 *   and are never invented here.
 */
export const METRIC_KEYS = [
  'ballSpeedMs',
  'launchAngleDeg',
  'launchDirectionDeg',
  'backspinRpm',
  'sidespinRpm',
  'rollspinRpm',
  'clubSpeedMs',
  'clubPathDeg',
  'faceAngleDeg',
  'attackAngleDeg',
  'smashFactor',
  'carryM',
  'totalM',
  'apexM',
  'offlineM',
  'curveM',
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

/**
 * The value of one canonical metric for one shot, or `null` when it was not
 * measured (assurance-null rule) / not computed (no flight attached).
 *
 * Spin note: `MeasuredShot.ball` carries spin values as plain numbers alongside
 * `spinAssurance` (0–100). Per the assurance-null rule (BUILD_SPEC rule #4),
 * `spinAssurance === 0` means the spins were NOT measured, so all three spin
 * metrics are treated as null here rather than averaged in as garbage.
 */
export const metricValue = (
  shot: ShotRecord,
  key: MetricKey,
): number | null => {
  const { ball, club, smashFactor } = shot.measured;
  switch (key) {
    case 'ballSpeedMs':
      return ball.speedMs;
    case 'launchAngleDeg':
      return ball.launchAngleDeg;
    case 'launchDirectionDeg':
      return ball.launchDirectionDeg;
    case 'backspinRpm':
      return ball.spinAssurance > 0 ? ball.backspinRpm : null;
    case 'sidespinRpm':
      return ball.spinAssurance > 0 ? ball.sidespinRpm : null;
    case 'rollspinRpm':
      return ball.spinAssurance > 0 ? ball.rollspinRpm : null;
    case 'clubSpeedMs':
      return club.speedMs;
    case 'clubPathDeg':
      return club.pathDeg;
    case 'faceAngleDeg':
      return club.faceAngleDeg;
    case 'attackAngleDeg':
      return club.attackAngleDeg;
    case 'smashFactor':
      return smashFactor;
    case 'carryM':
      return shot.flight === null ? null : shot.flight.carryM;
    case 'totalM':
      return shot.flight === null ? null : shot.flight.totalM;
    case 'apexM':
      return shot.flight === null ? null : shot.flight.apexM;
    case 'offlineM':
      return shot.flight === null ? null : shot.flight.offlineM;
    case 'curveM':
      return shot.flight === null ? null : shot.flight.curveM;
  }
};
