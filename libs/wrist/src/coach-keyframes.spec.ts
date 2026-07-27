import { WristCalibration, WristKeyframe, WristShot } from '@golf/types';

import {
  CoachKeyframeExtractor,
  SETUP_WINDOW_MS,
} from './coach-keyframes';
import { axisAngleToQuat, DEG_TO_RAD, qMul, Quat } from './quaternion';
import { SwingSample } from './swing-detector';

/**
 * Contract tests for the coach keyframe extraction. Traces are synthesized in
 * ANGLE space: with the identity calibration below, qRel = qB and
 * anatomicalAnglesDeg recovers exactly the extension/deviation the rig
 * planted (R = Rx(ext)·Ry(dev), the calibration's own Euler order), so every
 * assertion is against known ground truth.
 */

const IDENTITY_CAL: WristCalibration = {
  qRef: [1, 0, 0, 0],
  frame: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
};

const X_AXIS = [1, 0, 0] as const;
const Y_AXIS = [0, 1, 0] as const;
const Z_AXIS = [0, 0, 1] as const;
const IDENTITY_Q: Quat = [1, 0, 0, 0];

const DT_S = 0.025; // the unit's mean cadence
const TSA_PER_STEP = 1600; // 0.025 s at 64 kHz

/** Deterministic noise — no Math.random in specs. */
class Lcg {
  private state = 0x2f6e2b1;
  /** uniform in [-1, 1) */
  next(): number {
    this.state = (this.state * 48271) % 2147483647;
    return (this.state / 2147483647) * 2 - 1;
  }
}

class AngleRig {
  readonly samples: SwingSample[] = [];
  private ext: number;
  private dev: number;
  private rot: number;
  private tMs = 1_784_000_000_000;
  private tsa = 0;
  private readonly rand = new Lcg();
  // mirror of the extractor's device-clock unwrap (same arithmetic), so
  // lastTDev() stays exact even when a stall warps the wrapped u16 delta
  private mirrorPrevTsa: number | null = null;
  private mirrorPrevTMs: number | null = null;
  private mirrorUnwrapped = 0;
  private mirrorTDev = 0;

  constructor(ext = 24, dev = 2.5, rot = -1) {
    this.ext = ext;
    this.dev = dev;
    this.rot = rot;
  }

  /** the extractor's tDev for the LAST emitted sample (first sample = 0) */
  lastTDev(): number {
    return this.mirrorTDev;
  }

  private emit(ext: number, dev: number, rot = this.rot): void {
    this.tsa = (this.tsa + TSA_PER_STEP) % 65536;
    this.tMs += DT_S * 1000;
    if (this.mirrorPrevTMs !== null && this.tMs - this.mirrorPrevTMs > 1000) {
      this.mirrorUnwrapped += ((this.tMs - this.mirrorPrevTMs) / 1000) * 64000;
      this.mirrorPrevTsa = null;
    }
    this.mirrorPrevTMs = this.tMs;
    if (this.mirrorPrevTsa !== null) {
      let d = this.tsa - this.mirrorPrevTsa;
      if (d < -32768) d += 65536;
      else if (d > 32768) d -= 65536;
      this.mirrorUnwrapped += d;
    }
    this.mirrorPrevTsa = this.tsa;
    this.mirrorTDev = this.mirrorUnwrapped / 64000;
    const qB = qMul(
      qMul(
        axisAngleToQuat(X_AXIS, ext * DEG_TO_RAD),
        axisAngleToQuat(Y_AXIS, dev * DEG_TO_RAD),
      ),
      axisAngleToQuat(Z_AXIS, rot * DEG_TO_RAD),
    );
    this.samples.push({
      tMs: this.tMs,
      tsa: this.tsa,
      qA: IDENTITY_Q,
      qB,
      shock: 50,
    });
  }

