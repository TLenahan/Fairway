import { Buffer } from 'buffer';

import {
  decodeAsciiReply,
  decodeBattery,
  parseFrame,
  shockOf,
} from './record-codec';

/** Encode records (each a flat array of 23 int16, big-endian) behind a 0x90. */
function buildFrame(records: number[][]): Uint8Array {
  const buf = Buffer.alloc(1 + records.length * 46);
  buf.writeUInt8(0x90, 0);
  records.forEach((rec, r) => {
    const base = 1 + r * 46;
    rec.forEach((v, i) => buf.writeInt16BE(v, base + i * 2));
  });
  return new Uint8Array(buf);
}

// [ctr, qA×4, imuA×6, tsA, qB×4, imuB×6, tsB]
const sample = [
  1000, 16384, 0, 0, 0, 1, 2, 3, 4, 5, 6, 2000, 0, 16384, 0, 0, -1, -2, -3, -4,
  -5, -6, 2100,
];

describe('parseFrame', () => {
  it('decodes a 0x90 record: Q14 quaternions, raw imu, u16 timestamps', () => {
    const [rec, ...rest] = parseFrame(buildFrame([sample]));
    expect(rest).toHaveLength(0);
    expect(rec.ctr).toBe(1000);
    expect(rec.qA).toEqual([1, 0, 0, 0]); // 16384 / 16384
    expect(rec.qB).toEqual([0, 1, 0, 0]);
    expect(rec.imuA).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rec.imuB).toEqual([-1, -2, -3, -4, -5, -6]);
    expect(rec.tsA).toBe(2000);
    expect(rec.tsB).toBe(2100);
    expect(shockOf(rec)).toBe(6);
  });

  it('decodes multiple records per packet', () => {
    expect(parseFrame(buildFrame([sample, sample]))).toHaveLength(2);
  });

  it('ignores a non-telemetry notification', () => {
    expect(parseFrame(Uint8Array.of(0x81, 0x46, 0x0e, 0xbd))).toEqual([]);
  });
});

describe('identity replies', () => {
  it('decodes battery: [0x81][percent][mV BE]', () => {
    // 0x46 = 70 %, 0x0ebd = 3773 mV — the values from the capture
    const battery = decodeBattery(Uint8Array.of(0x81, 0x46, 0x0e, 0xbd));
    expect(battery).toEqual({ percent: 70, millivolts: 3773 });
  });

  it('rejects a battery decode of a telemetry frame', () => {
    expect(decodeBattery(Uint8Array.of(0x90, 0, 0, 0))).toBeNull();
  });

  it('decodes an ASCII serial reply', () => {
    const bytes = [0x86, ...Buffer.from('BCDKQ67GTQKC', 'ascii')];
    expect(decodeAsciiReply(Uint8Array.from(bytes))).toBe('BCDKQ67GTQKC');
  });
});
