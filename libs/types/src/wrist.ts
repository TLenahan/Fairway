import { z } from 'zod';

/* ───────────────────────── wrist sensor (HackMotion) ─────────────────────────
   A second data source alongside the EYE MINI: a BLE dual-IMU wrist unit. This
   is a PEER of MonitorService (device.ts), not an implementation of it — BLE
   pairing/streaming semantics differ from the Mini's networked model, and there
   is no ball/club-mode concept. The reverse-engineered protocol, record decode,
   calibration, and swing detection all live in @golf/wrist; this file is only
   the frozen contract every other lib shares.

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
  angularSpeedDegS: z.number(),
  angles: WristAnglesSchema,
  // rotation vector (axis × angle, deg): neutral-relative when calibrated,
  // raw inter-IMU-relative otherwise. Singularity-free, unlike Euler angles.
  rotVecDeg: z.tuple([z.number(), z.number(), z.number()]),
});
export type WristKeyframe = z.infer<typeof WristKeyframeSchema>;

/** The host-side swing event. `impact` is the peak-angular-speed instant (a
    proxy); `shock` is the accel-channel candidate for true ball impact, which
    stays unvalidated until cross-checked against launch-monitor shot timing. */
export const WristShotSchema = z.object({
  tImpactMs: z.number(), // arrival epoch ms at impact — the launch-monitor join key
  durationMs: z.number(),
  peakAngularSpeedDegS: z.number(),
  calibrated: z.boolean(),
  address: WristKeyframeSchema,
  top: WristKeyframeSchema,
  impact: WristKeyframeSchema,
  shock: z.object({
    tMs: z.number(),
    offsetFromImpactMs: z.number(), // + = shock after the speed peak
    peakAbsLsb: z.number(), // max |imu| over the swing, raw lsb
  }),
});
export type WristShot = z.infer<typeof WristShotSchema>;

/** WristService — @golf/wrist public API. Peer to MonitorService; EventEmitter
    style. The store correlates `swing` events to launch-monitor shots by arrival
    time (±1.5 s nearest-neighbour). */
export interface WristServiceEvents {
  device: (d: WristDevice) => void;
  connection: (s: z.infer<typeof WristConnectionState>) => void;
  battery: (percent: number, millivolts: number) => void;
  swing: (shot: WristShot) => void;
  sample: (s: WristSample) => void;
  error: (err: Error) => void;
}

export interface WristService {
  startScan(): void;
  stopScan(): void;
  connect(deviceId: string): Promise<void>;
  disconnect(): void;
  getState(): z.infer<typeof WristConnectionState>;
  on<K extends keyof WristServiceEvents>(e: K, h: WristServiceEvents[K]): void;
  off<K extends keyof WristServiceEvents>(e: K, h: WristServiceEvents[K]): void;
}
