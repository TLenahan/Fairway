import { Buffer } from 'buffer';

/**
 * EYE MINI wire framing (BUILD_SPEC Appendix A.2, verified on every captured
 * frame; port of reference/protocol.js):
 *
 *   [0x99 0x01] [0x28 0x28] [uint32 big-endian length] [JSON body]
 */
export const MAGIC = Buffer.from([0x99, 0x01]);
export const SYNC = Buffer.from([0x28, 0x28]);
export const HEADER_LEN = 8;

/** Envelope of every message on the wire (request and response headers differ). */
export interface WireMessage {
  header: {
    // request side
    hard_key?: number;
    event_id?: number;
    req_id?: number;
    // response side
    status?: number;
    answer?: number;
    ack_id?: number;
    // both
    command?: number;
    length?: number;
  };
  param: Record<string, unknown> | null;
}

/**
 * Streaming frame parser. Feed raw TCP chunks; emits each complete JSON
 * message. Handles messages split across TCP segments, multiple messages per
 * segment, and resyncs on the 0x2828 marker after garbage. Malformed JSON is
 * skipped without losing sync.
 */
export class FrameParser {
  private buf = Buffer.alloc(0);

  constructor(private readonly onMessage: (msg: WireMessage) => void) {}

  push(chunk: Uint8Array): void {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    for (;;) {
      // resync to the 0x2828 marker if misaligned
      if (this.buf.length >= 4 && !this.buf.subarray(2, 4).equals(SYNC)) {
        const idx = this.buf.indexOf(SYNC, 1);
        if (idx < 2) {
          if (this.buf.length > 4096) {
            this.buf = this.buf.subarray(this.buf.length - 2);
          }
          return;
        }
        this.buf = this.buf.subarray(idx - 2);
      }
      if (this.buf.length < HEADER_LEN) return;
      const len = this.buf.readUInt32BE(4);
      if (this.buf.length < HEADER_LEN + len) return; // wait for more
      const body = this.buf.subarray(HEADER_LEN, HEADER_LEN + len);
      this.buf = this.buf.subarray(HEADER_LEN + len);
      let msg: WireMessage;
      try {
        msg = JSON.parse(body.toString('utf8')) as WireMessage;
      } catch {
        continue; // skip malformed, stay synced
      }
      this.onMessage(msg);
    }
  }
}

/** Build a client → Mini request frame (BUILD_SPEC A.3; hard_key is constant 82). */
export function encode(
  eventId: number,
  command: number,
  reqId: number,
  param: Record<string, unknown> | null = null,
): Uint8Array {
  const header = {
    hard_key: 82,
    event_id: eventId,
    command,
    req_id: reqId,
    length: param ? Buffer.byteLength(JSON.stringify(param)) : 0,
  };
  const json = Buffer.from(JSON.stringify({ header, param }), 'utf8');
  const out = Buffer.alloc(HEADER_LEN + json.length);
  MAGIC.copy(out, 0);
  SYNC.copy(out, 2);
  out.writeUInt32BE(json.length, 4);
  json.copy(out, HEADER_LEN);
  return out;
}
