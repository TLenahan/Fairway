import {
  WristAngles,
  WristCalibration,
  WristHold,
  WristKeyframe,
  WristPhaseEvent,
  WristShot,
} from '@golf/types';

import { anatomicalAnglesDeg } from './calibration';
import { DEVICE_CLOCK_HZ } from './protocol';
import {
  gravityTiltDeg,
  markleyAverage,
  qCanonical,
  qConj,
  qMul,
  Quat,
  quatToRotVec,
  RAD_TO_DEG,
  relativeQuat,
  rotationAngle,
  Vec3,
} from './quaternion';

/**
 * Hold-free swing phase machine — the wrist unit's PRIMARY shot detection.
 *
 * Detection triggers on the swing envelope alone; no address hold is required
 * (golfers hit naturally without settling — the old hold-gated machine found
 * ZERO swings on a real range session). Structure, not thresholds, separates
 * a swing from everything else:
 *
 * - The motion envelope is the ABSOLUTE angular rate of the two IMUs (max of
 *   both), never the inter-IMU hinge rate — a lag-held downswing barely moves
 *   the wrist hinge while the arm rotates fast, and a waggle is pure hinge.
 * - θ(t) is the UNWRAPPED SIGNED rotation about the swing axis (established
 *   from the first ~25° of takeaway), not a geodesic angle: a full swing
 *   passes 180° where a geodesic folds back and the top vanishes. Labeled
 *   captures put full/partial swing tops at ~225–290° and chips at ~20–150°.
 * - The address reference freezes from whatever brief quiescence precedes the
 *   takeaway (averaged pose), captured from a rolling buffer — consecutive
 *   rehearsal swings re-anchor in the 24–54 °/s lulls between them.
 * - Top = reversal of θ off its max. Impact ZONE = θ returning through the
 *   address value (~0) during the downswing, coincident with peak angular
 *   speed. It is a swing-geometry landmark and the launch-monitor join key —
 *   NEVER a claim that a ball was struck; that is the launch monitor's call.
 * - Validation gates (top magnitude, tempo, peak speed, follow-through past
 *   address) reject waggles, club pickups, walking, and putts.
 * - All phase durations are timed on the device clock (unwrapped tsA), never
 *   BLE arrival time. A host-clock gap > ~1 s (BLE stall) breaks the unwrap —
 *   the detector resyncs: the in-flight swing aborts and timing restarts.
 * - A candidate that stops and settles NEAR the last known address pose is a
 *   re-address (club lowered, golfer settling) and silently re-anchors; one
 *   that dwells FAR from address is a pause at the top and stays armed.
 *
 * The address hold is a DRILL-MODE layer on top, not a gate: `onHold` streams
 * hold progress (the "hold still… GO" cue) and a qualifying hold stamps
 * addressHeldMs and a clean pre-swing angle snapshot, but detection behaves
 * identically without it. The hold itself is SWING-STANCE gated: stillness
 * accrues only within `holdPoseDeg` of gravity tilt from the last validated
 * swing's address (its own `holdAddressQB` memory, taught ONLY by finalize —
 * never by candidate churn, never shared with detection's `lastAddressQB`),
 * so sitting, phone-checking, and pauses at the top can't arm the GO cue.
 * Tilt is yaw-invariant: re-aiming at a new target keeps the hold live; a
 * re-strapped sensor needs one (uncued) validated swing to re-teach. `onPhase` fires at takeaway / top / impact zone /
 * finish / abort; takeaway / top / impact-zone events emit only once a
 * candidate backswing exceeds emitTakeawayDeg (default 30°), so waggles and
 * fidgeting never spam phase consumers — sub-30° strokes (tiny chips caught
 * by the chip band) surface as swing events alone.
 */
export interface SwingSample {
  tMs: number; // arrival epoch ms — carried onto keyframes for the store join
  tsa: number; // raw u16 device timestamp — the timing base
  qA: Quat; // IMU A absolute orientation (w-first, de-scaled)
  qB: Quat; // IMU B absolute orientation
  shock: number; // max |imu| across channels (context only)
}

export interface SwingDetectorOptions {
  /** envelope moving-average window, ms of device time */
  smoothMs?: number;
  /** host-clock gap that means the stream broke (BLE stall) — full resync */
  gapResyncMs?: number;
  /** takeaway: envelope crosses this out of a lull (deg/s) */
  enterDegS?: number;
  /** address-quiet ceiling — pose averaging + re-address dwell (deg/s) */
  stillDegS?: number;
  /** trailing quiet window averaged into the address pose (ms) */
  addressWindowMs?: number;
  /** swing axis freezes once this much takeaway rotation accrued (deg) */
  axisFreezeDeg?: number;
  /** …or after this long into the takeaway (ms) */
  axisFreezeMs?: number;
  /** takeaway phase emits once θ exceeds this — phase-event spam guard (deg) */
  emitTakeawayDeg?: number;
  /** θ this far NEGATIVE before the top restarts the anchor (forward press) */
  restartNegDeg?: number;
  /** θ retreat off θmax that confirms a direction change (deg) */
  reversalMarginDeg?: number;
  /** dwell band around θmax that still counts as "at the top" (deg) */
  topEpsDeg?: number;
  /** machinery floor: below this a reversal is a wiggle, not a top (deg) */
  minTopDeg?: number;
  /** full band: validation floor for the swing top (deg). Tuned on labeled
      full/partial swings (minimum 225°) vs the tallest negatives-session
      motion (77°); smaller strokes validate through the chip band instead */
  minTopValidDeg?: number;
  /** downswing must bring θ back below this — near address (deg) */
  impactReturnDeg?: number;
  /** chip band: validation floor for the swing top (deg) */
  chipMinTopDeg?: number;
  /** chip band: downswing envelope floor (deg/s) */
  chipMinPeakDegS?: number;
  /** chip band: rescan trigger sensitivity (deg/s) — a shock spike with no
      swing in flight rewinds ~2.5 s and re-enters at this lower gate, since
      a duffed bump-and-run's whole backswing can run below enterDegS */
  chipEnterDegS?: number;
  /** chip band: impact-neighborhood shock floor (raw lsb). Sub-full-swing
      amplitudes overlap putts/waggles/handling kinematically — only strikes
      that disturbed the IMU hard (ball/turf) validate. This is an impact-
      PLAUSIBILITY floor, never a claim of ball contact (the launch-monitor
      join stays the only contact truth); the cost is that low-amplitude
      practice swings without ground contact are not detected */
  chipShockLsb?: number;
  /** follow-through must pass this far beyond address (deg) */
  minFollowDeg?: number;
  /** θ rebound off the follow-through min that finalizes the swing (deg) */
  finishReversalDeg?: number;
  /** a relative lull this quiet can re-anchor an unproven candidate (deg/s) */
  relLullDegS?: number;
  /** downswing envelope floor (deg/s) */
  minPeakDegS?: number;
  /** downswing peak must beat backswing peak × this */
  downswingSpeedRatio?: number;
  /** peak speed may precede the impact zone by at most this (ms) */
  maxPeakLeadMs?: number;
  /** …and follow it by at most this — a "peak" seconds after the crossing
      means the candidate consumed someone else's swing (ms) */
  maxPeakLagMs?: number;
  minBackswingMs?: number;
  maxBackswingMs?: number;
  minDownswingMs?: number;
  maxDownswingMs?: number;
  /** quiet ceiling that ends the follow-through (deg/s) */
  exitDegS?: number;
  quietMs?: number;
  /** sustained sub-still dwell that can end a candidate backswing (ms) */
  readdressStillMs?: number;
  /** dwell pose within this of the last address = re-address, not a pause */
  readdressPoseDeg?: number;
  backswingTimeoutMs?: number;
  downswingTimeoutMs?: number;
  followthroughTimeoutMs?: number;
  /** stillness ceiling for the drill-mode hold (deg/s) */
  holdStillDegS?: number;
  /** hold accrues only within this gravity-tilt of the last VALIDATED
      swing's address pose (deg) — stillness on a bench, over a phone, or
      paused at the top must never arm the GO cue. Yaw-invariant, so
      re-aiming at a new target keeps the hold live; open until the first
      validated swing teaches the pose */
  holdPoseDeg?: number;
  /** hold duration that arms the drill GO cue (ms) */
  holdRequiredMs?: number;
  /** hold credit survives this long into the takeaway ramp (ms) */
  holdGraceMs?: number;
  /** after a swing, the hold re-arms only once the pose moved this far
      from the finish — holding the finish must not re-trigger the GO cue */
  rearmMinPoseDeg?: number;
  deviceClockHz?: number;
  /** When set, keyframes carry anatomical angles; otherwise angles are null. */
  calibration?: WristCalibration | null;
}

