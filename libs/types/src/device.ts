import { z } from 'zod';

import { ConnectionState, Handedness, SensorMode } from './enums';
import { MeasuredShot } from './shot';

export const DiscoveredDeviceSchema = z.object({
  model: z.string(),
  serial: z.string(),
  ip: z.string(),
  mac: z.string(),
  swVersion: z.string(),
  hwVersion: z.string(),
});
export type DiscoveredDevice = z.infer<typeof DiscoveredDeviceSchema>;

export const DeviceStateSchema = z.object({
  handedness: Handedness,
  sensorMode: SensorMode,
  allowTee: z.boolean(),
  allowIron: z.boolean(),
  allowPutter: z.boolean(),
  altitudeM: z.number(),
});
export type DeviceState = z.infer<typeof DeviceStateSchema>;

/** MonitorService — WP1 public API. EventEmitter-style. */
export interface MonitorServiceEvents {
  device: (d: DiscoveredDevice) => void;
  connection: (s: z.infer<typeof ConnectionState>) => void;
  state: (s: DeviceState) => void;
  ballDetected: (mode: z.infer<typeof SensorMode>, exists: boolean) => void;
  shot: (shot: MeasuredShot) => void; // already deduped + decoded
  error: (err: Error) => void;
}
export interface MonitorService {
  startDiscovery(): void;
  stopDiscovery(): void;
  connect(ip: string): Promise<void>;
  disconnect(): void;
  setClub(mode: z.infer<typeof SensorMode>, clubType?: number): Promise<void>;
  setHandedness(h: z.infer<typeof Handedness>): Promise<void>;
  getState(): z.infer<typeof ConnectionState>;
  on<K extends keyof MonitorServiceEvents>(
    e: K,
    h: MonitorServiceEvents[K],
  ): void;
  off<K extends keyof MonitorServiceEvents>(
    e: K,
    h: MonitorServiceEvents[K],
  ): void;
}