  hold(seconds: number, noiseDeg = 0, spikeAtS: number | null = null): this {
    const n = Math.round(seconds / DT_S);
    const spikeAt = spikeAtS === null ? -1 : Math.round(spikeAtS / DT_S);
    for (let i = 0; i < n; i += 1) {
      const spike = i === spikeAt ? 15 : 0;
      this.emit(
        this.ext + noiseDeg * this.rand.next() + spike,
        this.dev + noiseDeg * this.rand.next(),
        this.rot + noiseDeg * this.rand.next(),
      );
    }
    return this;
  }

  /** Cosine-eased move of the angles (rot optionally rides along). */
  move(
    extTo: number,
    devTo: number,
    seconds: number,
    noiseDeg = 0,
    rotTo = this.rot,
  ): this {
    const extFrom = this.ext;
    const devFrom = this.dev;
    const rotFrom = this.rot;
    const n = Math.round(seconds / DT_S);
    for (let i = 1; i <= n; i += 1) {
      const f = (1 - Math.cos((Math.PI * i) / n)) / 2;
      this.ext = extFrom + (extTo - extFrom) * f;
      this.dev = devFrom + (devTo - devFrom) * f;
      this.rot = rotFrom + (rotTo - rotFrom) * f;
      this.emit(
        this.ext + noiseDeg * this.rand.next(),
        this.dev + noiseDeg * this.rand.next(),
        this.rot + noiseDeg * this.rand.next(),
      );
    }
    return this;
  }

  /** Slow continuous wander — a golfer who never settles. */
  wander(seconds: number, ampDeg: number, periodS: number): this {
    const base = this.ext;
    const n = Math.round(seconds / DT_S);
    for (let i = 1; i <= n; i += 1) {
      this.ext = base + ampDeg * Math.sin((2 * Math.PI * i * DT_S) / periodS);
      this.emit(this.ext, this.dev);
    }
    return this;
  }

  /** Host-clock stall: the device keeps counting, frames stop arriving. */
  gap(seconds: number): this {
    const n = Math.round(seconds / DT_S);
    this.tsa = (this.tsa + n * TSA_PER_STEP) % 65536;
    this.tMs += n * DT_S * 1000;
    return this;
  }
}

const keyframeAt = (tDevS: number): WristKeyframe => ({
  tMs: 0,
  tDevS,
  angularSpeedDegS: 0,
  angles: { extensionDeg: null, deviationDeg: null, rotationDeg: null },
  rotVecDeg: [0, 0, 0],
  rotVecFromAddressDeg: [0, 0, 0],
});

/** Swing stub: the extractor reads only address.tDevS and impact.tDevS. */
const shotWith = (addressTDevS: number, impactTDevS: number): WristShot => ({
  tImpactMs: 0,
  durationMs: 1000,
  peakAngularSpeedDegS: 800,
  calibrated: true,
  addressHeldMs: 1500,
  backswingMs: 700,
  topPauseMs: 0,
  downswingMs: 300,
  address: keyframeAt(addressTDevS),
  top: keyframeAt((addressTDevS + impactTDevS) / 2),
  impact: keyframeAt(impactTDevS),
  shock: { tMs: 0, offsetFromImpactMs: 0, peakAbsLsb: 3000 },
});

const runExtractor = (
  rig: AngleRig,
  calibration: WristCalibration | null = IDENTITY_CAL,
): CoachKeyframeExtractor => {
  const extractor = new CoachKeyframeExtractor({ calibration });
  for (const s of rig.samples) extractor.push(s);
  return extractor;
};

/** The contract's example shape: pause at 24°, climb to 36°, transition dip
    (the ext reversal = top), re-extension to 38° early in the downswing (the
    cast — peak down), dump to 2° at impact. Deviation rides along 2.5 → 16 at
    the top → −19.5 at impact. */
const contractSwing = (noiseDeg = 0): { rig: AngleRig; shot: WristShot } => {
  const rig = new AngleRig(24, 2.5);
  rig.hold(1.5, Math.max(noiseDeg, 0.2));
  const addressTDev = rig.lastTDev();
  rig
    .move(36, 16, 0.6, noiseDeg, -34) // backswing climb (forearm pronates)
    .move(33.5, 14, 0.15, noiseDeg, -30) // transition dip — the extension top
    .move(38, 4, 0.15, noiseDeg, -18) // early-downswing re-extension (cast)
    .move(2, -19.5, 0.25, noiseDeg, 12.5); // dump into impact (supinating)
  const impactTDev = rig.lastTDev();
  rig.hold(0.5, noiseDeg);
  return { rig, shot: shotWith(addressTDev, impactTDev) };
};

