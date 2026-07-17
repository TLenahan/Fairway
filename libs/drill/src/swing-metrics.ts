import { WristShot } from '@golf/types';

/** What the drill measures on every wrist swing event. */
export interface SwingMetrics {
  topAngleDeg: number; // |top.rotVecFromAddressDeg| — wrist change from setup
  topExtensionDeg: number | null; // top.angles.extensionDeg (null uncalibrated)
  backswingMs: number; // device-clock, takeaway → top
  downswingMs: number; // device-clock, top → impact zone
}

/**
 * Per-swing drill metrics from a wrist swing event. `topAngleDeg` is how far
 * the wrist rotated away from THIS swing's address hold by the top — anchored
 * to the golfer's own setup, so it is meaningful without any calibration and
 * immune to strap offset. Anatomical extension rides along only once
 * calibration has defined it. Tempo comes from the detector's device-clock
 * phase durations, not BLE arrival time.
 */
export const swingMetrics = (shot: WristShot): SwingMetrics => {
  const [x, y, z] = shot.top.rotVecFromAddressDeg;
  return {
    topAngleDeg: Math.hypot(x, y, z),
    topExtensionDeg: shot.top.angles.extensionDeg,
    backswingMs: shot.backswingMs,
    downswingMs: shot.downswingMs,
  };
};
