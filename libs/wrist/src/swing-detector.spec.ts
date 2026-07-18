import { WristHold, WristPhaseEvent } from '@golf/types';

import {
  axisAngleToQuat,
  DEG_TO_RAD,
  qMul,
  Quat,
  quatToMatrix,
  Vec3,
} from './quaternion';
import { detectSwings, SwingSample } from './swing-detector';

const Z_AXIS: Vec3 = [0, 0, 1];
const X_AXIS: Vec3 = [1, 0, 0];
const IDENTITY_Q: Quat = [1, 0, 0, 0];
const DT_S = 0.01; // 100 Hz device rate
const TSA_PER_STEP = Math.round(DT_S * 64000); // wraps every ~1 s — exercises unwrap

const mag = (v: readonly [number, number, number]): number =>
  Math.hypot(v[0], v[1], v[2]);

/**
 * Synthetic swing rig. θ(t) is the hand IMU's SIGNED rotation about a fixed
 * axis: positive = backswing side, negative = past address into the follow-
 * through (matching real swing geometry — the finish is on the OPPOSITE side
 * of address from the top). Host arrival time is quantized to 30 ms batches
 * ON PURPOSE — every duration assertion below only holds if the detector
 * times phases on the device clock instead.
 *
 * `lag` mode welds IMU A to IMU B with a constant offset: the wrist hinge
 * (qRel) never changes even though both IMUs swing hard — the lag-held swing
 * an inter-IMU detector would be blind to.
 */
class Rig {
  readonly samples: SwingSample[] = [];
  private tS = 0;
  private tsa = 0;
  private thetaDeg = 0;

  constructor(private readonly lag = false) {}

  private emit(shock: number): void {
    const qB = axisAngleToQuat(Z_AXIS, this.thetaDeg * DEG_TO_RAD);
    const qA = this.lag
      ? qMul(qB, axisAngleToQuat(X_AXIS, 20 * DEG_TO_RAD))
      : IDENTITY_Q;
    this.samples.push({
      tMs: 1_000_000 + Math.floor(this.tS / 0.03) * 30,
      tsa: this.tsa,
      qA,
      qB,
      shock,
    });
  }

  private step(): void {
    this.tS += DT_S;
    this.tsa = (this.tsa + TSA_PER_STEP) % 65536;
  }

  /** Insert a host-clock stall: frames stop for `seconds` (BLE outage). The
      device clock keeps running underneath — the unwrap must resync. */
  gap(seconds: number): this {
    const n = Math.round(seconds / DT_S);
    for (let i = 0; i < n; i += 1) this.step();
    return this;
  }

  /** Teleport the pose home — the golfer moved during an outage. */
  home(): this {
    this.thetaDeg = 0;
    return this;
  }

  still(seconds: number, shock = 20): this {
    const n = Math.round(seconds / DT_S);
    for (let i = 0; i < n; i += 1) {
      this.step();
      this.emit(shock);
    }
    return this;
  }

  /** Cosine-eased θ ramp to `targetDeg` over `seconds`. */
  ramp(targetDeg: number, seconds: number, shock = 200): this {
    const from = this.thetaDeg;
    const n = Math.round(seconds / DT_S);
    for (let i = 1; i <= n; i += 1) {
      this.step();
      this.thetaDeg =
        from + ((targetDeg - from) * (1 - Math.cos((Math.PI * i) / n))) / 2;
      this.emit(shock);
    }
    return this;
  }

  /** θ oscillation around the current pose — a waggle. */
  wave(ampDeg: number, hz: number, seconds: number): this {
    const base = this.thetaDeg;
    const n = Math.round(seconds / DT_S);
    for (let i = 1; i <= n; i += 1) {
      this.step();
      this.thetaDeg = base + ampDeg * Math.sin(2 * Math.PI * hz * i * DT_S);
      this.emit(60);
    }
    this.thetaDeg = base;
    return this;
  }

  /** hold → backswing (+200°) → optional pause → downswing through the
      address into a −110° finish → settle */
  fullSwing(opts: { holdS?: number; pauseS?: number; topDeg?: number } = {}): this {
    return this.still(opts.holdS ?? 1.8)
      .ramp(opts.topDeg ?? 200, 0.7)
      .pauseAtTop(opts.pauseS ?? 0)
      .ramp(-110, 0.35, 4000)
      .still(1.0);
  }

