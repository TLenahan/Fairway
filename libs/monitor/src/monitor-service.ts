import { z } from 'zod';
import {
  ConnectionState,
  DeviceState,
  DiscoveredDevice,
  Handedness,
  MeasuredShot,
  MonitorService,
  MonitorServiceEvents,
  SensorMode,
} from '@golf/types';

import { parseBeacon, BEACON_PORT } from './discovery';
import { TypedEmitter } from './emitter';
import { encode, FrameParser, WireMessage } from './frame-codec';
import { decodeShot } from './shot-decoder';
import {
  ConnectTimeoutError,
  TcpConnection,
  TcpFactory,
  UdpFactory,
  UdpSocket,
} from './transport';

export const CONTROL_PORT = 43266;
export const EVENT_PORT = 43267;

type Connection = z.infer<typeof ConnectionState>;
type Mode = z.infer<typeof SensorMode>;
type Handed = z.infer<typeof Handedness>;

export interface MonitorConfig {
  tcp: TcpFactory;
  udp: UdpFactory;
  /** ~300 ms poll/keepalive cadence observed from the real View app. */
  pollIntervalMs?: number;
  connectTimeoutMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  /**
   * Device `clubtype` enum per sensor mode — exact values are UNKNOWN
   * (BUILD_SPEC A.4). 20 is the verified-working iron value; tee/putter
   * default to the same observed constant until captured empirically.
   * Override per mode when the real values are learned.
   */
  clubTypeByMode?: Record<Mode, number>;
  /** Opaque device unit enums (A.4) — observed working values. */
  unitParam?: { unitDistance: number; unitSpeed: number };
}

const DEFAULT_CLUB_TYPE_BY_MODE: Record<Mode, number> = {
  tee: 20,
  iron: 20,
  putter: 20,
};

/** Bounded shotGuid LRU — the Mini re-pushes the same shot several times. */
class RecentGuids {
  private guids: string[] = [];
  constructor(private readonly capacity = 64) {}
  seen(guid: string): boolean {
    if (this.guids.includes(guid)) return true;
    this.guids.push(guid);
    if (this.guids.length > this.capacity) this.guids.shift();
    return false;
  }
}

interface BallPosition {
  ballexist?: number;
}

/**
 * EYE MINI client (BUILD_SPEC §4, Appendix A; behavior verified by
 * reference/test-217.js): UDP beacon discovery, control channel init WITHOUT
 * the 217 auth handshake, 51/51/51/203 poll loop as arm+keepalive, shot
 * decode + dedup on both channels, auto-reconnect with backoff (the Mini
 * sleeps), and a distinct localNetworkDenied state.
 */
export class EyeMiniMonitor implements MonitorService {
  private readonly emitter = new TypedEmitter<MonitorServiceEvents>();
  private readonly tcp: TcpFactory;
  private readonly udpFactory: UdpFactory;
  private readonly pollIntervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly clubTypeByMode: Record<Mode, number>;
  private readonly unitParam: { unitDistance: number; unitSpeed: number };

  private state: Connection = 'disconnected';
  private udp: UdpSocket | null = null;
  private control: TcpConnection | null = null;
  private event: TcpConnection | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;
  private reqId = 0;
  private pollTick = 0;
  private lastIp: string | null = null;
  private intentionalDisconnect = false;
  private recentGuids = new RecentGuids();
  private discoveredSerials = new Set<string>();
  private lastBallExists = false;
  private handedness: Handed = 'right';

  /** localNetworkDenied heuristic inputs (see classifyConnectFailure). */
  private bytesEverReceived = false;
  private beaconsEverSeen = false;

  constructor(config: MonitorConfig) {
    this.tcp = config.tcp;
    this.udpFactory = config.udp;
    this.pollIntervalMs = config.pollIntervalMs ?? 300;
    this.connectTimeoutMs = config.connectTimeoutMs ?? 4000;
    this.reconnectInitialMs = config.reconnectInitialMs ?? 1000;
    this.reconnectMaxMs = config.reconnectMaxMs ?? 30000;
    this.reconnectDelayMs = this.reconnectInitialMs;
    this.clubTypeByMode = config.clubTypeByMode ?? DEFAULT_CLUB_TYPE_BY_MODE;
    this.unitParam = config.unitParam ?? { unitDistance: 16, unitSpeed: 32 };
  }