describe('coach keyframes — setup window', () => {
  it('takes the per-angle median over the pause, ignoring a single spike', () => {
    const rig = new AngleRig(24, 2.5);
    // spike lands INSIDE the trailing 500 ms setup window
    rig.hold(1.5, 0.3, 1.5 - SETUP_WINDOW_MS / 1000 / 2);
    const addressTDev = rig.lastTDev();
    rig.move(36, 16, 0.6).move(33.5, 14, 0.15).move(38, 4, 0.15).move(2, -19.5, 0.25);
    const impactTDev = rig.lastTDev();
    rig.hold(0.5);

    const result = runExtractor(rig).extract(shotWith(addressTDev, impactTDev));
    if (result.status !== 'ok') throw new Error(`dropped: ${JSON.stringify(result)}`);
    expect(result.keyframes.setup.extensionDeg).toBeCloseTo(24, 0);
    expect(Math.abs(result.keyframes.setup.extensionDeg - 24)).toBeLessThan(0.25);
    expect(Math.abs(result.keyframes.setup.deviationDeg - 2.5)).toBeLessThan(0.25);
  });

  it('drops the block (no_setup) when the golfer never settles', () => {
    const rig = new AngleRig(24, 2.5);
    // ±6° at 0.7 s period: even a window straddling a sine extremum spans
    // ~10° — no 500 ms window is quiet
    rig.wander(6, 6, 0.7);
    const addressTDev = rig.lastTDev();
    rig.move(36, 16, 0.6).move(2, -19.5, 0.4);
    const impactTDev = rig.lastTDev();
    rig.hold(0.3);

    expect(runExtractor(rig).extract(shotWith(addressTDev, impactTDev))).toEqual({
      status: 'dropped',
      reason: 'no_setup',
    });
  });

  it('drops the block when a BLE stall separates the pause from the swing', () => {
    const rig = new AngleRig(24, 2.5);
    rig.hold(1.5, 0.2);
    rig.gap(2.0); // stall: the observed pause cannot vouch for this swing
    const addressTDev = rig.lastTDev() + 2.0 + DT_S;
    rig.move(36, 16, 0.6).move(2, -19.5, 0.4);
    const impactTDev = addressTDev + 1.0 - DT_S;
    rig.hold(0.3);

    expect(runExtractor(rig).extract(shotWith(addressTDev, impactTDev))).toEqual({
      status: 'dropped',
      reason: 'no_setup',
    });
  });

  it('drops the block on a sub-resync stall past the u16 half-wrap (512-1000 ms)', () => {
    // the detector rides these out (gap < gapResyncMs) but the device-clock
    // delta is ambiguous — the pause window must not span the stall, or a
    // re-grip during the outage exports a stale median
    const rig = new AngleRig(24, 2.5);
    rig.hold(1.5, 0.2);
    rig.gap(0.7);
    const addressTDev = rig.lastTDev() + DT_S; // post-stall tDev warps; anchor ≈ next sample
    rig.hold(0.15, 0.2); // brief re-settle, far too short for its own window
    rig.move(36, 16, 0.6).move(2, -19.5, 0.4);
    rig.hold(0.3);

    const extractor = runExtractor(rig);
    // the warped clock makes exact anchor times awkward here — what matters
    // is that NO pause window survives the break, whatever the anchor
    const result = extractor.extract(shotWith(addressTDev, addressTDev + 1.15));
    expect(result).toEqual({ status: 'dropped', reason: 'no_setup' });
  });

  it('drops the block when the last quiet dwell is at the WRONG pose (fidget)', () => {
    const rig = new AngleRig(24, 2.5);
    rig.hold(1.2, 0.2);
    // the golfer lifts to ~32° and dwells there, then barely re-settles —
    // the last qualifying low-variance window is the 32° dwell, whose median
    // would poison ext_setup. The detector's anchor sits back at the 24°
    // address, disagreeing with that median, so the block must drop.
    rig.move(32, 2.5, 0.1).hold(0.5).move(24, 2.5, 0.1);
    rig.hold(0.1, 0.2); // re-still, but far too short to qualify as a window
    const addressTDev = rig.lastTDev();
    rig.move(36, 16, 0.6).move(2, -19.5, 0.4);
    const impactTDev = rig.lastTDev();
    rig.hold(0.3);

    expect(runExtractor(rig).extract(shotWith(addressTDev, impactTDev))).toEqual({
      status: 'dropped',
      reason: 'no_setup',
    });
  });
});