  private pauseAtTop(seconds: number): this {
    const n = Math.round(seconds / DT_S);
    for (let i = 0; i < n; i += 1) {
      this.step();
      this.emit(50);
    }
    return this;
  }
}

const run = (
  rig: Rig,
  options?: Parameters<typeof detectSwings>[1],
): {
  swings: ReturnType<typeof detectSwings>;
  holds: WristHold[];
  phases: WristPhaseEvent[];
} => {
  const holds: WristHold[] = [];
  const phases: WristPhaseEvent[] = [];
  const swings = detectSwings(rig.samples, options, { holds, phases });
  return { swings, holds, phases };
};

describe('SwingDetector — clean swing out of an address hold', () => {
  const { swings, holds, phases } = run(new Rig().fullSwing());

  it('detects exactly one swing', () => {
    expect(swings).toHaveLength(1);
  });

  it('times phases on the device clock despite 30 ms host batching', () => {
    const s = swings[0];
    expect(s.addressHeldMs).toBeGreaterThan(1500);
    expect(s.backswingMs).toBeGreaterThan(450);
    expect(s.backswingMs).toBeLessThan(800);
    expect(s.topPauseMs).toBeLessThan(150); // flowing swing — no real pause
    expect(s.downswingMs).toBeGreaterThan(80);
    expect(s.downswingMs).toBeLessThan(320);
    expect(s.peakAngularSpeedDegS).toBeGreaterThan(1000);
  });

  it('orders keyframes and anchors angles to the address hold', () => {
    const s = swings[0];
    expect(s.address.tDevS).toBeLessThan(s.top.tDevS);
    expect(s.top.tDevS).toBeLessThan(s.impact.tDevS);
    expect(s.address.rotVecFromAddressDeg).toEqual([0, 0, 0]);
    // top: the hand rotated ~200° away from setup (qA still ⇒ hinge = θ)
    expect(mag(s.top.rotVecFromAddressDeg)).toBeGreaterThan(140);
    // impact zone: hands back near the address pose
    expect(mag(s.impact.rotVecFromAddressDeg)).toBeLessThan(30);
    expect(s.calibrated).toBe(false);
    expect(s.top.angles.extensionDeg).toBeNull();
    expect(s.shock.peakAbsLsb).toBe(4000);
  });

  it('emits the live phase sequence the drill buzzes on', () => {
    expect(phases.map((p) => p.phase)).toEqual([
      'takeaway',
      'top',
      'impactZone',
      'finish',
    ]);
    const top = phases[1];
    expect(mag(top.rotVecFromAddressDeg)).toBeGreaterThan(140);
  });

  it('streams hold progress and arms before the takeaway', () => {
    expect(holds.some((h) => h.armed)).toBe(true);
    const maxHeld = Math.max(...holds.map((h) => h.heldMs));
    expect(maxHeld).toBeGreaterThan(1500);
    // the takeaway resets the countdown: an armed event is followed by a zero
    const lastArmed = holds.map((h) => h.armed).lastIndexOf(true);
    expect(lastArmed).toBeGreaterThanOrEqual(0);
    expect(holds.slice(lastArmed + 1).some((h) => h.heldMs === 0)).toBe(true);
  });
});

describe('SwingDetector — hold-free detection', () => {
  it('detects a swing with NO address hold (the old machine found zero)', () => {
    const { swings } = run(
      new Rig()
        .still(0.4) // far too short to arm a drill hold
        .ramp(200, 0.7)
        .ramp(-110, 0.35, 4000)
        .still(1.0),
    );
    expect(swings).toHaveLength(1);
    expect(swings[0].addressHeldMs).toBeLessThan(1500);
  });

  it('detects consecutive rehearsal swings with no stillness between', () => {
    const rig = new Rig().still(0.5);
    // three swings chained through brief lulls only — swish swish swish
    for (let i = 0; i < 3; i += 1) {
      rig.ramp(200, 0.7).ramp(-110, 0.35, 3000).ramp(0, 0.6, 90).still(0.25);
    }
    const { swings } = run(rig);
    expect(swings).toHaveLength(3);
  });
});