export interface SwingDetectorHandlers {
  onSwing(shot: WristShot): void;
  onHold?(hold: WristHold): void;
  onPhase?(phase: WristPhaseEvent): void;
}

interface Processed {
  tMs: number;
  tDev: number; // device seconds
  qA: Quat;
  qB: Quat;
  qRel: Quat;
  shock: number;
  omega: number; // smoothed absolute-rate envelope, deg/s
}

type State = 'idle' | 'backswing' | 'downswing' | 'followthrough' | 'confirm';

const NULL_ANGLES: WristAngles = {
  extensionDeg: null,
  deviationDeg: null,
  rotationDeg: null,
};

const HOLD_EMIT_EVERY_S = 0.1;
/** address pose worth remembering: a hold at least this long (ms) */
const ADDRESS_POSE_HOLD_MS = 800;
/** finish-reversal finalize needs at least this long past the impact zone */
const MIN_FOLLOWTHROUGH_S = 0.1;
/** recent-sample buffer horizon: address averaging + lull-retry replay (s) */
const RECENT_HORIZON_S = 5.0;
/** recent-sample buffer hard cap (samples) */
const RECENT_CAP = 256;
/** the takeaway anchor is the deepest lull within this window before the
    trigger sample (s) */
const ANCHOR_LOOKBACK_S = 1.0;
/** a candidate trough must sit below this fraction of the envelope max since
    takeaway — a monotone takeaway ramp never qualifies */
const TROUGH_FRAC = 0.6;
/** θ below this counts as "back at address" — the final climb starts at the
    last such moment, trimming pre-shot fidget out of the backswing */
const THETA_SMALL_DEG = 15;
/** a finish rebound must be this quiet relative to the swing's own peak —
    an envelope still racing past it means the swing is still in progress */
const REBOUND_QUIET_FRAC = 0.5;
/** shock-triggered rescan: how far back to reprocess, and its cooldown (s) */
const RESCAN_LOOKBACK_S = 2.5;
const RESCAN_COOLDOWN_S = 2.0;
/** finish-reversal finalizes hold this long before emitting: an envelope
    surging past the candidate's peak in that window proves the frame missed
    the real swing (s) */
const CONFIRM_HOLD_S = 0.5;
/** the surge factor that voids a pending finish-reversal finalize */
const CONFIRM_SURGE_FRAC = 1.2;

const geodesicDeg = (a: Quat, b: Quat): number =>
  rotationAngle(qMul(qConj(a), b)) * RAD_TO_DEG;

/** Default full-band validation floor (`minTopValidDeg`). Exported so app-
    edge feedback can band a top the moment its phase event fires — e.g. the
    drill's top-of-backswing wrist buzz is allowed only when the swing will
    validate full-band, keeping the motor out of every chip-band shock
    window. */
export const FULL_BAND_MIN_TOP_DEG = 140;

export class SwingDetector {
  private readonly opts: Required<Omit<SwingDetectorOptions, 'calibration'>>;
  private readonly handlers: SwingDetectorHandlers;
  private calibration: WristCalibration | null;

  // device clock
  private prevTsaRaw: number | null = null;
  private prevHostMs: number | null = null;
  private tsaUnwrapped = 0;

  // envelope + recent-pose buffer
  private prev: Processed | null = null;
  private omegaWindow: { t: number; v: number }[] = [];
  private recent: Processed[] = [];

  private state: State = 'idle';
  /** samples awaiting a state step; rewinds re-enqueue buffered samples here
      so every sample passes the state machine exactly once per timeline */
  private pending: Processed[] = [];
  /** anchoring before this device time is forbidden — samples already
      consumed by a finalized swing or a failed retry must not re-anchor */
  private earliestAnchorDev = -Infinity;
  /** deepest sub-enter lull inside the current candidate's lifetime — the
      retry anchor when a junk candidate turns out to have shadowed a swing */
  private lullSample: Processed | null = null;
  /** unproven-candidate trough: the envelope came down into a relative lull;
      a sharp rise out of it re-anchors there (the true takeaway start) */
  private candTrough: Processed | null = null;
  private candMaxOmega = 0;
  /** the sample the candidate stepped immediately before the current one
      (candidate timeline — rewinds replay past samples, so arrival order
      cannot be trusted) */
  private prevCandSample: Processed | null = null;

  // drill-mode hold layer
  private holdStartTDev: number | null = null;
  private lastStillTDev = 0;
  private heldAtLastStillMs = 0;
  private lastHoldEmitTDev = -Infinity;
  private lastEmittedArmed = false;
  private postSwingQB: Quat | null = null;
  private lastAddressQB: Quat | null = null;
  /** the hold gate's OWN pose memory — written only by finalize (a validated
      swing's address), never by candidate churn, and read only by stepHold.
      Deliberately separate from lastAddressQB: detection heuristics must stay
      byte-identical whatever the hold layer does, and beginSwing's learning
      would let bench fidgeting re-teach a sitting pose as "address". */
  private holdAddressQB: Quat | null = null;

