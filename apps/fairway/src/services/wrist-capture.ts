import { Buffer } from 'buffer';
import { Directory, File, Paths } from 'expo-file-system';

/**
 * Raw HackMotion frame recorder — ground truth for tuning swing detection.
 *
 * The detector is the component under question, so its own WristShot output
 * can't validate it: a swing it never fired on leaves no trace, and the
 * quaternions needed to re-check where the top really was are gone by then.
 * This records every inbound frame verbatim, before any decode, so a capture
 * can be replayed through a changed detector offline and compared.
 *
 * Format is NDJSON on one host clock (Date.now at receipt):
 *   `meta`    — one header line (format version, label, start time)
 *   `frame`   — one per BLE notification; base64 of the bytes verbatim
 *   `context` — active club + whether calibration is applied; at start & on change
 *   `shot`    — an EYE MINI shot that landed during the capture (carry, ball
 *               speed, club). This is the ground-truth LABEL: a wrist swing
 *               that joins a `shot` in time struck a ball; one that doesn't is
 *               a practice swing. Same clock as the frames, so replay aligns
 *               them without a separate DB export.
 */
const CAPTURE_FORMAT_VERSION = 2;
const CAPTURE_DIR = 'wrist-captures';
/** Frames buffered before a write. ~100 Hz in ~2-record notifications, so
    this flushes a few times a second — cheap, and bounds loss to a blip. */
const FLUSH_EVERY = 64;

export interface CaptureStatus {
  recording: boolean;
  frames: number;
  bytes: number;
  file: string | null;
}

export interface WristCaptureRecorder {
  /** Frame sink for HackMotionWristService's `onRawFrame`. */
  record(frame: Uint8Array, tMs: number): void;
  /** Write a labeled non-frame line (context / shot). No-op when not
      recording; flushed immediately since these are rare and load-bearing. */
  event(entry: Record<string, unknown>): void;
  start(label: string): CaptureStatus;
  stop(): CaptureStatus;
  status(): CaptureStatus;
  list(): File[];
  subscribe(listener: (s: CaptureStatus) => void): () => void;
}

const stamp = (at: Date): string =>
  at.toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function createWristCaptureRecorder(): WristCaptureRecorder {
  let file: File | null = null;
  let pending: string[] = [];
  let frames = 0;
  let bytes = 0;
  const listeners = new Set<(s: CaptureStatus) => void>();

  const status = (): CaptureStatus => ({
    recording: file !== null,
    frames,
    bytes,
    file: file?.uri ?? null,
  });

  const publish = (): void => {
    const s = status();
    for (const listener of listeners) listener(s);
  };

  const flush = (): void => {
    if (file === null || pending.length === 0) return;
    const chunk = pending.join('');
    pending = [];
    file.write(chunk, { append: true });
  };

  const directory = (): Directory => {
    const dir = new Directory(Paths.document, CAPTURE_DIR);
    if (!dir.exists) dir.create({ intermediates: true });
    return dir;
  };

  return {
    record(frame: Uint8Array, tMs: number): void {
      if (file === null) return;
      // Buffer.from copies — the transport reuses/frees the inbound buffer.
      pending.push(
        `${JSON.stringify({
          type: 'frame',
          t: tMs,
          d: Buffer.from(frame).toString('base64'),
        })}\n`,
      );
      frames += 1;
      bytes += frame.length;
      if (pending.length >= FLUSH_EVERY) {
        flush();
        publish();
      }
    },

    event(entry: Record<string, unknown>): void {
      if (file === null) return;
      pending.push(`${JSON.stringify(entry)}\n`);
      flush(); // labels are rare and must survive an abrupt disconnect
    },

    start(label: string): CaptureStatus {
      if (file !== null) return status();
      const at = new Date();
      const next = new File(directory(), `${stamp(at)}-${label}.ndjson`);
      next.create({ overwrite: true });
      next.write(
        `${JSON.stringify({
          type: 'meta',
          formatVersion: CAPTURE_FORMAT_VERSION,
          label,
          startedAt: at.toISOString(),
          startedAtMs: at.getTime(),
          // Replay reads these back rather than assuming today's constants.
          note: 'HackMotion raw BLE frames (base64, verbatim) + shot/context labels',
        })}\n`,
      );
      file = next;
      frames = 0;
      bytes = 0;
      pending = [];
      publish();
      return status();
    },

    stop(): CaptureStatus {
      flush();
      const done: CaptureStatus = { ...status(), recording: false };
      file = null;
      publish();
      return done;
    },

    status,

    list(): File[] {
      return directory()
        .list()
        .filter((entry): entry is File => entry instanceof File)
        .sort((a, b) => (a.uri < b.uri ? 1 : -1));
    },

    subscribe(listener: (s: CaptureStatus) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