describe('SwingDetector — the failure modes that motivated the rework', () => {
  it('rejects a waggle: no swing, no top phase', () => {
    const { swings, phases } = run(
      new Rig().still(2.0).wave(12, 1.5, 3.0).still(1.5),
    );
    expect(swings).toHaveLength(0);
    expect(phases.map((p) => p.phase)).not.toContain('top');
  });

  it('rejects a putt-scale stroke (below the validation top floor)', () => {
    const { swings } = run(
      new Rig().still(2.0).ramp(40, 0.6).ramp(-15, 0.4, 800).still(1.5),
    );
    expect(swings).toHaveLength(0);
  });

  it('rejects a backswing that returns slowly without a downswing', () => {
    const { swings } = run(
      new Rig().still(2.0).ramp(200, 0.7).ramp(0, 3.0, 60).still(1.5),
    );
    expect(swings).toHaveLength(0);
  });

  it('detects a lag-held swing where the wrist hinge never moves', () => {
    const { swings } = run(new Rig(true).fullSwing());
    expect(swings).toHaveLength(1);
    // the hinge genuinely did not change — from-address wrist delta is ~zero
    expect(mag(swings[0].top.rotVecFromAddressDeg)).toBeLessThan(5);
  });

  it('finds nothing in a still hold', () => {
    const { swings } = run(new Rig().still(5.0));
    expect(swings).toHaveLength(0);
  });

  it('a long pause at the top yields ONE swing, not a phantom', () => {
    const { swings } = run(new Rig().fullSwing({ pauseS: 2.0 }));
    expect(swings).toHaveLength(1);
    expect(swings[0].topPauseMs).toBeGreaterThan(1700);
    expect(swings[0].backswingMs).toBeLessThan(800); // pause not blamed on the backswing
    expect(swings[0].downswingMs).toBeLessThan(320); // …nor on the downswing
  });
});

describe('SwingDetector — stream breaks (BLE stalls)', () => {
  it('aborts a swing the gap interrupted and detects the next one clean', () => {
    const rig = new Rig().still(2.0).ramp(200, 0.7); // backswing, then stall
    rig.gap(34.5); // the real capture's 34.5 s outage wraps tsA ~34 times
    rig.home().still(1.5).fullSwing();
    const { swings } = run(rig);
    expect(swings).toHaveLength(1);
    // the surviving swing is the post-gap one — its durations are sane
    expect(swings[0].backswingMs).toBeLessThan(800);
    expect(swings[0].downswingMs).toBeLessThan(320);
  });
});

describe('SwingDetector — sequences and calibration', () => {
  it('holding the finish pose does not re-arm (no phantom GO)', () => {
    const rig = new Rig().fullSwing(); // ends holding the finish at θ=−110
    rig.still(3.0); // keep posing — a hold accumulates but must not arm
    const { swings, holds } = run(rig);
    expect(swings).toHaveLength(1);
    const takeawayReset = holds.findIndex(
      (h, i) => h.heldMs === 0 && holds.slice(0, i).some((x) => x.armed),
    );
    expect(takeawayReset).toBeGreaterThan(0);
    expect(holds.slice(takeawayReset).some((h) => h.armed)).toBe(false);
  });

  it('re-arms once the golfer leaves the finish and re-addresses', () => {
    const rig = new Rig().fullSwing();
    rig.ramp(0, 1.5, 40).still(2.0); // lower the club, settle over the ball
    const { holds } = run(rig);
    expect(holds[holds.length - 1]?.armed).toBe(true);
  });

  it('detects back-to-back swings, each re-armed by its own hold', () => {
    const rig = new Rig().fullSwing({ holdS: 2.0 });
    rig.ramp(0, 1.5, 40); // stroll back to address slowly (no false trigger)
    rig.fullSwing({ holdS: 2.0, topDeg: 160 });
    const { swings } = run(rig);
    expect(swings).toHaveLength(2);
    expect(mag(swings[1].top.rotVecFromAddressDeg)).toBeLessThan(
      mag(swings[0].top.rotVecFromAddressDeg),
    );
  });

  it('attaches anatomical angles when calibrated', () => {
    const { swings } = run(new Rig().fullSwing(), {
      calibration: { qRef: IDENTITY_Q, frame: quatToMatrix(IDENTITY_Q) },
    });
    expect(swings).toHaveLength(1);
    expect(swings[0].calibrated).toBe(true);
    expect(swings[0].top.angles.rotationDeg).not.toBeNull();
    expect(swings[0].address.angles.extensionDeg).not.toBeNull();
  });
});
