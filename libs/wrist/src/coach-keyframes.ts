import {
  WristCalibration,
  WristCoachAngles,
  WristCoachResult,
  WristShot,
} from '@golf/types';

import { anatomicalAnglesDeg } from './calibration';
import { DEVICE_CLOCK_HZ } from './protocol';
import { qCanonical, qConj, qMul, relativeQuat } from './quaternion';
import {
  SwingDetector,
  SwingDetectorOptions,
  SwingSample,
} from './swing-detector';

/**
 * Coach-export keyframe extraction — the wrist portion of the daily
 * session-JSON export (Reform Coach agent).
 *
 * A peer CONSUMER of the same decoded sample stream the swing detector eats,
 * never a change to detection: the detector's swing event supplies two time
 * anchors (its takeaway anchor and its impact-zone trigger) and everything
 * else is re-derived from this module's own calibrated angle buffer, to the
 * export contract's definitions:
 *
 * - Setup     = per-angle MEDIAN over the last ≥ SETUP_WINDOW_MS of low angle
 *               variance before takeaway — never a single sample. The window
 *               gate is a ROBUST spread (1.4826 × MAD ≈ σ) so one glitched
 *               sample cannot poison a genuine pause; the median ignores it.
 * - Takeaway  = first departure from the setup median sustained beyond
 *               TAKEAWAY_DEPART_DEG for TAKEAWAY_DEPART_MS (either angle).
 * - Top       = first sustained extension direction-reversal between takeaway
 *               and the trigger (a re-extension in the early downswing can
 *               exceed it — that is what ext_peak_down captures).
 * - Peak down = max extension between top and impact.
 * - Impact    = THE SAMPLE at trigger + IMPACT_OFFSET_MS, on the wrist
 *               stream's own clock. Launch-monitor timestamps are never used
 *               for keyframe timing — cross-device clocks aren't synced
 *               tightly enough for the instant the wrist moves fastest.
 *
 * Omission over garbage: no qualifying pause window → the swing's whole
 * segmentation is untrusted → no block (`no_setup`). Stream inconsistency →
 * `glitch`. No calibration → `uncalibrated`. Physical-bounds gating and the
 * radial sign convention are handedness-dependent and live in the export
 * builder (@golf/analytics), not here.
 *
 * The extractor unwraps the device clock with arithmetic identical to the
 * detector's (same constants, same order, fed the same samples from the same
 * first sample), so its per-sample tDev values match the detector keyframes'
 * tDevS exactly and anchors resolve to exact buffer samples.
 */

/** address pause: minimum qualifying window (ms) */
export const SETUP_WINDOW_MS = 500;
/** address pause: max robust spread (1.4826 × MAD, ≈ σ) per angle (deg).
    Provisional pending a calibrated range capture; the failure mode is a
    dropped block, never a wrong one. */
export const SETUP_MAX_SPREAD_DEG = 2.0;
/** how far back before the detector's takeaway anchor to hunt for the pause */
export const SETUP_SEARCH_MS = 10_000;
/** window ends may sit this far past the anchor — stillness can outlive the
    detector's deepest-lull pick by a beat, but any further and the window
    tail reaches into the takeaway ramp and biases the median */
export const SETUP_ANCHOR_SLACK_MS = 100;
/** a window with fewer samples than this is too sparse to trust (BLE burst
    gaps); ~20 samples fill 500 ms at the unit's mean cadence */
export const SETUP_MIN_SAMPLES = 8;
/** collected samples must span at least this fraction of the window */
export const SETUP_MIN_SPAN_FRAC = 0.9;
/** takeaway: departure from the setup median that counts (deg) */
export const TAKEAWAY_DEPART_DEG = 3;
/** takeaway: how long the departure must sustain (ms) */
export const TAKEAWAY_DEPART_MS = 80;
/** the angle-defined takeaway may precede the detector's motion anchor by at
    most this (s). Further back means the "departure" was pre-shot fidget or a
    re-grip drift, not the swing — segmentation untrusted, drop the block. */
export const TAKEAWAY_ANCHOR_LEAD_S = 0.25;
/** top: extension move off the takeaway value that fixes the climb direction */
export const TOP_INIT_DEG = 2;
/** top: extension retreat off the running extremum that confirms reversal */
export const TOP_REVERSAL_DEG = 2;
/** impact keyframe = detector trigger + this offset (ms), tuned once. The
    trigger is the θ address-crossing during the downswing; 0 = the crossing
    sample itself. */
export const IMPACT_OFFSET_MS = 0;
/** an anchor that resolves no buffer sample within this is a stream
    inconsistency (s) */
