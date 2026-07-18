import { readFileSync } from 'fs';
import { join } from 'path';

import { parseCapture, ParsedCapture, replayCapture } from './replay';

/**
 * Ground-truth regression: replay the committed range captures through the
 * detector with DEFAULT options and hold the acceptance bar —
 *
 * - every launch-monitor shot with wrist coverage joins a detected swing
 *   (zero false negatives), and
 * - the putting session produces zero detections (zero false positives:
 *   putts sit below the detection floor by design — their peak envelope,
 *   87–320 °/s, overlaps handling/waggle motion and cannot be separated
 *   without breaking the zero-false-positive target).
 *
 * If a detector change trips these numbers, it traded away recall or
 * precision on real data — fix the change, not the test.
 */
const CAPTURES_DIR = join(__dirname, '../../../captures');

const load = (name: string): ParsedCapture =>
  parseCapture(readFileSync(join(CAPTURES_DIR, name), 'utf8'));

/** shots the wrist stream actually covers (the wedge session's sensor died
    13.6 min in — label-only shots after that are unscoreable) */
const covered = (cap: ParsedCapture, tMs: number): boolean =>
  cap.samples.some((s) => Math.abs(s.tMs - tMs) < 2000);

describe('committed captures — zero missed real shots', () => {
  it('wedge session (60°/56°, incl. rehearsal chains and a punch swing)', () => {
    const cap = load('2026-07-16T19-04-18-session.ndjson');
    const res = replayCapture(cap);
    const misses = res.unmatchedShots.filter((s) => covered(cap, s.tMs));
    expect(misses).toEqual([]);
    expect(res.swings.filter((s) => s.matchedShot).length).toBe(20);
  });

  it('driver + 7-iron session (incl. a 34.5 s BLE outage and two mishits)', () => {
    const cap = load('2026-07-18T01-17-16-session.ndjson');
    const res = replayCapture(cap);
    expect(res.unmatchedShots).toEqual([]);
    expect(res.swings.filter((s) => s.matchedShot).length).toBe(19);
  });

  it('chip session (60°/PW/7i bump-and-runs, 2.4–31 m, incl. two duffs)', () => {
    const cap = load('2026-07-18T03-02-21-session.ndjson');
    const res = replayCapture(cap);
    expect(res.unmatchedShots).toEqual([]);
    expect(res.swings.filter((s) => s.matchedShot).length).toBe(21);
  });
});

describe('committed captures — zero false positives', () => {
  it('putting session: no detections at all', () => {
    const cap = load('2026-07-18T01-27-01-session.ndjson');
    const res = replayCapture(cap);
    expect(res.swings).toEqual([]);
  });
});
