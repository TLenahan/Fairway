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
 * Address-armed swing phase machine — the wrist unit's PRIMARY shot detection.
 *
 * The protocol: the golfer holds still over the ball (the HOLD), which freezes
 * an address reference pose; the next motion burst out of a qualifying hold is
 * the swing. Detection is structural, not threshold-lucky:
 *
 * - The motion envelope is the ABSOLUTE angular rate of the two IMUs (max of
 *   both), not the inter-IMU rate — a lag-held downswing barely moves the
 *   wrist hinge but the arm still rotates fast, and conversely a waggle is
 *   pure hinge with no address hold ever preceding it. No hold ⇒ no swing.
 * - The top is a genuine reversal: θ(t) = the larger IMU's rotation away from
 *   the frozen address pose rises through the backswing, peaks at the top, and
 *   returns toward ~0 as the hands re-enter the address zone. A pause at the
 *   top just dwells at θmax — nothing finalizes until a downswing follows.
 * - The impact ZONE is θ's minimum during the downswing (hands back at the
 *   address pose at speed). It is a swing-geometry landmark and the launch-
 *   monitor join key — NEVER a claim that a ball was struck. Whether this
 *   swing hit a ball is the launch monitor's call alone.
 * - All phase durations are timed on the device clock (unwrapped tsA), never
 *   BLE arrival time — batching would otherwise quantize tempo by ~30 ms.
 *
 * Caveat: θ is a geodesic angle in [0°, 180°]; a rotation passing 180° folds
 * back. Wedge swings top out well below the fold; if driver-length capture
 * data shows folding near the top, switch θ to a signed projection on the
 * backswing's dominant axis.
 *
 * Real-time hooks: `onHold` streams hold progress (drives the drill's
 * "hold still… GO" cue) and `onPhase` fires at takeaway / top / impact zone /
 * finish / abort — the top event is what at-the-top buzz feedback keys on.
 */
export interface SwingSample {
  tMs: number; // arrival epoch ms — carried onto keyframes for the store join
  tsa: number; // raw u16 device timestamp — the timing base
  qA: Quat; // IMU A absolute orientation (w-first, de-scaled)
  qB: Quat; // IMU B absolute orientation
  shock: number; // max |imu| across channels (context only)
}

export interface SwingDetectorOptions {
  /** stillness ceiling (deg/s) — below this the golfer counts as holding */
  holdStillDegS?: number;
  /** stillness required to arm the detector (ms) */
  holdRequiredMs?: number;
  /** hold survives this long between the last still sample and takeaway —
      the takeaway ramp crosses the stillness ceiling before the enter gate */
  holdGraceMs?: number;
  enterDegS?: number; // takeaway: envelope crosses this out of a hold
  exitDegS?: number; // quiet: envelope back below this
  topEpsDeg?: number; // dwell band around θmax that still counts as "at the top"
  reversalMarginDeg?: number; // θ retreat that confirms a direction change
  minTopDeg?: number; // below this a "backswing" is a waggle, not a swing
  maxImpactReturnDeg?: number; // hands must come back within this of address
  minPeakDegS?: number; // downswing envelope floor
  downswingSpeedRatio?: number; // downswing peak must beat backswing peak × this
  /** after a swing, a new hold arms only once the pose has moved this far
      from the finish — holding the finish must not re-trigger the GO cue */
  rearmMinPoseDeg?: number;
  minBackswingMs?: number;
  minDownswingMs?: number;
  maxDownswingMs?: number;
  quietMs?: number; // sustained quiet that ends the follow-through
  backswingTimeoutMs?: number;
  downswingTimeoutMs?: number;
  followthroughTimeoutMs?: number;
  smoothWindow?: number; // envelope moving-average window (samples)
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

type State = 'address' | 'motion' | 'backswing' | 'downswing' | 'followthrough';

const NULL_ANGLES: WristAngles = {
  extensionDeg: null,
  deviationDeg: null,
  rotationDeg: null,
};

const HOLD_BUFFER_CAP = 256; // ~2.6 s at 100 Hz — plenty for a stable average
const HOLD_EMIT_EVERY_S = 0.1;
const BACKSWING_REARM_STILL_S = 0.8; // still this long mid-backswing = re-address

export class SwingDetector {
  private readonly opts: Required<Omit<SwingDetectorOptions, 'calibration'>>;
  private readonly handlers: SwingDetectorHandlers;
  private calibration: WristCalibration | null;

  // device clock
  private prevTsaRaw: number | null = null;
  private tsaUnwrapped = 0;

  // envelope
  private prev: Processed | null = null;
  private omegaWindow: number[] = [];

  private state: State = 'address';

