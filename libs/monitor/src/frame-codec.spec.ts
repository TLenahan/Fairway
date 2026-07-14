import { Buffer } from 'buffer';

import { encode, FrameParser, HEADER_LEN, WireMessage } from './frame-codec';

const collect = () => {
  const messages: WireMessage[] = [];
  const parser = new FrameParser((m) => messages.push(m));
  return { messages, parser };
};

describe('encode', () => {
  it('produces the verified 8-byte header + JSON body', () => {
    const frame = Buffer.from(encode(176, 51, 9, null));
    expect([...frame.subarray(0, 4)]).toEqual([0x99, 0x01, 0x28, 0x28]);
    const len = frame.readUInt32BE(4);
    expect(len).toBe(frame.length - HEADER_LEN);
    const body = JSON.parse(frame.subarray(HEADER_LEN).toString('utf8'));
    expect(body.header).toEqual({
      hard_key: 82,
      event_id: 176,
      command: 51,
      req_id: 9,
      length: 0,
    });
    expect(body.param).toBeNull();
  });

  it('sets header.length to the param byte length', () => {
    const frame = Buffer.from(encode(176, 33, 4, { club: 20 }));
    const body = JSON.parse(frame.subarray(HEADER_LEN).toString('utf8'));
    expect(body.header.length).toBe(JSON.stringify({ club: 20 }).length);
    expect(body.param).toEqual({ club: 20 });
  });
});

describe('FrameParser', () => {
  it('parses a message split across TCP segments', () => {
    const { messages, parser } = collect();
    const frame = Buffer.from(encode(176, 51, 1, null));
    parser.push(frame.subarray(0, 5));
    expect(messages).toHaveLength(0);
    parser.push(frame.subarray(5));
    expect(messages).toHaveLength(1);
    expect(messages[0].header.command).toBe(51);
  });

  it('parses multiple messages in one segment', () => {
    const { messages, parser } = collect();
    parser.push(
      Buffer.concat([
        Buffer.from(encode(176, 51, 1, null)),
        Buffer.from(encode(176, 203, 2, null)),
      ]),
    );
    expect(messages.map((m) => m.header.command)).toEqual([51, 203]);
  });

  it('resyncs on the 0x2828 marker after garbage', () => {
    const { messages, parser } = collect();
    parser.push(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00]));
    parser.push(Buffer.from(encode(192, 1, 3, { ok: 1 })));
    expect(messages).toHaveLength(1);
    expect(messages[0].header.command).toBe(1);
  });

  it('skips malformed JSON without losing sync', () => {
    const { messages, parser } = collect();
    const bad = Buffer.from('not json', 'utf8');
    const badFrame = Buffer.alloc(HEADER_LEN + bad.length);
    Buffer.from([0x99, 0x01, 0x28, 0x28]).copy(badFrame, 0);
    badFrame.writeUInt32BE(bad.length, 4);
    bad.copy(badFrame, HEADER_LEN);
    parser.push(
      Buffer.concat([badFrame, Buffer.from(encode(176, 51, 5, null))]),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].header.command).toBe(51);
  });

  it('round-trips a large frame byte-by-byte', () => {
    const { messages, parser } = collect();
    const frame = Buffer.from(encode(192, 1, 7, { blob: 'x'.repeat(2000) }));
    for (const byte of frame) parser.push(Buffer.from([byte]));
    expect(messages).toHaveLength(1);
    expect((messages[0].param as { blob: string }).blob).toHaveLength(2000);
  });
});