  on<K extends keyof MonitorServiceEvents>(
    e: K,
    h: MonitorServiceEvents[K],
  ): void {
    this.emitter.on(e, h);
  }

  off<K extends keyof MonitorServiceEvents>(
    e: K,
    h: MonitorServiceEvents[K],
  ): void {
    this.emitter.off(e, h);
  }

  getState(): Connection {
    return this.state;
  }

  startDiscovery(): void {
    if (this.udp) return;
    if (this.state === 'disconnected') this.setState('discovering');
    this.discoveredSerials.clear();
    void this.udpFactory
      .openBroadcastListener(BEACON_PORT)
      .then((socket) => {
        this.udp = socket;
        socket.onMessage((data) => {
          const device = parseBeacon(data);
          if (!device) return;
          this.beaconsEverSeen = true;
          if (this.discoveredSerials.has(device.serial)) return;
          this.discoveredSerials.add(device.serial);
          this.emitter.emit('device', device);
        });
      })
      .catch((err: Error) => this.emitter.emit('error', err));
  }

  stopDiscovery(): void {
    this.udp?.close();
    this.udp = null;
    if (this.state === 'discovering') this.setState('disconnected');
  }

  async connect(ip: string): Promise<void> {
    this.clearReconnect();
    this.intentionalDisconnect = false;
    this.lastIp = ip;
    this.setState('connecting');
    try {
      const control = await this.tcp.connect({
        host: ip,
        port: CONTROL_PORT,
        timeoutMs: this.connectTimeoutMs,
      });
      this.control = control;
      this.attachChannel(control, CONTROL_PORT);
      this.sendInitSequence();

      // Event channel is best-effort: some firmwares push shots on :43266.
      try {
        const event = await this.tcp.connect({
          host: ip,
          port: EVENT_PORT,
          timeoutMs: this.connectTimeoutMs,
        });
        this.event = event;
        this.attachChannel(event, EVENT_PORT);
      } catch {
        this.event = null;
      }

      this.reconnectDelayMs = this.reconnectInitialMs;
      this.setState('connected');
      this.startPolling();
    } catch (err) {
      this.teardownSockets();
      this.setState(this.classifyConnectFailure(err));
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.clearReconnect();
    this.stopPolling();
    this.teardownSockets();
    this.setState('disconnected');
  }

  async setClub(mode: Mode, clubType?: number): Promise<void> {
    this.send(176, 33, { club: clubType ?? this.clubTypeByMode[mode] });
    this.send(176, 36, { rightLeft: this.handedness === 'right' ? 0 : 1 });
  }

  async setHandedness(h: Handed): Promise<void> {
    this.handedness = h;
    this.send(176, 36, { rightLeft: h === 'right' ? 0 : 1 });
  }

  /* ────────────────────── internals ────────────────────── */

  private setState(next: Connection): void {
    if (this.state === next) return;
    this.state = next;
    this.emitter.emit('connection', next);
  }

  /**
   * iOS Local Network denial produces silent timeouts: TCP connects time out
   * with zero bytes ever received AND the beacon listener (which the OS also
   * blocks) has never seen a packet. A refused/reset connection or any prior
   * traffic means the network path works → plain 'error'. Documented
   * heuristic — there is no direct permission API signal at this layer.
   */
  private classifyConnectFailure(err: unknown): Connection {
    const timedOut = err instanceof ConnectTimeoutError;
    if (timedOut && !this.bytesEverReceived && !this.beaconsEverSeen) {
      return 'localNetworkDenied';
    }
    return 'error';
  }

  private attachChannel(conn: TcpConnection, port: number): void {
    const parser = new FrameParser((msg) => this.handleMessage(msg));
    conn.onData((chunk) => {
      this.bytesEverReceived = true;
      parser.push(chunk);
    });
    conn.onError(() => this.handleChannelDrop(port));
    conn.onClose(() => this.handleChannelDrop(port));
  }

  /** Init sequence verbatim from the capture MINUS command 217 (no auth). */
  private sendInitSequence(): void {
    this.send(178, 0, {
      sensorcode: 178,
      sensornum: 0,
      p0: 0,
      p1: 0,
      p2: 0,
      p3: 0,
    });
    this.send(176, 48, null);
    // command 217 (encrypted handshake) deliberately omitted — verified
    // unnecessary by reference/test-217.js against the real device.
    this.send(176, 33, { club: this.clubTypeByMode.iron });
    this.send(176, 36, { rightLeft: this.handedness === 'right' ? 0 : 1 });
    this.send(176, 37, this.unitParam);
  }

  private send(
    eventId: number,
    command: number,
    param: Record<string, unknown> | null,
  ): void {
    this.control?.write(encode(eventId, command, this.reqId++, param));
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTick = 0;
    // three 51s (ball poll) then one 203 (status), repeating — arm + keepalive
    this.pollTimer = setInterval(() => {
      const command = this.pollTick % 4 === 3 ? 203 : 51;
      this.send(176, command, null);
      this.pollTick++;
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private teardownSockets(): void {
    this.control?.destroy();
    this.event?.destroy();
    this.control = null;
    this.event = null;
  }

  private handleChannelDrop(port: number): void {
    if (this.intentionalDisconnect || this.state !== 'connected') return;
    // the event channel dropping alone is survivable; the control channel
    // dropping kills polling — reconnect either way (the Mini sleeps)
    if (port === EVENT_PORT && this.control) return;
    this.stopPolling();
    this.teardownSockets();
    this.setState('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.lastIp === null) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      this.reconnectMaxMs,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalDisconnect || this.lastIp === null) return;
      void this.connect(this.lastIp).catch(() => this.scheduleReconnect());
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private handleMessage(msg: WireMessage): void {
    const header = msg.header ?? {};
    const param = msg.param ?? {};

    // ball-position poll answers (command 51, either channel)
    if (
      header.command === 51 &&
      ('teeBallPos' in param || 'ironBallPos' in param)
    ) {
      this.handleBallPosition(param);
      return;
    }

    // device state push
    if (header.event_id === 192 && header.command === 4 && param['statedata']) {
      this.handleStateData(param['statedata']);
      return;
    }

    // THE shot — event_id 192 / command 1, decode wherever it arrives
    if (
      header.event_id === 192 &&
      header.command === 1 &&
      param['shotdataEX1']
    ) {
      this.handleShot(param['shotdataEX1']);
    }
  }

  private handleBallPosition(param: Record<string, unknown>): void {
    const tee = param['teeBallPos'] as BallPosition | undefined;
    const iron = param['ironBallPos'] as BallPosition | undefined;
    const exists = tee?.ballexist === 1 || iron?.ballexist === 1;
    if (exists === this.lastBallExists) return;
    this.lastBallExists = exists;
    const mode: Mode = tee?.ballexist === 1 ? 'tee' : 'iron';
    this.emitter.emit('ballDetected', mode, exists);
  }

  private handleStateData(raw: unknown): void {
    const StateSchema = z
      .object({
        rightleft: z.number(),
        allowTee: z.union([z.boolean(), z.number()]),
        allowIron: z.union([z.boolean(), z.number()]),
        allowPutter: z.union([z.boolean(), z.number()]),
        altitude: z.number(),
      })
      .passthrough();
    const parsed = StateSchema.safeParse(raw);
    if (!parsed.success) return;
    const d = parsed.data;
    const allowTee = d.allowTee === true || d.allowTee === 1;
    const allowIron = d.allowIron === true || d.allowIron === 1;
    const allowPutter = d.allowPutter === true || d.allowPutter === 1;
    // current mode inferred from the allow flags (exact semantics UNKNOWN;
    // iron is the verified default)
    const sensorMode: Mode =
      allowTee && !allowIron
        ? 'tee'
        : allowPutter && !allowIron
          ? 'putter'
          : 'iron';
    const state: DeviceState = {
      handedness: d.rightleft === 0 ? 'right' : 'left',
      sensorMode,
      allowTee,
      allowIron,
      allowPutter,
      altitudeM: d.altitude,
    };
    this.emitter.emit('state', state);
  }

  private handleShot(raw: unknown): void {
    let shot: MeasuredShot;
    try {
      shot = decodeShot(raw);
    } catch (err) {
      this.emitter.emit(
        'error',
        err instanceof Error ? err : new Error(String(err)),
      );
      return;
    }
    if (this.recentGuids.seen(shot.shotGuid)) return;
    this.emitter.emit('shot', shot);
  }
}

export type { DiscoveredDevice };