  // in-flight candidate swing
  private qBAddr: Quat = [1, 0, 0, 0];
  private qRelAddr: Quat = [1, 0, 0, 0];
  private addressSample: Processed | null = null;
  private addressHeldMs = 0;
  private anchorStill = false;
  private tTakeawayDev = 0;
  private takeawayEmitted = false;
  private prevQB: Quat = [1, 0, 0, 0];
  private axisAccum: [number, number, number] = [0, 0, 0];
  private axis: Vec3 | null = null;
  private axisFlipped = false;
  private theta = 0;
  private prevTheta = 0;
  private thetaMax = 0;
  private lastThetaSmallDev = 0;
  private effTakeawayDev = 0;
  private topSample: Processed | null = null;
  private tTopFirstDev = 0;
  private tTopLastDev = 0;
  private lastTopEmitTheta = Infinity;
  private omegaPeakBack = 0;
  /** envelope peak since θ last set a new max — the reversal-confirmation lag
      belongs to the DOWNSWING, not the climb (a compressed punch swing peaks
      inside that lag and must not fail the tempo ratio) */
  private omegaPeakSinceTopSet = 0;
  private tPeakSinceTopSetDev = 0;
  private thetaLocalMin = 0;
  private thetaLocalMinSample: Processed | null = null;
  private impactSample: Processed | null = null;
  private tImpactZoneDev = 0;
  private omegaPeakDown = 0;
  private tPeakDownDev = 0;
  private thetaFollowMin = 0;
  private thetaFollowMinSample: Processed | null = null;
  private shockNearImpact = 0;
  private chipEnterUntilDev = -Infinity;
  private lastRescanDev = -Infinity;
  private lastEmitDev = -Infinity;
  private shockPeak = 0;
  private shockSample: Processed | null = null;
  private stillDwellStartDev: number | null = null;
  private quietSinceDev: number | null = null;
  private confirmStartDev = 0;
  private confirmEntryPeak = 0;

  constructor(
    handlers: SwingDetectorHandlers,
    options: SwingDetectorOptions = {},
  ) {
    this.handlers = handlers;
    this.opts = {
      smoothMs: options.smoothMs ?? 80,
      gapResyncMs: options.gapResyncMs ?? 1000,
      enterDegS: options.enterDegS ?? 100,
      stillDegS: options.stillDegS ?? 60,
      addressWindowMs: options.addressWindowMs ?? 250,
      axisFreezeDeg: options.axisFreezeDeg ?? 25,
      axisFreezeMs: options.axisFreezeMs ?? 300,
      emitTakeawayDeg: options.emitTakeawayDeg ?? 30,
      restartNegDeg: options.restartNegDeg ?? 12,
      reversalMarginDeg: options.reversalMarginDeg ?? 10,
      topEpsDeg: options.topEpsDeg ?? 3,
      minTopDeg: options.minTopDeg ?? 15,
      minTopValidDeg: options.minTopValidDeg ?? FULL_BAND_MIN_TOP_DEG,
      chipMinTopDeg: options.chipMinTopDeg ?? 15,
      chipEnterDegS: options.chipEnterDegS ?? 45,
      chipMinPeakDegS: options.chipMinPeakDegS ?? 250,
      chipShockLsb: options.chipShockLsb ?? 6000,
      impactReturnDeg: options.impactReturnDeg ?? 25,
      minFollowDeg: options.minFollowDeg ?? 8,
      finishReversalDeg: options.finishReversalDeg ?? 15,
      relLullDegS: options.relLullDegS ?? 250,
      minPeakDegS: options.minPeakDegS ?? 450,
      downswingSpeedRatio: options.downswingSpeedRatio ?? 0.5,
      maxPeakLeadMs: options.maxPeakLeadMs ?? 700,
      maxPeakLagMs: options.maxPeakLagMs ?? 400,
      minBackswingMs: options.minBackswingMs ?? 150,
      maxBackswingMs: options.maxBackswingMs ?? 3000,
      minDownswingMs: options.minDownswingMs ?? 80,
      maxDownswingMs: options.maxDownswingMs ?? 700,
      exitDegS: options.exitDegS ?? 60,
      quietMs: options.quietMs ?? 200,
      readdressStillMs: options.readdressStillMs ?? 600,
      readdressPoseDeg: options.readdressPoseDeg ?? 35,
      backswingTimeoutMs: options.backswingTimeoutMs ?? 10000,
      downswingTimeoutMs: options.downswingTimeoutMs ?? 1500,
      followthroughTimeoutMs: options.followthroughTimeoutMs ?? 3000,
      holdStillDegS: options.holdStillDegS ?? 30,
      holdPoseDeg: options.holdPoseDeg ?? 30,
      holdRequiredMs: options.holdRequiredMs ?? 1500,
      holdGraceMs: options.holdGraceMs ?? 600,
      rearmMinPoseDeg: options.rearmMinPoseDeg ?? 30,
      deviceClockHz: options.deviceClockHz ?? DEVICE_CLOCK_HZ,
    };
    this.calibration = options.calibration ?? null;
  }

  /** Swap anatomical calibration on the live stream (post-calibration). */
  setCalibration(calibration: WristCalibration | null): void {
    this.calibration = calibration;
  }

  push(sample: SwingSample): void {
    const p = this.process(sample);
    this.stepHold(p);
    this.recent.push(p);
    while (
      this.recent.length > RECENT_CAP ||
      (this.recent.length > 0 && p.tDev - this.recent[0].tDev > RECENT_HORIZON_S)
    ) {
      this.recent.shift();
    }
    this.pending.push(p);
    let q = this.pending.shift();
    while (q !== undefined) {
      this.stepState(q);
      q = this.pending.shift();
    }
  }

  private stepState(p: Processed): void {
    // a violent IMU disturbance (ball/turf) with no swing in flight means a
    // stroke slipped under the enter gate — a duffed bump-and-run's whole
    // backswing can run below it. Rewind and reprocess at chip sensitivity.
    // This is a re-analysis TRIGGER, never a claim that a ball was struck.
    if (
      p.shock >= this.opts.chipShockLsb &&
      (this.state === 'idle' || this.state === 'backswing') &&
      p.tDev - this.lastRescanDev > RESCAN_COOLDOWN_S
    ) {
      this.lastRescanDev = p.tDev;
      this.chipEnterUntilDev = p.tDev;
      if (this.takeawayEmitted) this.emitPhase('aborted', p);
      this.takeawayEmitted = false;
      this.state = 'idle';
      this.lullSample = null;
      this.earliestAnchorDev = Math.max(
        p.tDev - RESCAN_LOOKBACK_S,
        this.lastEmitDev,
      );
      this.backfillAfter(this.earliestAnchorDev, p.tDev);
      return;
    }
    if (this.state !== 'idle' && p.omega < this.opts.enterDegS) {
      if (this.lullSample === null || p.omega < this.lullSample.omega) {
        this.lullSample = p;
      }
    }
    switch (this.state) {
      case 'idle':
        this.stepIdle(p);
        break;
      case 'backswing':
        this.stepBackswing(p);
        break;
      case 'downswing':
        this.stepDownswing(p);
        break;
      case 'followthrough':
        this.stepFollowthrough(p);
        break;
      case 'confirm':
        this.stepConfirm(p);
        break;
    }
  }

