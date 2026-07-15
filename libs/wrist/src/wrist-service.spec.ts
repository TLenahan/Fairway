import { WristDevice, WristShot } from '@golf/types';
import { Buffer } from 'buffer';

import {
  BleAvailability,
  WristBleConnection,
  WristBleDevice,
  WristBleTransport,
} from './ble-transport';
import { DEG_TO_RAD } from './quaternion';
import { HackMotionWristService } from './wrist-service';

class FakeConnection implements WristBleConnection {
  writes: Uint8Array[] = [];
  private dataHandler: ((d: Uint8Array) => void) | null = null;
  async write(data: Uint8Array): Promise<void> {
    this.writes.push(data);
  }
  onData(handler: (data: Uint8Array) => void): void {
    this.dataHandler = handler;
  }
  onDisconnect(): void {}
  async disconnect(): Promise<void> {}
  feed(data: Uint8Array): void {
    this.dataHandler?.(data);
  }
}

class FakeTransport implements WristBleTransport {
  readonly conn = new FakeConnection();
  private scanCb: ((d: WristBleDevice) => void) | null = null;
  startScan(onDevice: (d: WristBleDevice) => void): void {
    this.scanCb = onDevice;
  }
  stopScan(): void {}
  async connect(): Promise<WristBleConnection> {
    return this.conn;
  }
  availability(): BleAvailability {
    return 'ready';
  }
  advertise(device: WristBleDevice): void {
    this.scanCb?.(device);
  }
}

/** Build 0x90 telemetry frames replaying a swing in qB (qA held at identity). */
function swingFrames(): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let cumDeg = 0;
  let tsa = 0;
  const rec = (deltaDeg: number, dtsa: number, shock: number): Uint8Array => {
    cumDeg += deltaDeg;
    tsa = (tsa + dtsa) % 65536;
    const half = (cumDeg * DEG_TO_RAD) / 2;
    const q14 = (v: number): number => Math.round(v * 16384);
    const flat = [
      tsa, // ctr
      16384, 0, 0, 0, // qA identity
      0, 0, 0, 0, 0, 0, // imuA
      tsa, // tsA
      q14(Math.cos(half)), 0, 0, q14(Math.sin(half)), // qB about z
      Math.round(shock), 0, 0, 0, 0, 0, // imuB
      tsa, // tsB
    ];
    const buf = Buffer.alloc(47);
    buf.writeUInt8(0x90, 0);
    flat.forEach((v, i) => {
      const at = 1 + i * 2;
      if (i === 0 || i === 11 || i === 22) buf.writeUInt16BE(v & 0xffff, at);
      else buf.writeInt16BE(v, at);
    });
    return new Uint8Array(buf);
  };
  for (let i = 0; i < 30; i += 1) frames.push(rec(0, 2560, 5));
  for (let i = 0; i < 40; i += 1) {
    const frac = i < 20 ? i / 20 : (40 - i) / 20;
    frames.push(rec(0.2 + frac * 2.8, 640, 200 + frac * 3000));
  }
  for (let i = 0; i < 30; i += 1) frames.push(rec(0, 2560, 5));
  return frames;
}

describe('HackMotionWristService', () => {
  it('connects, streams a swing, and reads battery + serial', async () => {
    const transport = new FakeTransport();
    const service = new HackMotionWristService({
      transport,
      batteryPollMs: 1_000_000,
    });

    const connections: string[] = [];
    const swings: WristShot[] = [];
    const batteries: Array<[number, number]> = [];
    const devices: WristDevice[] = [];
    service.on('connection', (s) => connections.push(s));
    service.on('swing', (s) => swings.push(s));
    service.on('battery', (p, mv) => batteries.push([p, mv]));
    service.on('device', (d) => devices.push(d));

    await service.connect('dev-1');
    expect(service.getState()).toBe('connected');
    expect(connections).toEqual(['connecting', 'connected']);
    // wrote the identity read + start-stream command
    expect(transport.conn.writes.length).toBeGreaterThanOrEqual(2);

    for (const frame of swingFrames()) transport.conn.feed(frame);
    expect(swings).toHaveLength(1);
    expect(swings[0].peakAngularSpeedDegS).toBeGreaterThan(200);

    transport.conn.feed(Uint8Array.of(0x81, 0x46, 0x0e, 0xbd));
    expect(batteries).toEqual([[70, 3773]]);

    const serialReply = [0x86, ...Buffer.from('BCDKQ67GTQKC', 'ascii')];
    transport.conn.feed(Uint8Array.from(serialReply));
    expect(devices[devices.length - 1]?.serial).toBe('BCDKQ67GTQKC');

    service.disconnect();
    expect(service.getState()).toBe('disconnected');
  });

  it('reports poweredOff before scanning when the radio is off', () => {
    const transport = new FakeTransport();
    jest.spyOn(transport, 'availability').mockReturnValue('poweredOff');
    const service = new HackMotionWristService({ transport });
    const states: string[] = [];
    service.on('connection', (s) => states.push(s));
    service.startScan();
    expect(states).toEqual(['poweredOff']);
  });
});