describe('coach keyframes — top / peak down / impact', () => {
  it('finds the extension-reversal top and the early-downswing peak on a clean trace', () => {
    const { rig, shot } = contractSwing(0);
    const result = runExtractor(rig).extract(shot);
    if (result.status !== 'ok') throw new Error(`dropped: ${JSON.stringify(result)}`);
    expect(Math.abs(result.keyframes.top.extensionDeg - 36)).toBeLessThan(1);
    expect(Math.abs(result.keyframes.top.deviationDeg - 16)).toBeLessThan(1.5);
    expect(Math.abs(result.keyframes.peakDownExtensionDeg - 38)).toBeLessThan(0.75);
    expect(Math.abs(result.keyframes.impact.extensionDeg - 2)).toBeLessThan(0.75);
    expect(Math.abs(result.keyframes.impact.deviationDeg - -19.5)).toBeLessThan(1);
    expect(Math.abs(result.keyframes.setup.rotationDeg - -1)).toBeLessThan(0.25);
    expect(Math.abs(result.keyframes.top.rotationDeg - -34)).toBeLessThan(2);
    expect(Math.abs(result.keyframes.impact.rotationDeg - 12.5)).toBeLessThan(1);
  });

  it('still resolves the top on a noisy trace', () => {
    const { rig, shot } = contractSwing(0.5);
    const result = runExtractor(rig).extract(shot);
    if (result.status !== 'ok') throw new Error(`dropped: ${JSON.stringify(result)}`);
    expect(Math.abs(result.keyframes.top.extensionDeg - 36)).toBeLessThan(2);
    expect(Math.abs(result.keyframes.peakDownExtensionDeg - 38)).toBeLessThan(2);
    expect(Math.abs(result.keyframes.impact.extensionDeg - 2)).toBeLessThan(2);
  });

  it('a pure-flexion move (no extension reversal) resolves to the extension extremum', () => {
    const rig = new AngleRig(24, 2.5);
    rig.hold(1.5, 0.2);
    const addressTDev = rig.lastTDev();
    rig.move(10, 16, 0.7).move(-8, -12, 0.35); // ext only ever decreases
    const impactTDev = rig.lastTDev();
    rig.hold(0.4);

    const result = runExtractor(rig).extract(shotWith(addressTDev, impactTDev));
    if (result.status !== 'ok') throw new Error(`dropped: ${JSON.stringify(result)}`);
    // monotone flexion: the "top" tracks the running minimum into impact
    expect(result.keyframes.top.extensionDeg).toBeLessThan(-6);
    expect(Math.abs(result.keyframes.impact.extensionDeg - -8)).toBeLessThan(0.75);
  });
});

describe('coach keyframes — stream integrity', () => {
  it('uncalibrated stream drops every block as uncalibrated', () => {
    const { rig, shot } = contractSwing(0);
    expect(runExtractor(rig, null).extract(shot)).toEqual({
      status: 'dropped',
      reason: 'uncalibrated',
    });
  });

  it('an impact anchor that resolves no buffered sample is a glitch', () => {
    const { rig, shot } = contractSwing(0);
    const orphan = { ...shot, impact: keyframeAt(999) };
    expect(runExtractor(rig).extract(orphan)).toEqual({
      status: 'dropped',
      reason: 'glitch',
    });
  });
});