export const IMPACT_LOCATE_TOLERANCE_S = 0.06;
/** angle buffer horizon (s) and hard cap (samples) — must outlast the pause
    search plus the longest detectable swing */
const BUFFER_HORIZON_S = 45;
const BUFFER_CAP = 4096;

export interface CoachKeyframeOptions {
  calibration?: WristCalibration | null;
  /** MUST match the paired detector's values so device-clock unwraps agree */
  deviceClockHz?: number;
  gapResyncMs?: number;
}

interface AngleSample {
  tMs: number;
  tDev: number; // device-clock seconds, detector-identical unwrap
  ext: number; // extension deg (+ = cupping)
  dev: number; // anatomical deviation deg (radial/ulnar sign resolved later)
  rot: number; // pronation/supination deg (supination sign resolved later)
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Robust spread: 1.4826 × median absolute deviation (≈ σ for a normal). */
const robustSpread = (values: number[]): number => {
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
};

const DROPPED = (
  reason: 'no_setup' | 'glitch' | 'uncalibrated',
): WristCoachResult => ({ status: 'dropped', reason });

export class CoachKeyframeExtractor {
  private calibration: WristCalibration | null;
  private readonly deviceClockHz: number;
  private readonly gapResyncMs: number;

  // device clock — identical arithmetic to SwingDetector.process
  private prevTsaRaw: number | null = null;
  private prevHostMs: number | null = null;
  private tsaUnwrapped = 0;

  private buffer: AngleSample[] = [];

  constructor(options: CoachKeyframeOptions = {}) {
    this.calibration = options.calibration ?? null;
    this.deviceClockHz = options.deviceClockHz ?? DEVICE_CLOCK_HZ;
    this.gapResyncMs = options.gapResyncMs ?? 1000;
  }

  /** Swap calibration mid-stream. Buffered angles were computed under the old
      frame and would poison any window mixing the two — drop them. */
  setCalibration(calibration: WristCalibration | null): void {
    this.calibration = calibration;
    this.buffer = [];
  }

  push(sample: SwingSample): void {
    const hostGapMs =
      this.prevHostMs === null ? 0 : sample.tMs - this.prevHostMs;
    if (hostGapMs > this.gapResyncMs) {
      // BLE stall: keep tDev roughly host-aligned (as the detector does) and
      // drop the buffer — no keyframe window may span the break
      this.tsaUnwrapped += (hostGapMs / 1000) * this.deviceClockHz;
      this.prevTsaRaw = null;
      this.buffer = [];
    } else if (hostGapMs * this.deviceClockHz > 32768 * 1000) {
      // Sub-resync stall past the u16 HALF-WRAP (512 ms at 64 kHz): the
      // detector deliberately rides this out, but the unwrap delta is now
      // ambiguous (tDev can step backward) and a setup window mixing samples
      // from both sides of the stall would export a stale median — silent
      // sub-gate poison. Clock arithmetic stays detector-identical; only the
      // angle buffer breaks, so the next swing honestly drops as no_setup
      // unless a fresh pause is observed.
      this.buffer = [];
    }
    this.prevHostMs = sample.tMs;
    if (this.prevTsaRaw !== null) {
      let delta = sample.tsa - this.prevTsaRaw;
      if (delta < -32768) delta += 65536;
      else if (delta > 32768) delta -= 65536;
      this.tsaUnwrapped += delta;
    }
    this.prevTsaRaw = sample.tsa;
    const tDev = this.tsaUnwrapped / this.deviceClockHz;

    const calibration = this.calibration;
    if (calibration === null) return;
    const qAnat = qCanonical(
      qMul(qConj(calibration.qRef), relativeQuat(sample.qA, sample.qB)),
    );
    const [ext, dev, rot] = anatomicalAnglesDeg(calibration.frame, qAnat);
    this.buffer.push({ tMs: sample.tMs, tDev, ext, dev, rot });
    while (
      this.buffer.length > BUFFER_CAP ||
      (this.buffer.length > 0 &&
        tDev - this.buffer[0].tDev > BUFFER_HORIZON_S)
    ) {
      this.buffer.shift();
    }
  }

