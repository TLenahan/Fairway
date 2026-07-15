import { WristAngles, WristKeyframe, WristShot } from '@golf/types';

import { anatomicalAnglesDeg, WristCalibration } from './calibration';
import { DEVICE_CLOCK_HZ } from './protocol';
import {
  qCanonical,
  qConj,
  qMul,
  Quat,
  quatToRotVec,
  RAD_TO_DEG,
  rotationAngle,
  Vec3,
} from './quaternion';

/**
 * Streaming swing detector, ported from `analyze.py swings`. The protocol
 * carries no impact event, so we detect swings host-side from the relative
 * angular speed of the two IMUs. Speed is timed by the DEVICE clock (tsA), never
 * host arrival time — BLE batches ~2 records per packet, which would otherwise
 * inflate speed ~100×. Impact is the peak-speed instant (a proxy); `shock` is
 * the accel-channel candidate for true ball contact, unvalidated until
 * cross-checked against launch-monitor shot timing.
 */
export interface SwingSample {
  tMs: number; // arrival epoch ms — carried onto keyframes for the store join
  tsa: number; // raw u16 device timestamp — the angular-speed time base
  qRel: Quat; // inter-IMU relative quaternion (canonical)
  shock: number; // max |imu| across channels
}

export interface SwingDetectorOptions {
  enterDegS?: number; // open a swing above this
  exitDegS?: number; // close it below this
  minMs?: number; // drop events shorter than this
  mergeMs?: number; // bridge dips shorter than this (top of backswing)
  smoothWindow?: number; // angular-speed moving-average window (samples)
  deviceClockHz?: number;
  /** When set, keyframes carry anatomical angles + neutral-relative rotation
      vectors; otherwise angles are null and rotation vectors are raw-relative. */
  calibration?: WristCalibration | null;
}

interface Processed {
  tMs: number;
  tDev: number; // device seconds
  qRel: Quat;
  shock: number;
  omega: number; // smoothed angular speed, deg/s
}

const NULL_ANGLES: WristAngles = {
  extensionDeg: null,
  deviationDeg: null,
  rotationDeg: null,
};

export class SwingDetector {
  private readonly enterDegS: number;
  private readonly exitDegS: number;
  private readonly minMs: number;
  private readonly mergeMs: number;
  private readonly smoothWindow: number;
  private readonly deviceClockHz: number;
  private readonly calibration: WristCalibration | null;

  private buf: Processed[] = [];
  private prevTsaRaw: number | null = null;
  private tsaUnwrapped = 0;
  private prevQRel: Quat | null = null;
  private omegaWindow: number[] = [];
  private inSwing = false;
  private regionStart = 0;
  private belowSince: number | null = null;

  constructor(
    private readonly onSwing: (shot: WristShot) => void,
    options: SwingDetectorOptions = {},
  ) {
    this.enterDegS = options.enterDegS ?? 80;
    this.exitDegS = options.exitDegS ?? 25;
    this.minMs = options.minMs ?? 250;
    this.mergeMs = options.mergeMs ?? 200;
    this.smoothWindow = Math.max(1, options.smoothWindow ?? 5);
    this.deviceClockHz = options.deviceClockHz ?? DEVICE_CLOCK_HZ;
    this.calibration = options.calibration ?? null;
  }

  push(sample: SwingSample): void {
    if (this.prevTsaRaw !== null) {
      let delta = sample.tsa - this.prevTsaRaw;
      if (delta < -32768) delta += 65536;
      else if (delta > 32768) delta -= 65536;
      this.tsaUnwrapped += delta;
    }
    this.prevTsaRaw = sample.tsa;
    const tDev = this.tsaUnwrapped / this.deviceClockHz;

    let rawOmega = 0;
    if (this.prevQRel !== null && this.buf.length > 0) {
      const dtDev = tDev - this.buf[this.buf.length - 1].tDev;
      if (dtDev > 0) {
        const dq = qMul(qConj(this.prevQRel), sample.qRel);
        rawOmega = (rotationAngle(dq) * RAD_TO_DEG) / dtDev;
      }
    }
    this.prevQRel = sample.qRel;

    this.omegaWindow.push(rawOmega);
    if (this.omegaWindow.length > this.smoothWindow) this.omegaWindow.shift();
    const omega =
      this.omegaWindow.reduce((a, b) => a + b, 0) / this.omegaWindow.length;

    this.buf.push({
      tMs: sample.tMs,
      tDev,
      qRel: sample.qRel,
      shock: sample.shock,
      omega,
    });
    const n = this.buf.length - 1;

    if (!this.inSwing) {
      if (omega >= this.enterDegS) {
        this.inSwing = true;
        this.regionStart = n;
        this.belowSince = null;
      } else {
        this.trimIdle();
      }
      return;
    }

    if (omega < this.exitDegS) {
      if (this.belowSince === null) this.belowSince = tDev;
    } else {
      this.belowSince = null;
    }
    if (
      this.belowSince !== null &&
      tDev - this.belowSince >= this.mergeMs / 1000
    ) {
      this.finalize(this.regionStart, n);
      this.inSwing = false;
      this.belowSince = null;
      this.trimIdle();
    }
  }