  /** Rewind the state machine to just after `fromDev`: buffered samples after
      it re-enter the queue and pass the (reset) machine again. Terminates:
      every rewind moves the anchor point strictly later on the timeline. */
  private backfillAfter(fromDev: number, untilDev: number): void {
    const replay = this.recent.filter(
      (h) => h.tDev > fromDev && h.tDev <= untilDev,
    );
    this.pending.unshift(...replay);
  }

  /** A candidate died (timeout / failed validation). If a lull passed inside
      its lifetime BEFORE its fastest moment, the candidate may have SHADOWED
      a real swing that rose out of that lull — rewind there so the swing is
      recovered with a clean address frame. The pre-peak constraint matters:
      the global minimum is usually the post-impact settle, AFTER the swing. */
  private dieWithRetry(p: Processed): void {
    if (this.takeawayEmitted) this.emitPhase('aborted', p);
    this.takeawayEmitted = false;
    this.state = 'idle';
    const peakDev =
      this.omegaPeakDown > 0 ? this.tPeakDownDev : this.tPeakSinceTopSetDev;
    // prefer lulls whose pose sits at address: the deepest lull before the
    // peak is often the transition dip AT THE TOP, which would frame the
    // downswing as a climb
    let lull: Processed | null = null;
    let atAddress: Processed | null = null;
    for (const r of this.recent) {
      if (
        r.tDev > this.tTakeawayDev &&
        r.tDev < peakDev &&
        r.omega < this.opts.enterDegS
      ) {
        if (lull === null || r.omega < lull.omega) lull = r;
        if (
          this.lastAddressQB !== null &&
          geodesicDeg(this.lastAddressQB, r.qB) <= this.opts.readdressPoseDeg &&
          (atAddress === null || r.omega < atAddress.omega)
        ) {
          atAddress = r;
        }
      }
    }
    if (atAddress !== null) lull = atAddress;
    const tracked = this.lullSample;
    if (
      lull === null &&
      tracked !== null &&
      tracked.tDev > this.tTakeawayDev &&
      tracked.tDev < peakDev
    ) {
      lull = tracked;
    }
    this.lullSample = null;
    if (lull !== null && this.recent.length > 0 && lull.tDev >= this.recent[0].tDev) {
      this.earliestAnchorDev = lull.tDev;
      this.backfillAfter(lull.tDev, p.tDev);
      return;
    }
    this.earliestAnchorDev = p.tDev;
  }

  /** Finalize any swing still in flight at stream end (disconnect). */
  flush(): void {
    // a finalize can rewind (backfill the queue) to recover a chained swing —
    // keep draining until the machine settles. Terminates: every rewind moves
    // the anchor point strictly later.
    for (;;) {
      let q = this.pending.shift();
      while (q !== undefined) {
        this.stepState(q);
        q = this.pending.shift();
      }
      if (
        this.state === 'downswing' ||
        this.state === 'followthrough' ||
        this.state === 'confirm'
      ) {
        this.finalize(this.prevCandSample ?? this.prev);
      } else {
        break;
      }
    }
    if (this.state === 'backswing' && this.takeawayEmitted) {
      this.emitPhase('aborted', this.prevCandSample ?? this.prev);
    }
    this.state = 'idle';
    this.takeawayEmitted = false;
    this.lullSample = null;
    this.pending = [];
  }

  /* ────────────────────── per-sample processing ────────────────────── */

  private process(sample: SwingSample): Processed {
    if (
      this.prevHostMs !== null &&
      sample.tMs - this.prevHostMs > this.opts.gapResyncMs
    ) {
      this.streamBreak(sample.tMs - this.prevHostMs);
    }
    this.prevHostMs = sample.tMs;

    if (this.prevTsaRaw !== null) {
      let delta = sample.tsa - this.prevTsaRaw;
      if (delta < -32768) delta += 65536;
      else if (delta > 32768) delta -= 65536;
      this.tsaUnwrapped += delta;
    }
    this.prevTsaRaw = sample.tsa;
    const tDev = this.tsaUnwrapped / this.opts.deviceClockHz;

    // absolute-rate envelope: the faster of the two IMUs, world-frame
    let rawOmega = 0;
    if (this.prev !== null) {
      const dt = tDev - this.prev.tDev;
      if (dt > 0) {
        const rateA = rotationAngle(qMul(qConj(this.prev.qA), sample.qA));
        const rateB = rotationAngle(qMul(qConj(this.prev.qB), sample.qB));
        rawOmega = (Math.max(rateA, rateB) * RAD_TO_DEG) / dt;
      } else {
        rawOmega = this.prev.omega;
      }
    }
    this.omegaWindow.push({ t: tDev, v: rawOmega });
    while (
      this.omegaWindow.length > 1 &&
      tDev - this.omegaWindow[0].t > this.opts.smoothMs / 1000
    ) {
      this.omegaWindow.shift();
    }
    const omega =
      this.omegaWindow.reduce((a, b) => a + b.v, 0) / this.omegaWindow.length;

    const p: Processed = {
      tMs: sample.tMs,
      tDev,
      qA: sample.qA,
      qB: sample.qB,
      qRel: relativeQuat(sample.qA, sample.qB),
      shock: sample.shock,
      omega,
    };
    this.prev = p;
    return p;
  }

  /** A BLE stall broke the device-clock unwrap: abort in-flight state and
      restart timing. The unwrap is advanced by the host gap so tDev stays
      roughly host-aligned, but no duration may span the break. */
  private streamBreak(hostGapMs: number): void {
    if (this.state !== 'idle' && this.takeawayEmitted) {
      this.emitPhase('aborted', this.prev);
    }
    this.state = 'idle';
    this.takeawayEmitted = false;
    this.lullSample = null;
    this.pending = [];
    this.prevCandSample = null;
    this.tsaUnwrapped += (hostGapMs / 1000) * this.opts.deviceClockHz;
    this.prevTsaRaw = null; // do not trust the delta across the gap
    const last = this.prev;
    this.prev = null;
    this.omegaWindow = [];
    this.recent = [];
    if (this.holdStartTDev !== null || this.lastEmittedArmed) {
      this.holdStartTDev = null;
      // un-arm the UI now — a stalled stream must not leave a stale GO up
      if (last !== null) this.emitHold(last, 0, false, true);
      else this.lastEmittedArmed = false;
    }
  }

  /* ────────────────────── drill-mode hold layer ────────────────────── */