  /** Re-derive the coach keyframes for a just-validated swing. Read-only on
      the buffer; call before the buffer outruns the swing (i.e. at the swing
      event, as the wrist service does). */
  extract(shot: WristShot): WristCoachResult {
    if (this.calibration === null) return DROPPED('uncalibrated');

    const impactAnchor = this.nearest(shot.impact.tDevS);
    if (
      impactAnchor === null ||
      Math.abs(this.buffer[impactAnchor].tDev - shot.impact.tDevS) >
        IMPACT_LOCATE_TOLERANCE_S
    ) {
      return DROPPED('glitch');
    }
    const impactIdx =
      IMPACT_OFFSET_MS === 0
        ? impactAnchor
        : this.nearest(shot.impact.tDevS + IMPACT_OFFSET_MS / 1000);
    if (impactIdx === null) return DROPPED('glitch');

    const setup = this.findSetup(shot.address.tDevS, impactIdx);
    if (setup === null) return DROPPED('no_setup');

    // The detector anchored the takeaway in the lull the swing rose out of —
    // if the angles THERE sit departed from the window median, the qualifying
    // window was some other quiet dwell (a re-grip, a pose held off the
    // ball), not this swing's address. Median from the wrong pose is poison.
    const anchorIdx = this.nearest(shot.address.tDevS);
    if (
      anchorIdx === null ||
      Math.abs(this.buffer[anchorIdx].tDev - shot.address.tDevS) >
        IMPACT_LOCATE_TOLERANCE_S ||
      Math.abs(this.buffer[anchorIdx].ext - setup.extMedian) >
        TAKEAWAY_DEPART_DEG ||
      Math.abs(this.buffer[anchorIdx].dev - setup.devMedian) >
        TAKEAWAY_DEPART_DEG ||
      Math.abs(this.buffer[anchorIdx].rot - setup.rotMedian) >
        TAKEAWAY_DEPART_DEG
    ) {
      return DROPPED('no_setup');
    }

    const takeawayIdx = this.findTakeaway(setup.endIdx, impactIdx, setup);
    if (
      takeawayIdx === null ||
      this.buffer[takeawayIdx].tDev <
        shot.address.tDevS - TAKEAWAY_ANCHOR_LEAD_S
    ) {
      return DROPPED('no_setup');
    }

    const topIdx = this.findTop(takeawayIdx, impactIdx, setup.extMedian);
    let peakDownExt = -Infinity;
    for (let i = topIdx; i <= impactIdx; i += 1) {
      if (this.buffer[i].ext > peakDownExt) peakDownExt = this.buffer[i].ext;
    }

    const at = (i: number): WristCoachAngles => ({
      extensionDeg: this.buffer[i].ext,
      deviationDeg: this.buffer[i].dev,
      rotationDeg: this.buffer[i].rot,
    });
    const keyframes = {
      setup: {
        extensionDeg: setup.extMedian,
        deviationDeg: setup.devMedian,
        rotationDeg: setup.rotMedian,
      },
      top: at(topIdx),
      impact: at(impactIdx),
      peakDownExtensionDeg: peakDownExt,
    };
    const finite = [
      ...Object.values(keyframes.setup),
      ...Object.values(keyframes.top),
      ...Object.values(keyframes.impact),
      keyframes.peakDownExtensionDeg,
    ].every(Number.isFinite);
    if (!finite) return DROPPED('glitch');
    return { status: 'ok', keyframes };
  }

  /* ────────────────────── internals ────────────────────── */

  /** Buffer index nearest to tDev, or null when the buffer is empty. */
  private nearest(tDev: number): number | null {
    if (this.buffer.length === 0) return null;
    let best = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const delta = Math.abs(this.buffer[i].tDev - tDev);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    }
    return best;
  }

  /** The LAST qualifying pause window ending at or just past the detector's
      takeaway anchor: walk window-ends backward until one passes the robust
      spread gate on both angles. */
  private findSetup(
    anchorTDev: number,
    impactIdx: number,
  ): {
    endIdx: number;
    extMedian: number;
    devMedian: number;
    rotMedian: number;
  } | null {
    const latestEnd = anchorTDev + SETUP_ANCHOR_SLACK_MS / 1000;
    const earliestEnd = anchorTDev - SETUP_SEARCH_MS / 1000;
    for (let e = impactIdx; e >= 0; e -= 1) {
      const end = this.buffer[e];
      if (end.tDev > latestEnd) continue;
      if (end.tDev < earliestEnd) break;
      const windowStart = end.tDev - SETUP_WINDOW_MS / 1000;
      const ext: number[] = [];
      const dev: number[] = [];
      const rot: number[] = [];
      let firstTDev = end.tDev;
      for (let i = e; i >= 0 && this.buffer[i].tDev >= windowStart; i -= 1) {
        ext.push(this.buffer[i].ext);
        dev.push(this.buffer[i].dev);
        rot.push(this.buffer[i].rot);
        firstTDev = this.buffer[i].tDev;
      }
      if (
        ext.length < SETUP_MIN_SAMPLES ||
        end.tDev - firstTDev <
          (SETUP_MIN_SPAN_FRAC * SETUP_WINDOW_MS) / 1000
      ) {
        continue;
      }
      if (
        robustSpread(ext) > SETUP_MAX_SPREAD_DEG ||
        robustSpread(dev) > SETUP_MAX_SPREAD_DEG ||
        robustSpread(rot) > SETUP_MAX_SPREAD_DEG
      ) {
        continue;
      }
      return {
        endIdx: e,
        extMedian: median(ext),
        devMedian: median(dev),
        rotMedian: median(rot),
      };
    }
    return null;
  }

