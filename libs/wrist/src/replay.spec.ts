import { Buffer } from 'buffer';

import { Q14_SCALE } from './protocol';
import { DEG_TO_RAD, axisAngleToQuat, Quat, Vec3 } from './quaternion';
import { parseCapture, replayCapture } from './replay';

const Z: Vec3 = [0, 0, 1];

/** Encode one 0x90/46-byte frame: qA identity, qB rotated θ about z. */
function frameLine(tMs: number, tsa: number, thetaDeg: number, shock: number): string {
  const half = (thetaDeg * DEG_TO_RAD) / 2;
  const qB: Quat = axisAngleToQuat(Z, thetaDeg * DEG_TO_RAD);
  void half;
  const q14 = (v: number): number => Math.round(v / Q14_SCALE);
  const flat = [
    tsa,
    16384, 0, 0, 0,
    0, 0, 0, 0, 0, 0,
    tsa,
    q14(qB[0]), q14(qB[1]), q14(qB[2]), q14(qB[3]),
    Math.round(shock), 0, 0, 0, 0, 0,
    tsa,
  ];
  const buf = Buffer.alloc(47);
  buf.writeUInt8(0x90, 0);
  flat.forEach((v, i) => {
    const at = 1 + i * 2;
    if (i === 0 || i === 11 || i === 22) buf.writeUInt16BE(v & 0xffff, at);
    else buf.writeInt16BE(v, at);
  });
  return JSON.stringify({ type: 'frame', t: tMs, d: buf.toString('base64') });
}

/** A capture: one address-hold swing, its MINI shot label, and a context line. */
function syntheticCapture(): string {
  const lines: string[] = [
    JSON.stringify({ type: 'meta', formatVersion: 2, label: 'test' }),
    JSON.stringify({
      type: 'context',
      t: 1_000_000,
      calibrated: false,
      club: { id: 'w56', name: '56°', category: 'wedge', loftDeg: 56 },
    }),
  ];
  let tsa = 0;
  let tMs = 1_000_000;
  const ease = (a: number, b: number, i: number, n: number): number =>
    a + ((b - a) * (1 - Math.cos((Math.PI * i) / n))) / 2;
  const push = (theta: number, shock: number): void => {
    tsa = (tsa + 640) % 65536;
    tMs += 10;
    lines.push(frameLine(tMs, tsa, theta, shock));
  };
  for (let i = 0; i < 180; i++) push(0, 5); // address hold
  for (let i = 1; i <= 70; i++) push(ease(0, 200, i, 70), 200); // backswing
  // downswing through the address into a −110° finish (opposite side)
  for (let i = 1; i <= 30; i++) push(ease(200, -110, i, 30), 4000);
  const impactMs = tMs; // ball contact ~ end of downswing
  for (let i = 0; i < 100; i++) push(-110, 5); // settle at the finish
  // MINI shot lands ~150ms after the wrist impact zone, as in the real join
  lines.push(
    JSON.stringify({
      type: 'shot',
      t: impactMs + 150,
      shotGuid: 'g-1',
      clubId: 'w56',
      carryM: 82.3,
      ballSpeedMs: 31.2,
    }),
  );
  return lines.join('\n') + '\n';
}

describe('capture replay', () => {
  const parsed = parseCapture(syntheticCapture());

  it('parses frames, shot labels, and context', () => {
    expect(parsed.samples.length).toBeGreaterThan(300);
    expect(parsed.shots).toHaveLength(1);
    expect(parsed.shots[0].carryM).toBeCloseTo(82.3);
    expect(parsed.contexts[0].club?.name).toBe('56°');
    expect(parsed.meta.formatVersion).toBe(2);
  });

  it('detects the swing and joins it to its MINI shot label', () => {
    const result = replayCapture(parsed);
    expect(result.swings).toHaveLength(1);
    expect(result.swings[0].matchedShot?.shotGuid).toBe('g-1');
    expect(result.unmatchedShots).toHaveLength(0);
  });

  it('leaves a practice swing (no ball) unmatched', () => {
    // drop the shot label → same swing must score as practice, no false join
    const noShot = parseCapture(
      syntheticCapture()
        .split('\n')
        .filter((l) => !l.includes('"type":"shot"'))
        .join('\n'),
    );
    const result = replayCapture(noShot);
    expect(result.swings).toHaveLength(1);
    expect(result.swings[0].matchedShot).toBeNull();
  });
});
