import { z } from 'zod';

/* ───────────────────────── wrist sensor (HackMotion) ─────────────────────────
   A BLE dual-IMU wrist unit, and the PRIMARY swing detector: shots are
   detected from the wrist-motion envelope alone (takeaway → top → downswing →
   impact zone — no address hold required); the EYE MINI's shot, when one
   joins, is additional context that confirms a ball was struck and supplies
   its flight. This is a PEER of MonitorService
   (device.ts), not an implementation of it — BLE pairing/streaming semantics
   differ from the Mini's networked model, and there is no ball/club-mode
   concept. The reverse-engineered protocol, record decode, calibration, and
   swing detection all live in @golf/wrist; this file is only the frozen
   contract every other lib shares.

   All timestamps are host arrival epoch ms (Date.now at packet receipt). The
   device's own clocks are opaque and unsynced, so arrival time is the only base
   the store can join wrist swings to launch-monitor shots on. */

/** BLE link lifecycle. Distinct from the monitor's ConnectionState: no
    local-network concept, but Bluetooth has its own denied/off states. */
export const WristConnectionState = z.enum([
  'disconnected',
  'scanning',
  'connecting',
  'connected',
  'error',
  'unauthorized', // Bluetooth permission denied by the OS
  'poweredOff', // Bluetooth radio is off
]);

/** A discovered / paired HackMotion unit. `id` is the platform BLE handle
    (CoreBluetooth UUID on iOS, MAC on Android). serial + battery fill in after
    connect via the identity and battery opcodes. */
export const WristDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  serial: z.string().nullable(),
  batteryPercent: z.number().nullable(),
});
export type WristDevice = z.infer<typeof WristDeviceSchema>;

/** One decoded telemetry record: both IMUs' quaternions (w-first, already
    de-scaled from wire Q14) plus their six raw int16 motion channels. Emitted on
    the `sample` event for a live view; the swing detector consumes these. */
export const WristSampleSchema = z.object({
  tMs: z.number(), // arrival epoch ms — the join's time base
  qA: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  qB: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  imuA: z.tuple([
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
  ]),
  imuB: z.tuple([
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
  ]),
});
export type WristSample = z.infer<typeof WristSampleSchema>;

/**
 * Anatomical-axis calibration — pure data, produced by @golf/wrist's
 * flat+raise procedure (the vendor's own flow: wrist flat in front of the
 * body → confirm → slowly raise the forearm, elbow still). `qRef` is the
 * flat-pose zero for the inter-IMU rotation; `frame` holds the orthonormal
 * anatomical axes [flexion, deviation, rotation] as columns, in IMU-A body
 * coordinates. Serializable so settings can persist it across sessions.
 */
/** Declared readonly (not z.infer) so @golf/wrist's immutable quaternion /
    matrix tuples assign directly; the schema's output is assignable to it. */
export interface WristCalibration {
  qRef: readonly [number, number, number, number];
  frame: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
}
export const WristCalibrationSchema: z.ZodType<WristCalibration> = z.object({
  qRef: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  frame: z.tuple([
    z.tuple([z.number(), z.number(), z.number()]),
    z.tuple([z.number(), z.number(), z.number()]),
    z.tuple([z.number(), z.number(), z.number()]),
  ]),
});

/** Anatomical wrist angles (degrees). Null until a calibration run has
    identified the anatomical axes (see @golf/wrist calibration). Before that
    only the keyframe's raw rotation vector is meaningful. */
export const WristAnglesSchema = z.object({
  extensionDeg: z.number().nullable(), // + = extension (cupping), − = flexion
  deviationDeg: z.number().nullable(), // radial / ulnar
  rotationDeg: z.number().nullable(), // pronation / supination
});
export type WristAngles = z.infer<typeof WristAnglesSchema>;

/** A single instant of a swing (address / top / impact). */
export const WristKeyframeSchema = z.object({
  tMs: z.number(), // arrival epoch ms
  tDevS: z.number(), // device-clock seconds (unwrapped tsA) — precise timing base
  angularSpeedDegS: z.number(),
  angles: WristAnglesSchema,
  // rotation vector (axis × angle, deg): neutral-relative when calibrated,
  // raw inter-IMU-relative otherwise. Singularity-free, unlike Euler angles.
  rotVecDeg: z.tuple([z.number(), z.number(), z.number()]),
  // wrist rotation away from THIS swing's address hold (axis × angle, deg).
  // Drift-free and strap-offset-free without any calibration — the drill's
  // primary signal. ~zero at the address keyframe by construction.
  rotVecFromAddressDeg: z.tuple([z.number(), z.number(), z.number()]),
});
export type WristKeyframe = z.infer<typeof WristKeyframeSchema>;