  // hold accumulation (address state)
  private holdStartTDev: number | null = null;
  private lastStillTDev = 0;
  private heldAtLastStillMs = 0;
  private lastStillSample: Processed | null = null;
  private qABuf: Quat[] = [];
  private qBBuf: Quat[] = [];
  private qRelBuf: Quat[] = [];
  private lastHoldEmitTDev = -Infinity;
  private lastEmittedArmed = false;

  // armed swing (backswing → followthrough)
  private qAAddr: Quat = [1, 0, 0, 0];
  private qBAddr: Quat = [1, 0, 0, 0];
  private qRelAddr: Quat = [1, 0, 0, 0];
  private addressSample: Processed | null = null;
  private addressHeldMs = 0;
  private tTakeawayDev = 0;
  private thetaMax = 0;
  private topSample: Processed | null = null;
  private tTopFirstDev = 0;
  private tTopLastDev = 0;
  private omegaPeakBack = 0;
  private thetaMin = Infinity;
  private impactSample: Processed | null = null;
  private omegaPeakDown = 0;
  private shockPeak = 0;
  private shockSample: Processed | null = null;
  private stillSinceDev: number | null = null;
  private quietSinceDev: number | null = null;
  private tDownswingStartDev = 0;
  private tImpactZoneDev = 0;
  // finish pose of the last completed swing — blocks re-arming until the
  // golfer actually moves (lowers the club to re-address)
  private postSwingQB: Quat | null = null;

