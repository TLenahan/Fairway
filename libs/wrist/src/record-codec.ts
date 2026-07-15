import { Buffer } from 'buffer';

import {
  OP_BATTERY,
  Q14_SCALE,
  RECORD_LEN,
  TELEMETRY_MARKER,
} from './protocol';

/**
 * Telemetry decode, ported from `stream.py`. A 0x90 notification carries N
 * 46-byte records, each 23 × int16 BIG-endian: a counter, two Q14 quaternions
 * (w-first), the two IMUs' six raw motion channels, and two device timestamps.
 */
export interface WristRecord {
  ctr: number; // coarse device tick (NOT a per-record counter)
  qA: [number, number, number, number];
  imuA: [number, number, number, number, number, number];
  tsA: number; // fine device timestamp (u16, wraps)
  qB: [number, number, number, number];
  imuB: [number, number, number, number, number, number];
  tsB: number;
}

export function parseFrame(data: Uint8Array): WristRecord[] {
  if (data.length === 0 || data[0] !== TELEMETRY_MARKER) return [];
  const buf = Buffer.from(data);
  const out: WristRecord[] = [];
  for (let off = 1; off + RECORD_LEN <= buf.length; off += RECORD_LEN) {
    const s = (i: number): number => buf.readInt16BE(off + i * 2); // signed
    const u = (i: number): number => buf.readUInt16BE(off + i * 2); // counters
    out.push({
      ctr: u(0),
      qA: [s(1) * Q14_SCALE, s(2) * Q14_SCALE, s(3) * Q14_SCALE, s(4) * Q14_SCALE],
      imuA: [s(5), s(6), s(7), s(8), s(9), s(10)],
      tsA: u(11),
      qB: [
        s(12) * Q14_SCALE,
        s(13) * Q14_SCALE,
        s(14) * Q14_SCALE,
        s(15) * Q14_SCALE,
      ],
      imuB: [s(16), s(17), s(18), s(19), s(20), s(21)],
      tsB: u(22),
    });
  }
  return out;
}

/** Decode the battery reply: [0x81][percent u8][millivolts u16 BE]. */
export function decodeBattery(
  reply: Uint8Array,
): { percent: number; millivolts: number } | null {
  if (reply.length < 4 || reply[0] !== OP_BATTERY) return null;
  const buf = Buffer.from(reply);
  return { percent: buf.readUInt8(1), millivolts: buf.readUInt16BE(2) };
}

/** Decode an ASCII identity reply (serial/mac/token): [opcode][ASCII…]. */
export function decodeAsciiReply(reply: Uint8Array): string {
  return Buffer.from(reply).toString('utf8', 1);
}

/** Max |value| across all twelve motion channels — the impact-shock proxy. */
export function shockOf(record: WristRecord): number {
  let max = 0;
  for (const v of [...record.imuA, ...record.imuB]) {
    const a = Math.abs(v);
    if (a > max) max = a;
  }
  return max;
}
