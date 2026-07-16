import {
  WristConnectionState,
  WristService,
  WristServiceEvents,
} from '@golf/types';
import { z } from 'zod';

import { WristBleConnection, WristBleTransport } from './ble-transport';
import { TypedEmitter } from './emitter';
import {
  decodeAsciiReply,
  decodeBattery,
  parseFrame,
  shockOf,
} from './record-codec';
import {
  ADVERTISED_NAME_PREFIX,
  CMD_READ_BATTERY,
  CMD_READ_SERIAL,
  CMD_START_STREAM,
  OP_SERIAL,
  TELEMETRY_MARKER,
} from './protocol';
import { relativeQuat } from './quaternion';
import { SwingDetector, SwingDetectorOptions } from './swing-detector';

type Connection = z.infer<typeof WristConnectionState>;

export interface WristServiceConfig {
  transport: WristBleTransport;
  detector?: SwingDetectorOptions;
  /** Battery re-read cadence (the vendor app polls every 30 s). */
  batteryPollMs?: number;
  /** Emit the (chatty) per-record `sample` event for a live view. Off by default. */
  emitSamples?: boolean;
}

/**
 * HackMotion Sensor 4 wrist client. Scans, connects through the BLE transport,
 * writes the start command, decodes 0x90 telemetry into swings, and reads
 * battery. Peer to EyeMiniMonitor; the store correlates its `swing` events to
 * launch-monitor shots by arrival time.
 */
export class HackMotionWristService implements WristService {
  private readonly emitter = new TypedEmitter<WristServiceEvents>();
  private readonly transport: WristBleTransport;
  private readonly detectorOptions: SwingDetectorOptions;
  private readonly batteryPollMs: number;
  private readonly emitSamples: boolean;

  private state: Connection = 'disconnected';
  private connection: WristBleConnection | null = null;
  private detector: SwingDetector | null = null;
  private batteryTimer: ReturnType<typeof setInterval> | null = null;
  private connectedDeviceId: string | null = null;
  private readonly scannedNames = new Map<string, string>();
  private scanning = false;

  constructor(config: WristServiceConfig) {
    this.transport = config.transport;
    this.detectorOptions = config.detector ?? {};
    this.batteryPollMs = config.batteryPollMs ?? 30000;
    this.emitSamples = config.emitSamples ?? false;
    // Keep the scanning state truthful across radio flips: the transport
    // holds a pending scan through poweredOff and restarts it on ready.
    this.transport.onAvailabilityChange?.((availability) => {
      if (!this.scanning) return;
      if (availability === 'ready') this.setState('scanning');
      else if (availability === 'poweredOff') this.setState('poweredOff');
      else if (availability === 'unauthorized') this.setState('unauthorized');
    });
  }

  on<K extends keyof WristServiceEvents>(e: K, h: WristServiceEvents[K]): void {
    this.emitter.on(e, h);
  }

  off<K extends keyof WristServiceEvents>(e: K, h: WristServiceEvents[K]): void {
    this.emitter.off(e, h);
  }

  getState(): Connection {
    return this.state;
  }

  startScan(): void {
    // Register the scan even when the radio isn't ready yet — the transport
    // holds it and starts once availability flips to ready. `scanning` must
    // be set first so the availability subscription can promote the state.
    this.scanning = true;
    const availability = this.transport.availability();
    if (availability === 'poweredOff') this.setState('poweredOff');
    else if (availability === 'unauthorized') this.setState('unauthorized');
    else if (this.state === 'disconnected' || this.state === 'error') {
      this.setState('scanning');
    }
    this.transport.startScan(
      (device) => {
        if (!device.name?.startsWith(ADVERTISED_NAME_PREFIX)) return;
        this.scannedNames.set(device.id, device.name);
        this.emitter.emit('device', {
          id: device.id,
          name: device.name,
          serial: null,
          batteryPercent: null,
        });
      },
      (err) => {
        // A dead scan must not look like an empty range.
        const after = this.transport.availability();
        if (after === 'unauthorized') this.setState('unauthorized');
        else if (after === 'poweredOff') this.setState('poweredOff');
        else if (this.state === 'scanning') this.setState('error');
        this.emitter.emit('error', err);
      },
    );
  }

  stopScan(): void {
    this.scanning = false;
    this.transport.stopScan();
    if (this.state === 'scanning') this.setState('disconnected');
  }

  async connect(deviceId: string): Promise<void> {
    if (this.scanning) this.stopScan();
    this.setState('connecting');
    try {
      const connection = await this.transport.connect(deviceId);
      this.connection = connection;
      this.connectedDeviceId = deviceId;
      this.detector = new SwingDetector(
        (shot) => this.emitter.emit('swing', shot),
        this.detectorOptions,
      );
      connection.onData((data) => this.handleData(data));
      connection.onDisconnect(() => this.handleDisconnect());

      // identity read then start the telemetry stream (both notify back)
      await connection.write(CMD_READ_SERIAL);
      await connection.write(CMD_START_STREAM);

      this.setState('connected');
      this.startBatteryPolling();
    } catch (err) {
      this.teardown();
      this.setState('error');
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitter.emit('error', error);
      throw error;
    }
  }

  disconnect(): void {
    this.detector?.flush();
    this.teardown();
    this.setState('disconnected');
  }

  /* ────────────────────── internals ────────────────────── */

  private setState(next: Connection): void {
    if (this.state === next) return;
    this.state = next;
    this.emitter.emit('connection', next);
  }

  private handleData(data: Uint8Array): void {
    if (data.length === 0) return;
    if (data[0] === TELEMETRY_MARKER) {
      const arrivalMs = Date.now();
      for (const record of parseFrame(data)) {
        this.detector?.push({
          tMs: arrivalMs,
          tsa: record.tsA,
          qRel: relativeQuat(record.qA, record.qB),
          shock: shockOf(record),
        });
        if (this.emitSamples) {
          this.emitter.emit('sample', {
            tMs: arrivalMs,
            qA: record.qA,
            qB: record.qB,
            imuA: record.imuA,
            imuB: record.imuB,
          });
        }
      }
      return;
    }

    const battery = decodeBattery(data);
    if (battery) {
      this.emitter.emit('battery', battery.percent, battery.millivolts);
      return;
    }
    // Identity reply: surface the unit's serial (proof of a correct decode).
    if (data[0] === OP_SERIAL && this.connectedDeviceId !== null) {
      this.emitter.emit('device', {
        id: this.connectedDeviceId,
        name: this.scannedNames.get(this.connectedDeviceId) ?? ADVERTISED_NAME_PREFIX,
        serial: decodeAsciiReply(data),
        batteryPercent: null,
      });
    }
  }

  private handleDisconnect(): void {
    this.detector?.flush();
    this.teardown();
    this.setState('disconnected');
  }

  private startBatteryPolling(): void {
    this.stopBatteryPolling();
    this.batteryTimer = setInterval(() => {
      void this.connection?.write(CMD_READ_BATTERY).catch(() => undefined);
    }, this.batteryPollMs);
  }

  private stopBatteryPolling(): void {
    if (this.batteryTimer !== null) clearInterval(this.batteryTimer);
    this.batteryTimer = null;
  }

  private teardown(): void {
    this.stopBatteryPolling();
    void this.connection?.disconnect().catch(() => undefined);
    this.connection = null;
    this.detector = null;
  }
}