  /** First sample after the window whose departure from the setup median
      (either angle) sustains beyond the threshold — the contract's takeaway. */
  private findTakeaway(
    setupEndIdx: number,
    impactIdx: number,
    setup: { extMedian: number; devMedian: number; rotMedian: number },
  ): number | null {
    let runStart = -1;
    for (let i = setupEndIdx + 1; i <= impactIdx; i += 1) {
      const s = this.buffer[i];
      const departed =
        Math.abs(s.ext - setup.extMedian) > TAKEAWAY_DEPART_DEG ||
        Math.abs(s.dev - setup.devMedian) > TAKEAWAY_DEPART_DEG ||
        Math.abs(s.rot - setup.rotMedian) > TAKEAWAY_DEPART_DEG;
      if (!departed) {
        runStart = -1;
        continue;
      }
      if (runStart === -1) runStart = i;
      if ((s.tDev - this.buffer[runStart].tDev) * 1000 > TAKEAWAY_DEPART_MS) {
        return runStart;
      }
    }
    return null;
  }

  /** First sustained extension direction-reversal in [takeaway, impact]. A
      trace that never reverses (pure-flexion move straight into impact)
      resolves to its extension extremum instead. */
  private findTop(
    takeawayIdx: number,
    impactIdx: number,
    setupExtMedian: number,
  ): number {
    const startExt = this.buffer[takeawayIdx].ext;
    let dir = 0;
    let extremumIdx = takeawayIdx;
    for (let i = takeawayIdx; i <= impactIdx; i += 1) {
      const ext = this.buffer[i].ext;
      if (dir === 0) {
        if (ext - startExt >= TOP_INIT_DEG) dir = 1;
        else if (startExt - ext >= TOP_INIT_DEG) dir = -1;
        if (dir !== 0) extremumIdx = i;
        continue;
      }
      if (dir * (ext - this.buffer[extremumIdx].ext) >= 0) {
        extremumIdx = i;
      } else if (
        dir * (this.buffer[extremumIdx].ext - ext) >=
        TOP_REVERSAL_DEG
      ) {
        return extremumIdx;
      }
    }
    if (dir !== 0) return extremumIdx;
    // direction never established: the largest excursion off the setup median
    let best = takeawayIdx;
    for (let i = takeawayIdx; i <= impactIdx; i += 1) {
      if (
        Math.abs(this.buffer[i].ext - setupExtMedian) >
        Math.abs(this.buffer[best].ext - setupExtMedian)
      ) {
        best = i;
      }
    }
    return best;
  }
}

/** A timestamped calibration change, e.g. from a capture's `context` lines —
    applied to detector AND extractor exactly as the live service does. */
export interface CoachCalibrationEvent {
  tMs: number;
  calibration: WristCalibration | null;
}

/** Batch convenience mirroring detectSwings: the same detector + extractor
    composition the live wrist service runs, for capture replay and offline
    export tooling. Every returned swing carries a coach result. A capture
    spanning a recalibration must pass the changes as `calibrationEvents`, or
    later swings would replay under a stale frame — silent poison. */
export function detectSwingsWithCoach(
  samples: SwingSample[],
  options?: SwingDetectorOptions,
  calibrationEvents: CoachCalibrationEvent[] = [],
): WristShot[] {
  const extractor = new CoachKeyframeExtractor({
    calibration: options?.calibration ?? null,
    deviceClockHz: options?.deviceClockHz,
    gapResyncMs: options?.gapResyncMs,
  });
  const out: WristShot[] = [];
  const detector = new SwingDetector(
    {
      onSwing: (shot) => out.push({ ...shot, coach: extractor.extract(shot) }),
    },
    options,
  );
  const events = [...calibrationEvents].sort((a, b) => a.tMs - b.tMs);
  let next = 0;
  for (const sample of samples) {
    while (next < events.length && events[next].tMs <= sample.tMs) {
      detector.setCalibration(events[next].calibration);
      extractor.setCalibration(events[next].calibration);
      next += 1;
    }
    extractor.push(sample);
    detector.push(sample);
  }
  detector.flush();
  return out;
}