  private stepHold(p: Processed): void {
    // one-way latch: once the golfer actually leaves the finish pose, the
    // rearm block lifts — candidate churn must not clear it early
    if (
      this.postSwingQB !== null &&
      geodesicDeg(this.postSwingQB, p.qB) >= this.opts.rearmMinPoseDeg
    ) {
      this.postSwingQB = null;
    }
    // swing-stance gate: stillness only counts near the last validated
    // address (gravity tilt — yaw-free, so re-aiming keeps it live). Open
    // until the first validated swing teaches the pose; a far-pose stillness
    // (bench, phone, pause at the top) falls through to the grace reset like
    // any other motion, so it can never accrue or arm
    const atAddress =
      this.holdAddressQB === null ||
      gravityTiltDeg(this.holdAddressQB, p.qB) <= this.opts.holdPoseDeg;
    if (p.omega < this.opts.holdStillDegS && atAddress) {
      if (this.holdStartTDev === null) this.holdStartTDev = p.tDev;
      const heldMs = (p.tDev - this.holdStartTDev) * 1000;
      this.lastStillTDev = p.tDev;
      this.heldAtLastStillMs = heldMs;
      // only an idle hold teaches the address pose — a pause-at-top drill
      // holds still mid-candidate and must not redefine "address"
      if (
        heldMs >= ADDRESS_POSE_HOLD_MS &&
        this.postSwingQB === null &&
        this.state === 'idle'
      ) {
        this.lastAddressQB = p.qB;
      }
      this.emitHold(
        p,
        heldMs,
        heldMs >= this.opts.holdRequiredMs && this.postSwingQB === null,
      );
      return;
    }
    if (
      this.holdStartTDev !== null &&
      (p.tDev - this.lastStillTDev) * 1000 > this.opts.holdGraceMs
    ) {
      this.holdStartTDev = null;
      this.emitHold(p, 0, false, true);
    }
  }

  /* ────────────────────── state steps ────────────────────── */

  /** the enter gate, lowered inside a shock-triggered rescan window */
  private enterFor(p: Processed): number {
    return p.tDev <= this.chipEnterUntilDev
      ? this.opts.chipEnterDegS
      : this.opts.enterDegS;
  }

  private stepIdle(p: Processed): void {
    const enter = this.enterFor(p);
    if (p.omega < enter) return;
    // the takeaway anchor is the deepest recent lull: the last sample at the
    // bottom of the quiescence the motion rose out of
    const anchor = this.trailingLull(p, enter);
    if (anchor === null) return; // still loud since the last swing — wait
    this.beginSwing(anchor);
    this.backfillAfter(anchor.tDev, p.tDev);
  }

  /** Deepest sub-enter sample in the look-back window before `p` (latest of
      near-equal minima). Null when no eligible lull exists yet. */
  private trailingLull(p: Processed, enter: number): Processed | null {
    let minOmega = Infinity;
    for (const r of this.recent) {
      if (
        r.tDev < p.tDev &&
        p.tDev - r.tDev <= ANCHOR_LOOKBACK_S &&
        r.tDev >= this.earliestAnchorDev &&
        r.omega < enter &&
        r.omega < minOmega
      ) {
        minOmega = r.omega;
      }
    }
    if (minOmega === Infinity) return null;
    let best: Processed | null = null;
    for (const r of this.recent) {
      if (
        r.tDev < p.tDev &&
        p.tDev - r.tDev <= ANCHOR_LOOKBACK_S &&
        r.tDev >= this.earliestAnchorDev &&
        r.omega <= minOmega + 5
      ) {
        best = r; // latest sample still at the lull bottom
      }
    }
    return best;
  }

  private stepBackswing(p: Processed): void {
    this.prevCandSample = p;
    this.integrate(p);
    this.trackShock(p);
    const o = this.opts;

    if (this.theta <= THETA_SMALL_DEG) this.lastThetaSmallDev = p.tDev;
    if (this.theta > this.thetaMax) {
      // still climbing: everything since the previous max was climb
      this.thetaMax = this.theta;
      this.topSample = p;
      this.tTopFirstDev = p.tDev;
      this.tTopLastDev = p.tDev;
      this.omegaPeakBack = Math.max(
        this.omegaPeakBack,
        this.omegaPeakSinceTopSet,
        p.omega,
      );
      this.omegaPeakSinceTopSet = 0;
      this.tPeakSinceTopSetDev = p.tDev;
    } else {
      if (this.theta >= this.thetaMax - o.topEpsDeg) {
        this.tTopLastDev = p.tDev; // dwelling at the top (pause)
      }
      // possibly already past the top: bank speed for the downswing seed
      if (p.omega > this.omegaPeakSinceTopSet) {
        this.omegaPeakSinceTopSet = p.omega;
        this.tPeakSinceTopSetDev = p.tDev;
      }
    }

    // a candidate whose envelope fell into a trough and surged back out was
    // anchored in pre-shot fidgeting — the trough is the real takeaway. Fires
    // while the candidate is unproven, or whenever the trough pose sits back
    // at address (a shuffle drifts θ but stays AT the ball; a pause at the
    // top does not) — never on a genuine top pause.
    this.candMaxOmega = Math.max(this.candMaxOmega, p.omega);
    // θ guard: a dip 20°+ into the climb is mid-swing, not an address — at
    // chip scale the POSE stays near address through the whole backswing,
    // so the pose test alone would cannibalize tiny strokes
    if (
      p.omega < o.relLullDegS &&
      p.omega <= TROUGH_FRAC * this.candMaxOmega &&
      Math.abs(this.theta) <= 20 &&
      (this.lastAddressQB === null ||
        geodesicDeg(this.lastAddressQB, p.qB) <= o.readdressPoseDeg) &&
      (this.candTrough === null || p.omega < this.candTrough.omega)
    ) {
      this.candTrough = p;
    }
    const trough = this.candTrough;
    if (
      trough !== null &&
      p.tDev > trough.tDev &&
      p.omega >= Math.max(2 * trough.omega, o.enterDegS) &&
      (this.thetaMax < o.minTopDeg || this.lastAddressQB !== null)
    ) {
      if (this.takeawayEmitted) this.emitPhase('aborted', p);
      this.beginSwing(trough);
      this.backfillAfter(trough.tDev, p.tDev);
      return;
    }

    if (!this.takeawayEmitted && this.theta >= o.emitTakeawayDeg) {
      this.takeawayEmitted = true;
      this.emitPhase('takeaway', this.addressSample);
    }

    // forward press / wrong-way start: the sign reference froze on fidget
    // or a press, opposite the real climb. Flip once — the frame is fine,
    // only the direction guess was wrong. A second dive is a real reversal.
    if (this.theta < -o.restartNegDeg && this.thetaMax < o.minTopDeg) {
      if (!this.axisFlipped && this.axis !== null && this.thetaMax < 15) {
        this.axisFlipped = true;
        this.axis = [-this.axis[0], -this.axis[1], -this.axis[2]];
        this.theta = -this.theta;
        this.prevTheta = -this.prevTheta;
        this.thetaMax = this.theta;
        this.topSample = p;
        this.tTopFirstDev = p.tDev;
        this.tTopLastDev = p.tDev;
      } else {
        this.dieWithRetry(p);
        return;
      }
    }

    // reversal: the climb turned around
    if (this.theta <= this.thetaMax - o.reversalMarginDeg) {
      if (this.thetaMax >= o.minTopDeg) {
        // the final climb began the last time θ sat at address — pre-shot
        // fidget inside this candidate's frame is not backswing
        this.effTakeawayDev = Math.max(
          this.tTakeawayDev,
          Math.min(this.lastThetaSmallDev, this.tTopFirstDev),
        );
        this.state = 'downswing';
        this.thetaLocalMin = this.theta;
        this.thetaLocalMinSample = p;
        // the reversal-confirmation lag belongs to the downswing
        if (this.omegaPeakSinceTopSet >= p.omega) {
          this.omegaPeakDown = this.omegaPeakSinceTopSet;
          this.tPeakDownDev = this.tPeakSinceTopSetDev;
        } else {
          this.omegaPeakDown = p.omega;
          this.tPeakDownDev = p.tDev;
        }
        // a pump drill re-enters the backswing; only a materially higher top
        // re-buzzes phase consumers — and sub-takeaway strokes (waggles,
        // tiny chips) emit no phases at all, only the swing event
        if (
          this.takeawayEmitted &&
          (this.lastTopEmitTheta === Infinity ||
            this.thetaMax >= this.lastTopEmitTheta + o.reversalMarginDeg)
        ) {
          this.lastTopEmitTheta = this.thetaMax;
          this.emitPhase('top', this.topSample, this.thetaMax);
        }
      } else if (this.anchorStill) {
        // pre-shot fidget inside a TRUSTED frame: restart the climb in
        // place — abandoning a still anchor loses a small stroke's address
        this.thetaMax = Math.max(this.theta, 0);
        this.topSample = p;
        this.tTopFirstDev = p.tDev;
        this.tTopLastDev = p.tDev;
        this.omegaPeakBack = Math.max(
          this.omegaPeakBack,
          this.omegaPeakSinceTopSet,
        );
        this.omegaPeakSinceTopSet = 0;
        this.tPeakSinceTopSetDev = p.tDev;
      } else {
        this.dieWithRetry(p); // restart from the best lull
      }
      return;
    }

    // sustained stillness: a pause at the top dwells FAR from the address
    // pose; settling NEAR it (club lowered, golfer re-gripping) re-anchors
    if (p.omega < o.stillDegS) {
      if (this.stillDwellStartDev === null) this.stillDwellStartDev = p.tDev;
      if ((p.tDev - this.stillDwellStartDev) * 1000 >= o.readdressStillMs) {
        const nearAddress =
          this.lastAddressQB !== null &&
          geodesicDeg(this.lastAddressQB, p.qB) <= o.readdressPoseDeg;
        if (nearAddress || this.thetaMax < o.minTopDeg) {
          this.abandonSwing(p);
          return;
        }
      }
    } else {
      this.stillDwellStartDev = null;
    }

    if ((p.tDev - this.tTakeawayDev) * 1000 > o.backswingTimeoutMs) {
      this.dieWithRetry(p);
    }
  }

