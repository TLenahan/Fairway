import {
  WristCalibration,
  WristConnectionState,
  WristService,
  WristServiceEvents,
} from '@golf/types';
import { z } from 'zod';

import { WristBleConnection, WristBleTransport } from './ble-transport';
import { CoachKeyframeExtractor } from './coach-keyframes';
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
  CMD_VIBRATE_OFF,
  CMD_VIBRATE_ON,
  OP_SERIAL,
  TELEMETRY_MARKER,
} from './protocol';
import { SwingDetector, SwingDetectorOptions } from './swing-detector';

type Connection = z.infer<typeof WristConnectionState>;

export interface WristServiceConfig {
  transport: WristBleTransport;
  detector?: SwingDetectorOptions;
  /** Battery re-read cadence (the vendor app polls every 30 s). */
  batteryPollMs?: number;
  /** Emit the (chatty) per-record `sample` event for a live view. Off by default. */
  emitSamples?: boolean;
  /**
   * Diagnostic tap on every inbound frame, BEFORE any decode — the seam a raw
   * capture records through. Deliberately not on the WristService contract:
   * consumers work in swings, and only the composition root wires a recorder.
   * Handed the live buffer; a recorder that keeps it must copy.
   */
  onRawFrame?: (frame: Uint8Array, tMs: number) => void;
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
  private emitSamples: boolean;
  private calibration: WristCalibration | null;
  private readonly onRawFrame: ((frame: Uint8Array, tMs: number) => void) | null;

  private state: Connection = 'disconnected';
  private connection: WristBleConnection | null = null;
  private detector: SwingDetector | null = null;
  private coach: CoachKeyframeExtractor | null = null;
  private batteryTimer: ReturnType<typeof setInterval> | null = null;
  private vibrateTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedDeviceId: string | null = null;
  private readonly scannedNames = new Map<string, string>();
  private scanning = false;

  constructor(config: WristServiceConfig) {
    this.transport = config.transport;
    this.detectorOptions = config.detector ?? {};
    this.batteryPollMs = config.batteryPollMs ?? 30000;
    this.emitSamples = config.emitSamples ?? false;
    this.calibration = config.detector?.calibration ?? null;
    this.onRawFrame = config.onRawFrame ?? null;
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

  setCalibration(calibration: WristCalibration | null): void {
    this.calibration = calibration;
    this.detector?.setCalibration(calibration);
    this.coach?.setCalibration(calibration);
  }

  setEmitSamples(enabled: boolean): void {
    this.emitSamples = enabled;
  }

  vibrate(durationMs = 150): void {
    if (this.state !== 'connected' || this.connection === null) return;
    void this.connection.write(CMD_VIBRATE_ON).catch(() => undefined);
    if (this.vibrateTimer !== null) clearTimeout(this.vibrateTimer);
    this.vibrateTimer = setTimeout(() => {
      this.vibrateTimer = null;
      void this.connection?.write(CMD_VIBRATE_OFF).catch(() => undefined);
    }, durationMs);
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
      // the coach extractor rides the same sample stream and clock constants
      // as the detector so its keyframe anchors resolve to exact samples
      const coach = new CoachKeyframeExtractor({
        calibration: this.calibration,
        deviceClockHz: this.detectorOptions.deviceClockHz,
        gapResyncMs: this.detectorOptions.gapResyncMs,
      });
      this.coach = coach;
      this.detector = new SwingDetector(
        {
          onSwing: (shot) =>
            this.emitter.emit('swing', { ...shot, coach: coach.extract(shot) }),
          onHold: (hold) => this.emitter.emit('hold', hold),
          onPhase: (phase) => this.emitter.emit('phase', phase),
        },
        { ...this.detectorOptions, calibration: this.calibration },
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
    const arrivalMs = Date.now();
    if (this.onRawFrame !== null) {
      // A capture is a debugging aid; it must never take the stream down with
      // it. Its own failures are its problem, not the golfer's.
      try {
        this.onRawFrame(data, arrivalMs);
      } catch {
        /* swallow */
      }
    }
    if (data[0] === TELEMETRY_MARKER) {
      for (const record of parseFrame(data)) {
        const sample = {
          tMs: arrivalMs,
          tsa: record.tsA,
          qA: record.qA,
          qB: record.qB,
          shock: shockOf(record),
        };
        // coach first: when a swing finalizes inside detector.push, the
        // extractor's buffer already holds the current sample
        this.coach?.push(sample);
        this.detector?.push(sample);
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
    if (this.vibrateTimer !== null) {
      clearTimeout(this.vibrateTimer);
      this.vibrateTimer = null;
      // the ON payload carries a ~10 s max duration — don't leave a mid-pulse
      // motor to run it out
      void this.connection?.write(CMD_VIBRATE_OFF).catch(() => undefined);
    }
    void this.connection?.disconnect().catch(() => undefined);
    this.connection = null;
    this.detector = null;
    this.coach = null;
  }
}