  constructor(
    handlers: SwingDetectorHandlers,
    options: SwingDetectorOptions = {},
  ) {
    this.handlers = handlers;
    this.opts = {
      holdStillDegS: options.holdStillDegS ?? 30,
      holdRequiredMs: options.holdRequiredMs ?? 1500,
      holdGraceMs: options.holdGraceMs ?? 600,
      enterDegS: options.enterDegS ?? 100,
      exitDegS: options.exitDegS ?? 30,
      topEpsDeg: options.topEpsDeg ?? 2,
      reversalMarginDeg: options.reversalMarginDeg ?? 10,
      minTopDeg: options.minTopDeg ?? 25,
      maxImpactReturnDeg: options.maxImpactReturnDeg ?? 35,
      minPeakDegS: options.minPeakDegS ?? 200,
      downswingSpeedRatio: options.downswingSpeedRatio ?? 1.2,
      rearmMinPoseDeg: options.rearmMinPoseDeg ?? 30,
      minBackswingMs: options.minBackswingMs ?? 200,
      minDownswingMs: options.minDownswingMs ?? 80,
      maxDownswingMs: options.maxDownswingMs ?? 700,
      quietMs: options.quietMs ?? 250,
      backswingTimeoutMs: options.backswingTimeoutMs ?? 12000,
      downswingTimeoutMs: options.downswingTimeoutMs ?? 2000,
      followthroughTimeoutMs: options.followthroughTimeoutMs ?? 4000,
      smoothWindow: Math.max(1, options.smoothWindow ?? 5),
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
    switch (this.state) {
      case 'address':
        this.stepAddress(p);
        return;
      case 'motion':
        this.stepMotion(p);
        return;
      case 'backswing':
        this.stepBackswing(p);
        return;
      case 'downswing':
        this.stepDownswing(p);
        return;
      case 'followthrough':
        this.stepFollowthrough(p);
        return;
    }
  }

  /** Finalize any swing still in flight at stream end (disconnect). */
  flush(): void {
    if (this.state === 'downswing' || this.state === 'followthrough') {
      this.finalize(this.prev);
    } else if (this.state === 'backswing') {
      this.emitPhase('aborted', this.prev);
    }
    this.state = 'motion';
  }

  /* ────────────────────── per-sample processing ────────────────────── */

  private process(sample: SwingSample): Processed {
    if (this.prevTsaRaw !== null) {
      let delta = sample.tsa - this.prevTsaRaw;
      if (delta < -32768) delta += 65536;
      else if (delta > 32768) delta -= 65536;
      this.tsaUnwrapped += delta;
    }
    this.prevTsaRaw = sample.tsa;
    const tDev = this.tsaUnwrapped / this.opts.deviceClockHz;

    // absolute-rate envelope: the faster of the two IMUs, world-frame
    let rawOmega = this.prev?.omega ?? 0;
    if (this.prev !== null) {
      const dt = tDev - this.prev.tDev;
      if (dt > 0) {
        const rateA = rotationAngle(qMul(qConj(this.prev.qA), sample.qA));
        const rateB = rotationAngle(qMul(qConj(this.prev.qB), sample.qB));
        rawOmega = (Math.max(rateA, rateB) * RAD_TO_DEG) / dt;
      }
    }
    this.omegaWindow.push(rawOmega);
    if (this.omegaWindow.length > this.opts.smoothWindow) {
      this.omegaWindow.shift();
    }
    const omega =
      this.omegaWindow.reduce((a, b) => a + b, 0) / this.omegaWindow.length;

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

  /** Rotation away from the frozen address pose (deg) — larger of both IMUs. */
  private thetaFromAddress(p: Processed): number {
    const a = rotationAngle(qMul(qConj(this.qAAddr), p.qA));
    const b = rotationAngle(qMul(qConj(this.qBAddr), p.qB));
    return Math.max(a, b) * RAD_TO_DEG;
  }

  /** A fresh hold may arm only once the golfer has left the last swing's
      finish pose — otherwise holding the finish re-triggers the GO cue. */
  private awayFromFinish(): boolean {
    if (this.postSwingQB === null) return true;
    const lastQB = this.qBBuf[this.qBBuf.length - 1];
    if (lastQB === undefined) return false;
    const moved =
      rotationAngle(qMul(qConj(this.postSwingQB), lastQB)) * RAD_TO_DEG;
    return moved >= this.opts.rearmMinPoseDeg;
  }

  /* ────────────────────── state steps ────────────────────── */

  private stepAddress(p: Processed): void {
    const still = p.omega < this.opts.holdStillDegS;
    if (still) {
      if (this.holdStartTDev === null) {
        this.holdStartTDev = p.tDev;
        this.qABuf = [];
        this.qBBuf = [];
        this.qRelBuf = [];
      }
      if (this.qABuf.length >= HOLD_BUFFER_CAP) {
        this.qABuf.shift();
        this.qBBuf.shift();
        this.qRelBuf.shift();
      }
      this.qABuf.push(p.qA);
      this.qBBuf.push(p.qB);
      this.qRelBuf.push(p.qRel);
      const heldMs = (p.tDev - this.holdStartTDev) * 1000;
      this.lastStillTDev = p.tDev;
      this.heldAtLastStillMs = heldMs;
      this.lastStillSample = p;
      this.emitHold(
        p,
        heldMs,
        heldMs >= this.opts.holdRequiredMs && this.awayFromFinish(),
      );
      return;
    }

    const sinceStillMs = (p.tDev - this.lastStillTDev) * 1000;
    const armed =
      this.holdStartTDev !== null &&
      this.heldAtLastStillMs >= this.opts.holdRequiredMs &&
      sinceStillMs <= this.opts.holdGraceMs &&
      this.qRelBuf.length >= 8 &&
      this.awayFromFinish();

    if (p.omega >= this.opts.enterDegS) {
      if (armed) this.beginSwing(p);
      else this.resetHoldTo('motion', p);
      return;
    }
    // between the stillness ceiling and the enter gate: a fidget. Tolerate it
    // for the grace window (the takeaway ramp lives here), then drop the hold.
    if (this.holdStartTDev !== null && sinceStillMs > this.opts.holdGraceMs) {
      this.resetHoldTo('address', p);
    }
  }

  private stepMotion(p: Processed): void {
    if (p.omega < this.opts.holdStillDegS) {
      this.state = 'address';
      this.holdStartTDev = null;
      this.stepAddress(p);
    }
  }

  private stepBackswing(p: Processed): void {
    const theta = this.thetaFromAddress(p);
    this.omegaPeakBack = Math.max(this.omegaPeakBack, p.omega);
    this.trackShock(p);

    if (theta > this.thetaMax) {
      this.thetaMax = theta;
      this.topSample = p;
      this.tTopFirstDev = p.tDev;
      this.tTopLastDev = p.tDev;
    } else if (theta >= this.thetaMax - this.opts.topEpsDeg) {
      this.tTopLastDev = p.tDev; // dwelling at the top (pause)
    }

    // reversal: the backswing turned around
    if (theta <= this.thetaMax - this.opts.reversalMarginDeg) {
      if (this.thetaMax >= this.opts.minTopDeg) {
        this.state = 'downswing';
        this.tDownswingStartDev = p.tDev;
        this.thetaMin = theta;
        this.impactSample = p;
        this.omegaPeakDown = p.omega;
        this.emitPhase('top', this.topSample);
      } else {
        // sub-swing wiggle (forward press, waggle while armed): restart the
        // climb from here rather than disarming — the real swing follows
        this.thetaMax = theta;
        this.topSample = p;
        this.tTopFirstDev = p.tDev;
        this.tTopLastDev = p.tDev;
      }
    }

    // gone still without ever making a backswing: the golfer re-addressed
    if (p.omega < this.opts.holdStillDegS) {
      if (this.stillSinceDev === null) this.stillSinceDev = p.tDev;
      if (
        p.tDev - this.stillSinceDev >= BACKSWING_REARM_STILL_S &&
        this.thetaMax < this.opts.minTopDeg
      ) {
        this.abandonSwing(p);
        return;
      }
    } else {
      this.stillSinceDev = null;
    }

    if ((p.tDev - this.tTakeawayDev) * 1000 > this.opts.backswingTimeoutMs) {
      this.abandonSwing(p);
    }
  }

  private stepDownswing(p: Processed): void {
    const theta = this.thetaFromAddress(p);
    this.omegaPeakDown = Math.max(this.omegaPeakDown, p.omega);
    this.trackShock(p);

    if (theta < this.thetaMin) {
      this.thetaMin = theta;
      this.impactSample = p;
    }
    // the hands passed the address zone and are climbing into the finish
    if (theta >= this.thetaMin + this.opts.reversalMarginDeg) {
      this.state = 'followthrough';
      this.tImpactZoneDev = this.impactSample?.tDev ?? p.tDev;
      this.quietSinceDev = null;
      this.emitPhase('impactZone', this.impactSample);
      return;
    }
    if ((p.tDev - this.tDownswingStartDev) * 1000 > this.opts.downswingTimeoutMs) {
      this.abandonSwing(p);
    }
  }

  private stepFollowthrough(p: Processed): void {
    this.trackShock(p);
    if (p.omega < this.opts.exitDegS) {
      if (this.quietSinceDev === null) this.quietSinceDev = p.tDev;
      if ((p.tDev - this.quietSinceDev) * 1000 >= this.opts.quietMs) {
        this.finalize(p);
        return;
      }
    } else {
      this.quietSinceDev = null;
    }
    if (
      (p.tDev - this.tImpactZoneDev) * 1000 >
      this.opts.followthroughTimeoutMs
    ) {
      this.finalize(p);
    }
  }

  /* ────────────────────── transitions ────────────────────── */

  private beginSwing(p: Processed): void {
    this.qAAddr = markleyAverage(this.qABuf);
    this.qBAddr = markleyAverage(this.qBBuf);
    this.qRelAddr = markleyAverage(this.qRelBuf);
    this.addressSample = this.lastStillSample;
    this.addressHeldMs = this.heldAtLastStillMs;
    this.holdStartTDev = null;

    this.state = 'backswing';
    this.tTakeawayDev = p.tDev;
    this.thetaMax = this.thetaFromAddress(p);
    this.topSample = p;
    this.tTopFirstDev = p.tDev;
    this.tTopLastDev = p.tDev;
    this.omegaPeakBack = p.omega;
    this.thetaMin = Infinity;
    this.impactSample = null;
    this.omegaPeakDown = 0;
    this.shockPeak = p.shock;
    this.shockSample = p;
    this.stillSinceDev = null;
    this.postSwingQB = null;
    this.emitHold(p, 0, false, true);
    this.emitPhase('takeaway', p);
  }

  private abandonSwing(p: Processed): void {
    this.emitPhase('aborted', p);
    this.state = 'motion';
    this.holdStartTDev = null;
  }

  private resetHoldTo(state: 'address' | 'motion', p: Processed): void {
    const hadHold = this.holdStartTDev !== null;
    this.holdStartTDev = null;
    this.state = state;
    if (hadHold) this.emitHold(p, 0, false, true);
  }

  private trackShock(p: Processed): void {
    if (p.shock > this.shockPeak) {
      this.shockPeak = p.shock;
      this.shockSample = p;
    }
  }

  private finalize(last: Processed | null): void {
    this.state = 'motion';
    this.holdStartTDev = null;
    const address = this.addressSample;
    const top = this.topSample;
    const impact = this.impactSample;
    if (address === null || top === null || impact === null || last === null) {
      this.emitPhase('aborted', last);
      return;
    }

    const backswingMs = (this.tTopFirstDev - this.tTakeawayDev) * 1000;
    const topPauseMs = Math.max(0, (this.tTopLastDev - this.tTopFirstDev) * 1000);
    const downswingMs = (impact.tDev - this.tTopLastDev) * 1000;
    const o = this.opts;
    const valid =
      this.thetaMax >= o.minTopDeg &&
      this.thetaMin <= o.maxImpactReturnDeg &&
      this.omegaPeakDown >= o.minPeakDegS &&
      this.omegaPeakDown >= this.omegaPeakBack * o.downswingSpeedRatio &&
      backswingMs >= o.minBackswingMs &&
      downswingMs >= o.minDownswingMs &&
      downswingMs <= o.maxDownswingMs;
    if (!valid) {
      this.emitPhase('aborted', last);
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
    this.emitPhase('finish', last);
    this.handlers.onSwing(shot);
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

  /** The address keyframe reads the AVERAGED hold pose, not one noisy sample —
      this is the pre-swing angle snapshot the drill inspects. */
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

  private emitPhase(
    phase: WristPhaseEvent['phase'],
    p: Processed | null,
  ): void {
    if (this.handlers.onPhase === undefined || p === null) return;
    const { angles } = this.anglesOf(p.qRel);
    this.handlers.onPhase({
      phase,
      tMs: p.tMs,
      rotVecFromAddressDeg: this.fromAddressDeg(p.qRel),
      angles,
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
