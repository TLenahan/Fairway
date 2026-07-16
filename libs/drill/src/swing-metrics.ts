import { WristShot } from '@golf/types';

/** What the drill measures on every wrist swing event. */
export interface SwingMetrics {
  topAngleDeg: number; // Euclidean magnitude of top.rotVecDeg
  topExtensionDeg: number | null; // top.angles.extensionDeg (null uncalibrated)
  backswingMs: number; // top.tMs − address.tMs, clamped ≥ 0
  downswingMs: number; // impact.tMs − top.tMs, clamped ≥ 0
}

/**
 * Per-swing drill metrics from a wrist swing event. `topAngleDeg` is the
 * rotation-vector magnitude of the top keyframe: how far the lead wrist has
 * rotated away from address at the top, which tracks backswing length even
 * UNCALIBRATED — the raw vector is inter-IMU-relative, but its magnitude
 * still grows with swing size (see libs/types/src/wrist.ts). Anatomical
 * extension rides along only once calibration has defined it. Tempo phases
 * are clamped at 0 so a mis-ordered keyframe can't yield negative durations.
 */
export const swingMetrics = (shot: WristShot): SwingMetrics => {
  const [x, y, z] = shot.top.rotVecDeg;
  return {
    topAngleDeg: Math.hypot(x, y, z),
    topExtensionDeg: shot.top.angles.extensionDeg,
    backswingMs: Math.max(0, shot.top.tMs - shot.address.tMs),
    downswingMs: Math.max(0, shot.impact.tMs - shot.top.tMs),
  };
};