  /** Finalize any swing still open at stream end (disconnect / batch flush). */
  flush(): void {
    if (this.inSwing) {
      this.finalize(this.regionStart, this.buf.length - 1);
      this.inSwing = false;
      this.belowSince = null;
    }
  }

  private trimIdle(): void {
    if (this.inSwing || this.buf.length <= 256) return;
    this.buf = this.buf.slice(this.buf.length - 128);
  }

  private finalize(startIdx: number, endIdx: number): void {
    let regionEnd = startIdx;
    for (let i = startIdx; i <= endIdx; i += 1) {
      if (this.buf[i].omega >= this.exitDegS) regionEnd = i;
    }
    const durationMs =
      (this.buf[regionEnd].tDev - this.buf[startIdx].tDev) * 1000;
    if (durationMs < this.minMs) return;

    let impactIdx = startIdx;
    for (let i = startIdx; i <= regionEnd; i += 1) {
      if (this.buf[i].omega > this.buf[impactIdx].omega) impactIdx = i;
    }
    let topIdx = startIdx;
    for (let i = startIdx; i <= impactIdx; i += 1) {
      if (this.buf[i].omega < this.buf[topIdx].omega) topIdx = i;
    }
    let addressIdx = startIdx > 0 ? startIdx - 1 : 0;
    for (let i = startIdx - 1; i >= 0; i -= 1) {
      addressIdx = i;
      if (this.buf[i].omega < this.exitDegS) break;
    }
    let shockIdx = startIdx;
    for (let i = startIdx; i <= regionEnd; i += 1) {
      if (this.buf[i].shock > this.buf[shockIdx].shock) shockIdx = i;
    }

    this.onSwing({
      tImpactMs: this.buf[impactIdx].tMs,
      durationMs,
      peakAngularSpeedDegS: this.buf[impactIdx].omega,
      calibrated: this.calibration !== null,
      address: this.keyframe(addressIdx),
      top: this.keyframe(topIdx),
      impact: this.keyframe(impactIdx),
      shock: {
        tMs: this.buf[shockIdx].tMs,
        offsetFromImpactMs: this.buf[shockIdx].tMs - this.buf[impactIdx].tMs,
        peakAbsLsb: this.buf[shockIdx].shock,
      },
    });
  }

  private keyframe(idx: number): WristKeyframe {
    const s = this.buf[idx];
    let rotVec: Vec3;
    let angles: WristAngles;
    if (this.calibration !== null) {
      const qAnat = qCanonical(qMul(qConj(this.calibration.qRef), s.qRel));
      rotVec = quatToRotVec(qAnat);
      const [ext, dev, rot] = anatomicalAnglesDeg(this.calibration.frame, qAnat);
      angles = { extensionDeg: ext, deviationDeg: dev, rotationDeg: rot };
    } else {
      rotVec = quatToRotVec(s.qRel);
      angles = NULL_ANGLES;
    }
    return {
      tMs: s.tMs,
      angularSpeedDegS: s.omega,
      angles,
      rotVecDeg: [
        rotVec[0] * RAD_TO_DEG,
        rotVec[1] * RAD_TO_DEG,
        rotVec[2] * RAD_TO_DEG,
      ],
    };
  }
}

/** Batch convenience: run a full sample array through the detector. */
export function detectSwings(
  samples: SwingSample[],
  options?: SwingDetectorOptions,
): WristShot[] {
  const out: WristShot[] = [];
  const detector = new SwingDetector((shot) => out.push(shot), options);
  for (const sample of samples) detector.push(sample);
  detector.flush();
  return out;
}