/** Address-hold progress: the golfer standing still over the ball. Streamed
    while stillness accumulates; `armed` flips when the hold satisfies the
    detector's minimum and the next motion burst will be treated as a swing. */
export const WristHoldSchema = z.object({
  tMs: z.number(), // arrival epoch ms
  heldMs: z.number(), // 0 on a reset (the golfer fidgeted / walked off)
  requiredMs: z.number(), // detector's arming threshold
  armed: z.boolean(),
});
export type WristHold = z.infer<typeof WristHoldSchema>;

/** Real-time swing landmarks, emitted as they are recognized (top fires a
    beat after the true top — the reversal must confirm first). This is what
    in-swing audio/haptic feedback keys on. */
export const WristSwingPhase = z.enum([
  'takeaway', // motion burst out of an armed hold
  'top', // rotation-from-address reversed — backswing peak located
  'impactZone', // hands back at the address pose at speed (NOT ball contact)
  'finish', // motion settled; the swing event follows if it validates
  'aborted', // armed motion that failed swing validation — discarded
]);
export const WristPhaseEventSchema = z.object({
  phase: WristSwingPhase,
  tMs: z.number(), // arrival epoch ms of the underlying sample
  rotVecFromAddressDeg: z.tuple([z.number(), z.number(), z.number()]),
  angles: WristAnglesSchema, // anatomical at the instant; nulls uncalibrated
  /** the detector's unwrapped swing rotation at the event (deg): for `top`
      the confirmed backswing peak — lets consumers tell a full-band swing
      (≥ the detector's validation floor) from a chip-band stroke */
  swingThetaDeg: z.number(),
});
export type WristPhaseEvent = z.infer<typeof WristPhaseEventSchema>;

/* ───────────────────── coach export (Reform Coach agent) ─────────────────────
   The wrist portion of the daily session-JSON export. The consumer computes
   only from fields that are present — a missing field is safe, a wrong field
   is poison — so extraction NEVER clamps or null-fills: a swing whose
   keyframes can't be trusted drops its entire block and is counted in the
   session coverage instead. Absolute calibrated angles at keyframes only; the
   agent derives deltas itself. */

/** Why a swing exported no keyframes. `no_setup`: no qualifying ≥500 ms
    low-variance address pause was found, so the swing's own segmentation is
    untrusted. `glitch`: the samples themselves can't be trusted (angle out of
    physical bounds, stream inconsistency). `uncalibrated`: no anatomical
    calibration was applied when the swing fired. */
export const WristCoachDropReason = z.enum([
  'no_setup',
  'glitch',
  'uncalibrated',
]);

/** Calibrated absolute anatomical angles at one keyframe (degrees, full
    precision — wire rounding happens at export serialization). Deviation and
    rotation SIGNS are handedness-dependent (radial-positive / supination-
    positive on the wire) and resolved at export time (@golf/analytics). */
export const WristCoachAnglesSchema = z.object({
  extensionDeg: z.number(), // + = extension (cupping), − = flexion
  deviationDeg: z.number(), // anatomical deviation (about the vertical axis)
  rotationDeg: z.number(), // pronation/supination (about the forearm axis)
});
export type WristCoachAngles = z.infer<typeof WristCoachAnglesSchema>;

/** The four coach keyframes. `setup` is the per-angle MEDIAN over the address
    pause window, never a single sample; the others are single samples at
    segmentation landmarks (see @golf/wrist coach-keyframes). */
export const WristCoachKeyframesSchema = z.object({
  setup: WristCoachAnglesSchema,
  top: WristCoachAnglesSchema,
  impact: WristCoachAnglesSchema,
  /** max extension between top and impact (the cast/flip signature) */
  peakDownExtensionDeg: z.number(),
});
export type WristCoachKeyframes = z.infer<typeof WristCoachKeyframesSchema>;

export const WristCoachResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), keyframes: WristCoachKeyframesSchema }),
  z.object({ status: z.literal('dropped'), reason: WristCoachDropReason }),
]);
export type WristCoachResult = z.infer<typeof WristCoachResultSchema>;

/** Per-shot wrist block, EXACT wire shape for the session-JSON export:
    snake_case keys, degrees rounded to 0.1, extension positive / flexion
    negative, radial positive / ulnar negative, rotation positive =
    supination (the face-closing direction for the lead wrist). Absent fields
    are OMITTED, never null-filled. */