  private stepDownswing(p: Processed): void {
    const before = this.prevCandSample;
    this.prevCandSample = p;
    this.integrate(p);
    if (p.omega > this.omegaPeakDown) {
      this.omegaPeakDown = p.omega;
      this.tPeakDownDev = p.tDev;
    }
    this.trackShock(p);
    const o = this.opts;

    if (this.theta < this.thetaLocalMin) {
      this.thetaLocalMin = this.theta;
      this.thetaLocalMinSample = p;
    }

    // θ crossed back through the address value: the impact zone
    if (this.prevTheta > 0 && this.theta <= 0) {
      const impact =
        before !== null && Math.abs(this.prevTheta) <= Math.abs(this.theta)
          ? before
          : p;
      this.enterFollowthrough(impact);
      return;
    }

    // reversal before crossing: a pump drill climbs again; a return that
    // reached the address band still counts as the impact zone
    if (this.theta >= this.thetaLocalMin + o.reversalMarginDeg) {
      if (this.thetaLocalMin <= o.impactReturnDeg) {
        this.enterFollowthrough(this.thetaLocalMinSample ?? p);
      } else {
        this.state = 'backswing';
        this.stillDwellStartDev = null;
      }
      return;
    }

    if ((p.tDev - this.tTopLastDev) * 1000 > o.downswingTimeoutMs) {
      this.dieWithRetry(p);
    }
  }

  private enterFollowthrough(impact: Processed): void {
    this.state = 'followthrough';
    this.impactSample = impact;
    this.tImpactZoneDev = impact.tDev;
    this.thetaFollowMin = this.theta;
    this.thetaFollowMinSample = impact;
    this.quietSinceDev = null;
    this.shockNearImpact = 0;
    for (const r of this.recent) {
      if (
        r.tDev >= impact.tDev - 0.15 &&
        r.tDev <= impact.tDev &&
        r.shock > this.shockNearImpact
      ) {
        this.shockNearImpact = r.shock;
      }
    }
    if (this.takeawayEmitted) this.emitPhase('impactZone', impact);
  }

  private stepFollowthrough(p: Processed): void {
    this.prevCandSample = p;
    this.integrate(p);
    const o = this.opts;
    // the bottom of the arc is the fastest instant of THIS swing — motion
    // beyond the coincidence window (a rake, the next takeaway) is not it
    if (
      p.omega > this.omegaPeakDown &&
      (p.tDev - this.tImpactZoneDev) * 1000 <= o.maxPeakLagMs
    ) {
      this.omegaPeakDown = p.omega;
      this.tPeakDownDev = p.tDev;
    }
    if (
      p.shock > this.shockNearImpact &&
      (p.tDev - this.tImpactZoneDev) * 1000 <= o.maxPeakLagMs
    ) {
      this.shockNearImpact = p.shock;
    }
    this.trackShock(p);

    if (this.theta < this.thetaFollowMin) {
      this.thetaFollowMin = this.theta;
      this.thetaFollowMinSample = p;
    }

    // finish reversal: the club rebounds off the finish — finalize now so a
    // consecutive rehearsal swing can re-anchor without any quiet between.
    // A true rebound starts SLOW relative to the swing it ends; an envelope
    // still accelerating past the candidate's own peak means the real swing
    // is still in progress and this frame has not captured it
    const rebounding =
      this.theta >= this.thetaFollowMin + o.finishReversalDeg &&
      this.thetaFollowMin <= -o.minFollowDeg &&
      p.tDev - this.tImpactZoneDev >= MIN_FOLLOWTHROUGH_S &&
      p.omega <= REBOUND_QUIET_FRAC * this.omegaPeakDown;
    if (rebounding) {
      this.state = 'confirm';
      this.confirmStartDev = p.tDev;
      this.confirmEntryPeak = this.omegaPeakDown;
      return;
    }

    if (p.omega < o.exitDegS) {
      if (this.quietSinceDev === null) this.quietSinceDev = p.tDev;
      if ((p.tDev - this.quietSinceDev) * 1000 >= o.quietMs) {
        this.finalize(p);
        return;
      }
    } else {
      this.quietSinceDev = null;
    }
    if ((p.tDev - this.tImpactZoneDev) * 1000 > o.followthroughTimeoutMs) {
      this.finalize(p);
    }
  }

