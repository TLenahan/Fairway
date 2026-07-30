import { ShotRecord } from '@golf/types';

import { DEFAULT_INSIGHTS_CONFIG, InsightsConfig } from './config';
import { InsightShot } from './types';

/**
 * The persisted-shot → engine-shot projection. Lives apart from types.ts so
 * the contract module stays dependency-free (it would otherwise cycle through
 * config.ts, which needs InsightShot's category union).
 *
 * Wrist angles come from the coach keyframes when the swing produced them —
 * those are the calibrated, full-precision anatomical angles, and the only
 * source of the peak-down extension the cast/flip signature is mined from.
 * Swings without a coach block (pre-keyframe captures, batch detection) fall
 * back to the raw keyframe angles, which are null until a calibration run.
 */
export function toInsightShot(
  shot: ShotRecord,
  clubCategory: InsightShot['clubCategory'],
  config: InsightsConfig = DEFAULT_INSIGHTS_CONFIG,
): InsightShot {
  const coach = shot.wrist?.coach;
  const keyframes = coach !== undefined && coach.status === 'ok' ? coach.keyframes : null;
  const extTop = keyframes?.top.extensionDeg ?? shot.wrist?.top.angles.extensionDeg ?? null;
  const extPeakDown = keyframes?.peakDownExtensionDeg ?? null;

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
    flipFlag: flipFlagOf(extTop, extPeakDown, config),
    wristExtTop: extTop,
    wristExtImpact:
      keyframes?.impact.extensionDeg ?? shot.wrist?.impact.angles.extensionDeg ?? null,
    wristExtPeakDown: extPeakDown,
  };
}

/**
 * Cast/flip signature: extension between top and impact spiking above the
 * extension held at the top. Null when either angle is missing — an unknown
 * flip state is never reported as "no flip" (it feeds low-smash cause
 * disambiguation, where absence must stay 'ambiguous').
 */
function flipFlagOf(
  extTop: number | null,
  extPeakDown: number | null,
  config: InsightsConfig,
): boolean | null {
  if (extTop === null || extPeakDown === null) return null;
  return extPeakDown - extTop >= config.wrist.flipExtensionMarginDeg;
}
