import { Buffer } from 'buffer';
import { MeasuredShot } from '@golf/types';

import fixture from './fixtures/sample-shot.json';
import { encode, FrameParser, WireMessage } from './frame-codec';
import { CONTROL_PORT, EVENT_PORT, EyeMiniMonitor } from './monitor-service';
import {
  ConnectTimeoutError,
  TcpConnection,
  TcpConnectOptions,
  TcpFactory,
  UdpFactory,
  UdpSocket,
} from './transport';

class FakeTcpConnection implements TcpConnection {
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

type ConnectBehavior = 'ok' | 'timeout' | 'refused';

class FakeTcpFactory implements TcpFactory {
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

class FakeUdpSocket implements UdpSocket {
  closed = false;
  private handlers: ((data: Uint8Array, fromIp: string) => void)[] = [];
  onMessage(handler: (data: Uint8Array, fromIp: string) => void): void {
    this.handlers.push(handler);
  }
  close(): void {
    this.closed = true;
  }
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

class FakeUdpFactory implements UdpFactory {
  socket = new FakeUdpSocket();
  async openBroadcastListener(): Promise<UdpSocket> {
    return this.socket;
  }
}

const flush = async (times = 3) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

const liveMonitors: EyeMiniMonitor[] = [];

function build() {
  const tcp = new FakeTcpFactory();
  const udp = new FakeUdpFactory();
  const monitor = new EyeMiniMonitor({ tcp, udp });
  liveMonitors.push(monitor);
  const states: string[] = [];
  monitor.on('connection', (s) => states.push(s));
  return { tcp, udp, monitor, states };
}

afterEach(() => {
  // stop poll/reconnect timers so no real interval outlives a test
  for (const monitor of liveMonitors.splice(0)) monitor.disconnect();
  jest.useRealTimers();
});

describe('EyeMiniMonitor — connect + init', () => {
  it('sends the exact init sequence WITHOUT command 217', async () => {
    const { tcp, monitor } = build();
    await monitor.connect('192.168.1.10');
    const control = tcp.byPort(CONTROL_PORT);
    const sequence = control.sent.map((m) => [
      m.header.event_id,
      m.header.command,
    ]);
    expect(sequence).toEqual([
      [178, 0],
      [176, 48],
      [176, 33],
      [176, 36],
      [176, 37],
    ]);
    expect(sequence.map(([, cmd]) => cmd)).not.toContain(217);
    // req_id strictly increasing
    const reqIds = control.sent.map((m) => m.header.req_id);
    expect(reqIds).toEqual([...reqIds].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(monitor.getState()).toBe('connected');
  });

  it('polls 51,51,51,203 at the keepalive cadence', async () => {
    jest.useFakeTimers();
    const { tcp, monitor } = build();
    await monitor.connect('192.168.1.10');
    const control = tcp.byPort(CONTROL_PORT);
    const before = control.sent.length;
    jest.advanceTimersByTime(300 * 8);
    const polls = control.sent.slice(before).map((m) => m.header.command);
    expect(polls).toEqual([51, 51, 51, 203, 51, 51, 51, 203]);
  });

  it('survives an event-channel connect failure (shots may come on :43266)', async () => {
    const { tcp, monitor } = build();
    tcp.behavior = (opts) => (opts.port === EVENT_PORT ? 'refused' : 'ok');
    await monitor.connect('192.168.1.10');
    expect(monitor.getState()).toBe('connected');
  });
});

describe('EyeMiniMonitor — shots', () => {
  it('decodes and dedups shots pushed on the event channel', async () => {
    const { tcp, monitor } = build();
    const shots: MeasuredShot[] = [];
    monitor.on('shot', (s) => shots.push(s));
    await monitor.connect('192.168.1.10');
    const event = tcp.byPort(EVENT_PORT);

    event.feed(192, 1, { shotdataEX1: fixture.raw_shotdataEX1 });
    event.feed(192, 1, { shotdataEX1: fixture.raw_shotdataEX1 }); // Mini re-push
    expect(shots).toHaveLength(1);
    expect(shots[0].ball.speedMs).toBeCloseTo(26.092);
    expect(shots[0].club.faceAngleDeg).toBeNull();
  });

  it('also decodes shots arriving on the control channel', async () => {
    const { tcp, monitor } = build();
    const shots: MeasuredShot[] = [];
    monitor.on('shot', (s) => shots.push(s));
    await monitor.connect('192.168.1.10');
    tcp
      .byPort(CONTROL_PORT)
      .feed(192, 1, { shotdataEX1: fixture.raw_shotdataEX1 });
    expect(shots).toHaveLength(1);
  });
});

describe('EyeMiniMonitor — ball detection + device state', () => {
  it('emits ballDetected only on change, with the active mode', async () => {
    const { tcp, monitor } = build();
    const events: [string, boolean][] = [];
    monitor.on('ballDetected', (mode, exists) => events.push([mode, exists]));
    await monitor.connect('192.168.1.10');
    const control = tcp.byPort(CONTROL_PORT);

    const poll = (tee: number, iron: number) =>
      control.feed(176, 51, {
        teeBallPos: { ballexist: tee, shotresult: 0, x: 0, y: 0, z: 0 },
        ironBallPos: { ballexist: iron, shotresult: 0, x: 0, y: 0, z: 0 },
      });

    poll(0, 0);
    poll(0, 1);
    poll(0, 1); // unchanged — no event
    poll(0, 0);
    expect(events).toEqual([
      ['iron', true],
      ['iron', false],
    ]);
  });

  it('maps statedata to DeviceState', async () => {
    const { tcp, monitor } = build();
    const states: unknown[] = [];
    monitor.on('state', (s) => states.push(s));
    await monitor.connect('192.168.1.10');
    tcp.byPort(EVENT_PORT).feed(192, 4, {
      statedata: {
        rightleft: 0,
        clubtype: 20,
        allowTee: 0,
        allowIron: 1,
        allowPutter: 0,
        unitDistance: 16,
        unitSpeed: 32,
        altitude: 1849,
        altitude_mode: 1,
      },
    });
    expect(states).toEqual([
      {
        handedness: 'right',
        sensorMode: 'iron',
        allowTee: false,
        allowIron: true,
        allowPutter: false,
        altitudeM: 1849,
      },
    ]);
  });
});

describe('EyeMiniMonitor — reconnect + failure classification', () => {
  it('reconnects with doubling backoff after an unexpected drop', async () => {
    jest.useFakeTimers();
    const { tcp, monitor } = build();
    await monitor.connect('192.168.1.10');
    const first = tcp.byPort(CONTROL_PORT);
    const connectionsBefore = tcp.connections.length;

    first.dropped();
    expect(monitor.getState()).toBe('disconnected');

    jest.advanceTimersByTime(1000);
    await flush();
    expect(tcp.connections.length).toBeGreaterThan(connectionsBefore);
    expect(monitor.getState()).toBe('connected');
  });

  it('re-opens the event channel alone when it drops, staying connected', async () => {
    jest.useFakeTimers();
    const { tcp, monitor } = build();
    const shots: MeasuredShot[] = [];
    monitor.on('shot', (s) => shots.push(s));
    await monitor.connect('192.168.1.10');
    const eventCountBefore = tcp.connections.filter(
      (c) => c.port === EVENT_PORT,
    ).length;

    // event channel drops while control stays up
    tcp.byPort(EVENT_PORT).dropped();
    expect(monitor.getState()).toBe('connected'); // control still fine

    jest.advanceTimersByTime(1000);
    await flush();
    const eventCountAfter = tcp.connections.filter(
      (c) => c.port === EVENT_PORT,
    ).length;
    expect(eventCountAfter).toBeGreaterThan(eventCountBefore);

    // shots flow again on the fresh event channel
    tcp
      .byPort(EVENT_PORT)
      .feed(192, 1, { shotdataEX1: fixture.raw_shotdataEX1 });
    expect(shots).toHaveLength(1);
  });

  it('does NOT reconnect after an intentional disconnect', async () => {
    jest.useFakeTimers();
    const { tcp, monitor } = build();
    await monitor.connect('192.168.1.10');
    const count = tcp.connections.length;
    monitor.disconnect();
    jest.advanceTimersByTime(60000);
    await flush();
    expect(tcp.connections.length).toBe(count);
    expect(monitor.getState()).toBe('disconnected');
  });

  it('classifies silent timeouts with zero traffic as localNetworkDenied', async () => {
    const { tcp, monitor } = build();
    tcp.behavior = () => 'timeout';
    await expect(monitor.connect('192.168.1.10')).rejects.toBeInstanceOf(
      ConnectTimeoutError,
    );
    expect(monitor.getState()).toBe('localNetworkDenied');
  });

  it('classifies refused connections as plain error', async () => {
    const { tcp, monitor } = build();
    tcp.behavior = () => 'refused';
    await expect(monitor.connect('192.168.1.10')).rejects.toThrow(
      'ECONNREFUSED',
    );
    expect(monitor.getState()).toBe('error');
  });
});

describe('EyeMiniMonitor — discovery + club config', () => {
  it('emits each discovered device once per serial', async () => {
    const { udp, monitor } = build();
    const devices: string[] = [];
    monitor.on('device', (d) => devices.push(`${d.serial}@${d.ip}`));
    monitor.startDiscovery();
    await flush();
    udp.socket.beacon('501000330615', '192.168.1.10');
    udp.socket.beacon('501000330615', '192.168.1.10');
    udp.socket.beacon('999', '192.168.1.11');
    expect(devices).toEqual(['501000330615@192.168.1.10', '999@192.168.1.11']);
    expect(monitor.getState()).toBe('discovering');
    monitor.stopDiscovery();
    expect(udp.socket.closed).toBe(true);
  });

  it('setClub sends the club + handedness commands', async () => {
    const { tcp, monitor } = build();
    await monitor.connect('192.168.1.10');
    const control = tcp.byPort(CONTROL_PORT);
    const before = control.sent.length;
    await monitor.setHandedness('left');
    await monitor.setClub('iron', 21);
    const sent = control.sent.slice(before);
    expect(sent.map((m) => m.header.command)).toEqual([36, 33, 36]);
    expect(sent[0].param).toEqual({ rightLeft: 1 });
    expect(sent[1].param).toEqual({ club: 21 });
    expect(sent[2].param).toEqual({ rightLeft: 1 });
  });
});

describe('sanity: fake feed framing matches the real codec', () => {
  it('encode output parses back through FrameParser', () => {
    const messages: WireMessage[] = [];
    const parser = new FrameParser((m) => messages.push(m));
    parser.push(encode(176, 51, 1, null));
    expect(messages).toHaveLength(1);
  });
});
