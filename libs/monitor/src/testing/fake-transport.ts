import { Buffer } from 'buffer';

import sampleShot from '../fixtures/sample-shot.json';
import { FrameParser, WireMessage } from '../frame-codec';
import {
  CONTROL_PORT,
  EVENT_PORT,
  EyeMiniMonitor,
  MonitorConfig,
} from '../monitor-service';
import {
  ConnectTimeoutError,
  TcpConnection,
  TcpConnectOptions,
  TcpFactory,
  UdpFactory,
  UdpSocket,
} from '../transport';

/**
 * EYE MINI replay/test harness.
 *
 * In-memory fakes for the `TcpFactory`/`UdpFactory` seams (see ../transport)
 * that drive a REAL `EyeMiniMonitor` end to end — no sockets, no hardware.
 * Originally inlined in monitor-service.spec.ts; pulled out here so anything
 * that wants to replay captured Mini traffic (the Mac hub's replay harness,
 * in particular) can reuse the exact same fakes instead of reimplementing
 * the wire framing.
 *
 * Deliberately NOT exported from the lib's `./index` (see
 * libs/data/src/testing for the same convention) — import it directly via
 * `@golf/monitor/testing` so it never reaches the app bundle.
 */

/** event_id/command a decoded shot arrives on (see monitor-service.ts handleMessage). */
const SHOT_EVENT_ID = 192;
const SHOT_COMMAND = 1;

/** In-memory stand-in for a single TCP socket to the Mini. */
export class FakeTcpConnection implements TcpConnection {
  sent: WireMessage[] = [];
  destroyed = false;
  private dataHandlers: ((chunk: Uint8Array) => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private errorHandlers: ((err: Error) => void)[] = [];
  private outParser = new FrameParser((m) => this.sent.push(m));

  write(data: Uint8Array): void {
    this.outParser.push(data);
  }
  onData(handler: (chunk: Uint8Array) => void): void {
    this.dataHandlers.push(handler);
  }
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }
  onError(handler: (err: Error) => void): void {
    this.errorHandlers.push(handler);
  }
  destroy(): void {
    this.destroyed = true;
  }

  /** simulate the Mini pushing a framed message */
  feed(eventId: number, command: number, param: Record<string, unknown>): void {
    // responses use answer/ack headers; reuse encode and rewrite the header
    const body = JSON.stringify({
      header: {
        status: 0,
        answer: eventId,
        event_id: eventId,
        command,
        ack_id: 0,
        length: 0,
      },
      param,
    });
    const json = Buffer.from(body, 'utf8');
    const frame = Buffer.alloc(8 + json.length);
    Buffer.from([0x99, 0x01, 0x28, 0x28]).copy(frame, 0);
    frame.writeUInt32BE(json.length, 4);
    json.copy(frame, 8);
    for (const handler of this.dataHandlers) handler(frame);
  }

  dropped(): void {
    for (const handler of this.closeHandlers) handler();
  }
}

export type ConnectBehavior = 'ok' | 'timeout' | 'refused';

/** In-memory `TcpFactory`: hands out `FakeTcpConnection`s, or simulates connect failures. */
export class FakeTcpFactory implements TcpFactory {
  connections: { port: number; conn: FakeTcpConnection }[] = [];
  behavior: (opts: TcpConnectOptions, attempt: number) => ConnectBehavior =
    () => 'ok';
  private attempts = 0;

  async connect(opts: TcpConnectOptions): Promise<TcpConnection> {
    this.attempts += 1;
    const behavior = this.behavior(opts, this.attempts);
    if (behavior === 'timeout') {
      throw new ConnectTimeoutError(opts.host, opts.port);
    }
    if (behavior === 'refused') {
      throw new Error('ECONNREFUSED');
    }
    const conn = new FakeTcpConnection();
    this.connections.push({ port: opts.port, conn });
    return conn;
  }

  byPort(port: number): FakeTcpConnection {
    const found = [...this.connections].reverse().find((c) => c.port === port);
    if (!found) throw new Error(`no connection on ${port}`);
    return found.conn;
  }
}

/** In-memory stand-in for the UDP broadcast-discovery socket. */
export class FakeUdpSocket implements UdpSocket {
  closed = false;
  private handlers: ((data: Uint8Array, fromIp: string) => void)[] = [];
  onMessage(handler: (data: Uint8Array, fromIp: string) => void): void {
    this.handlers.push(handler);
  }
  close(): void {
    this.closed = true;
  }
  /** simulate the Mini's UDP beacon (BUILD_SPEC A.1) */
  beacon(serial: string, ip: string): void {
    const data = Buffer.from(
      JSON.stringify({
        device: {
          modelName: 'EYEMINI',
          hwVersion: '5010',
          swVersion: '2.7.8',
          serialNumber: serial,
          networkInfo: {
            interface: 'wlan0',
            ipaddr: ip,
            mac: 'D8:3A:DD:5A:28:95',
          },
        },
      }),
      'utf8',
    );
    for (const handler of this.handlers) handler(data, ip);
  }
}

export class FakeUdpFactory implements UdpFactory {
  socket = new FakeUdpSocket();
  async openBroadcastListener(): Promise<UdpSocket> {
    return this.socket;
  }
}

/** Flush pending microtasks (the promise chains inside connect()/discovery). */
async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

export interface FakeEyeMini {
  tcp: FakeTcpFactory;
  udp: FakeUdpFactory;
  monitor: EyeMiniMonitor;
}

/** Wire up a fresh in-memory EyeMiniMonitor — the fake-transport equivalent of "plug in a Mini". */
export function createFakeEyeMini(config?: Partial<MonitorConfig>): FakeEyeMini {
  const tcp = new FakeTcpFactory();
  const udp = new FakeUdpFactory();
  const monitor = new EyeMiniMonitor({ tcp, udp, ...config });
  return { tcp, udp, monitor };
}

export interface ConnectedFakeEyeMini extends FakeEyeMini {
  control: FakeTcpConnection;
  event: FakeTcpConnection;
}

/**
 * Drive a fresh fake Mini through UDP beacon discovery and the
 * control-channel connect + init handshake, landing in the 'connected'
 * state — the entry point a replay harness needs before it starts feeding
 * recorded traffic. Mirrors what monitor-service.spec.ts's discovery and
 * connect tests do by hand.
 */
export async function connectFakeEyeMini(
  ip: string,
  serial = '501000330615',
  config?: Partial<MonitorConfig>,
): Promise<ConnectedFakeEyeMini> {
  const { tcp, udp, monitor } = createFakeEyeMini(config);
  monitor.startDiscovery();
  await flushMicrotasks();
  udp.socket.beacon(serial, ip);
  await monitor.connect(ip);
  return {
    tcp,
    udp,
    monitor,
    control: tcp.byPort(CONTROL_PORT),
    event: tcp.byPort(EVENT_PORT),
  };
}

/** Feed a decoded-shot push (event_id 192 / command 1) exactly as the Mini sends it. */
export function feedShot(conn: FakeTcpConnection, rawShotdataEX1: unknown): void {
  conn.feed(SHOT_EVENT_ID, SHOT_COMMAND, { shotdataEX1: rawShotdataEX1 });
}

/** The canonical captured-shot fixture (raw wire payload + expected decodes). */
export const SAMPLE_SHOT = sampleShot;