export interface WristCoachBlock {
  ext_setup: number;
  ext_top: number;
  ext_impact: number;
  ext_peak_down: number;
  rad_setup?: number;
  rad_top?: number;
  rad_impact?: number;
  rot_setup?: number;
  rot_top?: number;
  rot_impact?: number;
}

/** Session-level wrist coverage, wire shape. Counters are mutually exclusive
    and sum to the session's validated wrist swings: `paired` counts swings
    that matched a launch-monitor shot one-to-one AND exported a block. */
export interface WristCoachCoverage {
  paired: number;
  dropped_unpaired: number;
  dropped_glitch: number;
  dropped_no_setup: number;
  dropped_uncalibrated: number;
}

/** One persisted wrist swing — EVERY validated swing during a session,
    practice swings included, so the export can count unpaired swings honestly
    (the live wrist↔shot join buffer silently ages them out). */
export const WristSwingRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  tImpactMs: z.number(), // arrival epoch ms at the impact zone — pairing key
  coach: WristCoachResultSchema,
  createdAt: z.number(),
});
export type WristSwingRecord = z.infer<typeof WristSwingRecordSchema>;

/**
 * The swing event — the PRIMARY shot detection for this data source. A swing
 * is a validated backswing→top→downswing envelope; no address hold is
 * required (addressHeldMs reports whatever stillness preceded the takeaway,
 * 0 when the golfer swung without settling). Whether a ball was struck is
 * NOT knowable from the wrist: the launch monitor join supplies that as
 * additional context. `impact` marks the impact ZONE (hands
 * returned to the address pose at peak speed) — a swing-geometry landmark,
 * never a claim of contact. Same for `shock` (raw accel context, unvalidated).
 * Phase durations are timed on the device clock, not BLE arrival.
 */
export const WristShotSchema = z.object({
  tImpactMs: z.number(), // arrival epoch ms at the impact zone — the launch-monitor join key
  durationMs: z.number(), // takeaway → settled, device clock
  peakAngularSpeedDegS: z.number(),
  calibrated: z.boolean(),
  addressHeldMs: z.number(), // stillness before takeaway (0 = swung without settling)
  backswingMs: z.number(), // takeaway → top first reached
  topPauseMs: z.number(), // dwell at the top (0 for a flowing swing)
  downswingMs: z.number(), // top last left → impact zone
  address: WristKeyframeSchema, // averaged over the hold — pre-swing angles
  top: WristKeyframeSchema,
  impact: WristKeyframeSchema,
  shock: z.object({
    tMs: z.number(),
    offsetFromImpactMs: z.number(), // + = shock after the impact zone
    peakAbsLsb: z.number(), // max |imu| over the swing, raw lsb
  }),
  /** Coach-export keyframes, attached by the wrist service's keyframe
      extractor. Absent on paths without one (batch detectSwings, old rows). */
  coach: WristCoachResultSchema.optional(),
});
export type WristShot = z.infer<typeof WristShotSchema>;

/** WristService — @golf/wrist public API. Peer to MonitorService; EventEmitter
    style. The store correlates `swing` events to launch-monitor shots by arrival
    time (±1.5 s nearest-neighbour); `hold`/`phase` drive live drill feedback. */
export interface WristServiceEvents {
  device: (d: WristDevice) => void;
  connection: (s: z.infer<typeof WristConnectionState>) => void;
  battery: (percent: number, millivolts: number) => void;
  swing: (shot: WristShot) => void;
  hold: (h: WristHold) => void;
  phase: (p: WristPhaseEvent) => void;
  sample: (s: WristSample) => void;
  error: (err: Error) => void;
}

export interface WristService {
  startScan(): void;
  stopScan(): void;
  connect(deviceId: string): Promise<void>;
  disconnect(): void;
  getState(): z.infer<typeof WristConnectionState>;
  /** Apply (or clear) anatomical calibration; takes effect immediately on the
      live stream and on every future connection. */
  setCalibration(calibration: WristCalibration | null): void;
  /** Stream the chatty per-record `sample` event (calibration capture / live
      view). Off by default. */
  setEmitSamples(enabled: boolean): void;
  /** Pulse the sensor's vibration motor for durationMs, best-effort: no-op
      unless connected, failures swallowed. A new pulse restarts the clock.
      Callers must keep the motor quiet through the impact window — motor
      shock on the IMU is uncharacterized and the chip band gates on it. */
  vibrate(durationMs?: number): void;
  on<K extends keyof WristServiceEvents>(e: K, h: WristServiceEvents[K]): void;
  off<K extends keyof WristServiceEvents>(e: K, h: WristServiceEvents[K]): void;
}