  /** A finish-reversal finalize is pending: hold the emission briefly. A
      surge past the candidate's own peak in this window means the frame
      closed on fidget while the real swing was still coming — retry. */
  private stepConfirm(p: Processed): void {
    this.prevCandSample = p;
    this.integrate(p);
    if (
      p.omega > this.omegaPeakDown &&
      (p.tDev - this.tImpactZoneDev) * 1000 <= this.opts.maxPeakLagMs
    ) {
      this.omegaPeakDown = p.omega;
      this.tPeakDownDev = p.tDev;
    }
    this.trackShock(p);
    if (p.omega >= CONFIRM_SURGE_FRAC * this.confirmEntryPeak) {
      this.dieWithRetry(p);
      return;
    }
    if (
      p.omega < this.opts.exitDegS ||
      p.tDev - this.confirmStartDev >= CONFIRM_HOLD_S
    ) {
      this.finalize(p);
    }
  }

  /* ────────────────────── swing angle integration ────────────────────── */

  /** Unwrapped signed swing angle: the magnitude of the cumulative world-
      frame rotation-vector sum of the hand IMU, signed by the takeaway
      direction (frozen once ~25° accrued). A vector sum has no 180° fold —
      full swings pass through cleanly — and stays monotone when the
      backswing's rotation axis drifts (wristy / rerouted backswings), where
      a fixed-axis projection reverses early. The downswing cancels the sum
      back through ~0 at address; the follow-through drives it negative. */
  private integrate(p: Processed): void {
    const dq = qMul(p.qB, qConj(this.prevQB));
    const v = quatToRotVec(dq);
    this.prevQB = p.qB;
    this.prevTheta = this.theta;
    this.axisAccum[0] += v[0];
    this.axisAccum[1] += v[1];
    this.axisAccum[2] += v[2];
    const mag = Math.hypot(...this.axisAccum);
    const magDeg = mag * RAD_TO_DEG;
    if (this.axis === null) {
      const elapsedMs = (p.tDev - this.tTakeawayDev) * 1000;
      // the time-based freeze needs real rotation accrued — tiny pre-shot
      // drift would otherwise lock the axis before a small stroke's climb
      if (
        magDeg >= this.opts.axisFreezeDeg ||
        (elapsedMs >= this.opts.axisFreezeMs && magDeg >= 12)
      ) {
        this.axis = [
          this.axisAccum[0] / mag,
          this.axisAccum[1] / mag,
          this.axisAccum[2] / mag,
        ];
      }
      this.theta = magDeg;
      return;
    }
    const toward =
      this.axisAccum[0] * this.axis[0] +
      this.axisAccum[1] * this.axis[1] +
      this.axisAccum[2] * this.axis[2];
    this.theta = toward >= 0 ? magDeg : -magDeg;
  }

  /* ────────────────────── transitions ────────────────────── */

  /** Open a candidate anchored at `anchor` — samples after it reach the
      backswing step via the queue (live arrival or a backfill rewind). */
  private beginSwing(anchor: Processed): void {
    // address reference: the averaged pose over the trailing quiet window —
    // or the anchor alone when the takeaway rose straight out of motion
    const stillWin = this.recent.filter(
      (r) =>
        r.tDev <= anchor.tDev &&
        anchor.tDev - r.tDev <= this.opts.addressWindowMs / 1000 &&
        r.omega < this.opts.stillDegS,
    );
    if (stillWin.length >= 3) {
      this.qBAddr = markleyAverage(stillWin.map((r) => r.qB));
      this.qRelAddr = markleyAverage(stillWin.map((r) => r.qRel));
    } else {
      this.qBAddr = anchor.qB;
      this.qRelAddr = anchor.qRel;
    }
    if (anchor.omega < this.opts.holdStillDegS) {
      this.lastAddressQB = this.qBAddr;
    }
    this.anchorStill = anchor.omega < this.opts.stillDegS;
    this.addressSample = anchor;
    this.addressHeldMs =
      this.holdStartTDev !== null ||
      (anchor.tDev - this.lastStillTDev) * 1000 <= this.opts.holdGraceMs
        ? this.heldAtLastStillMs
        : 0;
    if (this.holdStartTDev !== null) {
      this.holdStartTDev = null;
      this.emitHold(anchor, 0, false, true);
    }

    this.state = 'backswing';
    this.lullSample = null;
    this.candTrough = null;
    this.candMaxOmega = anchor.omega;
    this.prevCandSample = anchor;
    this.tTakeawayDev = anchor.tDev;
    this.takeawayEmitted = false;
    this.lastTopEmitTheta = Infinity;
    this.prevQB = anchor.qB;
    this.axisAccum = [0, 0, 0];
    this.axis = null;
    this.axisFlipped = false;
    this.theta = 0;
    this.prevTheta = 0;
    this.thetaMax = 0;
    this.lastThetaSmallDev = anchor.tDev;
    this.effTakeawayDev = anchor.tDev;
    this.topSample = anchor;
    this.tTopFirstDev = anchor.tDev;
    this.tTopLastDev = anchor.tDev;
    this.omegaPeakBack = anchor.omega;
    this.omegaPeakSinceTopSet = 0;
    this.tPeakSinceTopSetDev = anchor.tDev;
    this.thetaLocalMin = 0;
    this.thetaLocalMinSample = null;
    this.impactSample = null;
    this.omegaPeakDown = 0;
    this.tPeakDownDev = anchor.tDev;
    this.thetaFollowMin = 0;
    this.thetaFollowMinSample = null;
    this.shockPeak = anchor.shock;
    this.shockSample = anchor;
    this.stillDwellStartDev = null;
    this.quietSinceDev = null;
  }

  private abandonSwing(p: Processed): void {
    if (this.takeawayEmitted) this.emitPhase('aborted', p);
    this.state = 'idle';
    this.takeawayEmitted = false;
    this.lullSample = null;
    this.earliestAnchorDev = this.stillDwellStartDev ?? p.tDev;
  }

  private trackShock(p: Processed): void {
    if (p.shock > this.shockPeak) {
      this.shockPeak = p.shock;
      this.shockSample = p;
    }
  }

