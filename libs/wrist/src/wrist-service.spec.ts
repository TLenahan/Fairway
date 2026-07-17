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

/**
 * Build 0x90 telemetry frames replaying an address-hold swing: 1.8 s still,
 * cosine backswing to 80°, downswing back to 2°, follow-through to 110°,
 * settle. qB rotates about z; qA stays identity (records at 100 Hz device
 * time — tsA steps 640 at 64 kHz).
 */
function swingFrames(): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let tsa = 0;
  const rec = (thetaDeg: number, shock: number): Uint8Array => {
    tsa = (tsa + 640) % 65536;
    const half = (thetaDeg * DEG_TO_RAD) / 2;
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
  const ease = (from: number, to: number, i: number, n: number): number =>
    from + ((to - from) * (1 - Math.cos((Math.PI * i) / n))) / 2;
  for (let i = 0; i < 180; i += 1) frames.push(rec(0, 5)); // address hold
  for (let i = 1; i <= 70; i += 1) frames.push(rec(ease(0, 80, i, 70), 200));
  for (let i = 1; i <= 25; i += 1) frames.push(rec(ease(80, 2, i, 25), 4000));
  for (let i = 1; i <= 35; i += 1) frames.push(rec(ease(2, 110, i, 35), 800));
  for (let i = 0; i < 100; i += 1) frames.push(rec(110, 5)); // finish hold
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
    expect(swings[0].peakAngularSpeedDegS).toBeGreaterThan(300);
    expect(swings[0].addressHeldMs).toBeGreaterThan(1500);
    expect(swings[0].downswingMs).toBeLessThan(320);

    transport.conn.feed(Uint8Array.of(0x81, 0x46, 0x0e, 0xbd));
    expect(batteries).toEqual([[70, 3773]]);

    const serialReply = [0x86, ...Buffer.from('BCDKQ67GTQKC', 'ascii')];
    transport.conn.feed(Uint8Array.from(serialReply));
    expect(devices[devices.length - 1]?.serial).toBe('BCDKQ67GTQKC');

    service.disconnect();
    expect(service.getState()).toBe('disconnected');
  });

  it('taps every raw frame, verbatim and pre-decode', async () => {
    const transport = new FakeTransport();
    const raw: Array<{ bytes: Uint8Array; tMs: number }> = [];
    const service = new HackMotionWristService({
      transport,
      batteryPollMs: 1_000_000,
      // copy: the tap is handed the live buffer, as a real recorder must
      onRawFrame: (bytes, tMs) => raw.push({ bytes: bytes.slice(), tMs }),
    });
    await service.connect('dev-1');

    const frames = swingFrames();
    for (const frame of frames) transport.conn.feed(frame);
    const battery = Uint8Array.of(0x81, 0x46, 0x0e, 0xbd);
    transport.conn.feed(battery);

    // non-telemetry replies are captured too — a replay wants the whole link
    expect(raw).toHaveLength(frames.length + 1);
    expect(raw[0].bytes).toEqual(frames[0]);
    expect(raw[raw.length - 1].bytes).toEqual(battery);
    expect(raw[0].tMs).toBeGreaterThan(0);
    service.disconnect();
  });

  it('keeps streaming when the raw tap throws', async () => {
    const transport = new FakeTransport();
    const swings: WristShot[] = [];
    const service = new HackMotionWristService({
      transport,
      batteryPollMs: 1_000_000,
      onRawFrame: () => {
        throw new Error('disk full');
      },
    });
    service.on('swing', (s) => swings.push(s));
    await service.connect('dev-1');

    for (const frame of swingFrames()) transport.conn.feed(frame);
    expect(swings).toHaveLength(1);
    service.disconnect();
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