  private finalize(last: Processed | null): void {
    this.state = 'idle';
    const address = this.addressSample;
    const top = this.topSample;
    const impact = this.impactSample;
    const emitted = this.takeawayEmitted;
    this.takeawayEmitted = false;
    if (address === null || top === null || impact === null || last === null) {
      if (emitted) this.emitPhase('aborted', last);
      return;
    }

    const backswingMs = (this.tTopFirstDev - this.effTakeawayDev) * 1000;
    const topPauseMs = Math.max(
      0,
      (this.tTopLastDev - this.tTopFirstDev) * 1000,
    );
    const downswingMs = (impact.tDev - this.tTopLastDev) * 1000;
    const peakToImpactMs = (this.tPeakDownDev - impact.tDev) * 1000;
    const o = this.opts;
    const fullBand =
      this.thetaMax >= o.minTopValidDeg && this.omegaPeakDown >= o.minPeakDegS;
    const chipBand =
      this.thetaMax >= o.chipMinTopDeg &&
      this.omegaPeakDown >= o.chipMinPeakDegS &&
      this.shockNearImpact >= o.chipShockLsb;
    const valid =
      (fullBand || chipBand) &&
      this.thetaFollowMin <= -o.minFollowDeg &&
      this.omegaPeakDown >= this.omegaPeakBack * o.downswingSpeedRatio &&
      // the bottom of the arc IS the fastest instant: a "peak" long after the
      // crossing means this candidate consumed someone else's swing
      peakToImpactMs >= -o.maxPeakLeadMs &&
      peakToImpactMs <= o.maxPeakLagMs &&
      backswingMs >= o.minBackswingMs &&
      backswingMs <= o.maxBackswingMs &&
      downswingMs >= o.minDownswingMs &&
      downswingMs <= o.maxDownswingMs;
    if (!valid) {
      this.takeawayEmitted = emitted;
      this.dieWithRetry(last);
      return;
    }

    const shot: WristShot = {
      tImpactMs: impact.tMs,
      durationMs: (last.tDev - this.tTakeawayDev) * 1000,
      peakAngularSpeedDegS: this.omegaPeakDown,
      calibrated: this.calibration !== null,
      addressHeldMs: this.addressHeldMs,
      backswingMs,
      topPauseMs,
      downswingMs,
      address: this.addressKeyframe(address),
      top: this.keyframe(top),
      impact: this.keyframe(impact),
      shock: {
        tMs: this.shockSample?.tMs ?? impact.tMs,
        offsetFromImpactMs: (this.shockSample?.tMs ?? impact.tMs) - impact.tMs,
        peakAbsLsb: this.shockPeak,
      },
    };
    this.postSwingQB = last.qB;
    this.lastAddressQB = this.qBAddr;
    this.holdAddressQB = this.qBAddr; // a validated swing is the only teacher
    this.lastEmitDev = last.tDev;
    this.emitPhase('finish', last);
    this.handlers.onSwing(shot);
    // a consecutive rehearsal swing rises straight off the finish rebound —
    // rewind to the follow-through bottom so its takeaway is not consumed
    const followBottom = this.thetaFollowMinSample;
    this.lullSample = null;
    if (followBottom !== null && followBottom.tDev < last.tDev) {
      this.earliestAnchorDev = followBottom.tDev;
      this.backfillAfter(followBottom.tDev, last.tDev);
    } else {
      this.earliestAnchorDev = last.tDev;
    }
  }

  /* ────────────────────── keyframes & events ────────────────────── */

  private anglesOf(qRel: Quat): { rotVec: Vec3; angles: WristAngles } {
    const calibration = this.calibration;
    if (calibration !== null) {
      const qAnat = qCanonical(qMul(qConj(calibration.qRef), qRel));
      const [ext, dev, rot] = anatomicalAnglesDeg(calibration.frame, qAnat);
      return {
        rotVec: quatToRotVec(qAnat),
        angles: { extensionDeg: ext, deviationDeg: dev, rotationDeg: rot },
      };
    }
    return { rotVec: quatToRotVec(qRel), angles: NULL_ANGLES };
  }

  private fromAddressDeg(qRel: Quat): [number, number, number] {
    const v = quatToRotVec(qCanonical(qMul(qConj(this.qRelAddr), qRel)));
    return [v[0] * RAD_TO_DEG, v[1] * RAD_TO_DEG, v[2] * RAD_TO_DEG];
  }

  private keyframe(p: Processed): WristKeyframe {
    const { rotVec, angles } = this.anglesOf(p.qRel);
    return {
      tMs: p.tMs,
      tDevS: p.tDev,
      angularSpeedDegS: p.omega,
      angles,
      rotVecDeg: [
        rotVec[0] * RAD_TO_DEG,
        rotVec[1] * RAD_TO_DEG,
        rotVec[2] * RAD_TO_DEG,
      ],
      rotVecFromAddressDeg: this.fromAddressDeg(p.qRel),
    };
  }

  /** The address keyframe reads the AVERAGED pre-takeaway pose, not one noisy
      sample — this is the pre-swing angle snapshot the drill inspects. */
  private addressKeyframe(p: Processed): WristKeyframe {
    const { rotVec, angles } = this.anglesOf(this.qRelAddr);
    return {
      tMs: p.tMs,
      tDevS: p.tDev,
      angularSpeedDegS: p.omega,
      angles,
      rotVecDeg: [
        rotVec[0] * RAD_TO_DEG,
        rotVec[1] * RAD_TO_DEG,
        rotVec[2] * RAD_TO_DEG,
      ],
      rotVecFromAddressDeg: [0, 0, 0],
    };
  }

  private emitHold(
    p: Processed,
    heldMs: number,
    armed: boolean,
    force = false,
  ): void {
    if (this.handlers.onHold === undefined) return;
    const due =
      force ||
      armed !== this.lastEmittedArmed ||
      p.tDev - this.lastHoldEmitTDev >= HOLD_EMIT_EVERY_S;
    if (!due) return;
    this.lastHoldEmitTDev = p.tDev;
    this.lastEmittedArmed = armed;
    this.handlers.onHold({
      tMs: p.tMs,
      heldMs,
      requiredMs: this.opts.holdRequiredMs,
      armed,
    });
  }

  /** `thetaDeg` rides along so consumers can band the swing (full vs chip)
      the moment the event fires; `top` passes the confirmed peak, everything
      else the live unwrapped angle. */
  private emitPhase(
    phase: WristPhaseEvent['phase'],
    p: Processed | null,
    thetaDeg = this.theta,
  ): void {
    if (this.handlers.onPhase === undefined || p === null) return;
    const { angles } = this.anglesOf(p.qRel);
    this.handlers.onPhase({
      phase,
      tMs: p.tMs,
      rotVecFromAddressDeg: this.fromAddressDeg(p.qRel),
      angles,
      swingThetaDeg: thetaDeg,
    });
  }
}

/** Batch convenience: run a full sample array through the detector — the same
    code path a recorded capture replays through offline. */
export function detectSwings(
  samples: SwingSample[],
  options?: SwingDetectorOptions,
  collect?: { holds?: WristHold[]; phases?: WristPhaseEvent[] },
): WristShot[] {
  const out: WristShot[] = [];
  const detector = new SwingDetector(
    {
      onSwing: (shot) => out.push(shot),
      onHold: (hold) => collect?.holds?.push(hold),
      onPhase: (phase) => collect?.phases?.push(phase),
    },
    options,
  );
  for (const sample of samples) detector.push(sample);
  detector.flush();
  return out;
}
