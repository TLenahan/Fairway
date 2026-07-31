import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Turning a Hindsight save into a swing clip: keep the tail, measure it, throw
 * the rest away.
 *
 * Everything here is END-relative, and that is load-bearing. The camera holds a
 * rolling pre-roll and is triggered after the ball is struck, so the one instant
 * the hub knows in the file's own timeline is its END — that is the moment it
 * told the camera to stop. The start is unknown twice over: the buffer may not
 * have been full, and a `-c copy` cut snaps to the nearest keyframe at or before
 * where it was asked to cut, so the clip that comes out is a little longer at
 * the front than the trim requested. Neither moves the end. So the driver asks
 * for a generous tail and then computes where impact sits by measuring backwards
 * from the end of what it actually got.
 */
export interface ClipProbe {
  durationMs: number;
  fps: number;
  width: number;
  height: number;
}

export interface ClipTrimmer {
  /** ffmpeg and ffprobe on PATH, or throw saying how to get them. */
  preflight(): Promise<void>;
  /** Keep the last `fromEndMs` of `input` as `output`. */
  trimFromEnd(input: string, output: string, fromEndMs: number): Promise<void>;
  probe(file: string): Promise<ClipProbe>;
}

export class TrimToolsMissingError extends Error {
  constructor(cause: string) {
    super(
      `ffmpeg/ffprobe not usable (${cause}). Install them: brew install ffmpeg`,
    );
    this.name = 'TrimToolsMissingError';
  }
}

export function trimArgs(
  input: string,
  output: string,
  fromEndMs: number,
): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    // seek relative to EOF — the only anchor in the file the hub knows
    '-sseof',
    `-${(fromEndMs / 1000).toFixed(3)}`,
    '-i',
    input,
    // Audio is mapped on purpose: locating the strike in the audio is what
    // later upgrades a clip's sync from 'coarse' to 'fine'. Optional (`?`) so a
    // camera recording silent still yields a clip rather than a failed trim.
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    // a seek + stream copy can leave the first packet at a negative timestamp
    '-avoid_negative_ts',
    'make_zero',
    // moov atom to the front: the UI scrubs these over HTTP Range, and a player
    // that has to fetch the tail before it can seek makes that feel broken
    '-movflags',
    '+faststart',
    output,
  ];
}

export function probeArgs(file: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,r_frame_rate',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    file,
  ];
}

interface ProbeJson {
  streams?: {
    width?: number;
    height?: number;
    r_frame_rate?: string;
  }[];
  format?: { duration?: string };
}

/**
 * ffprobe JSON → the four numbers a clip row needs. Every one of them is
 * required: the ingest endpoint rejects a non-positive duration, fps or frame
 * size, so a probe that came back vague has to fail here, where the cause is
 * still visible, rather than as a 400 three steps later.
 */
export function parseProbe(stdout: string): ClipProbe {
  let json: ProbeJson;
  try {
    json = JSON.parse(stdout) as ProbeJson;
  } catch {
    throw new Error(`ffprobe returned no JSON: ${stdout.slice(0, 200)}`);
  }
  const stream = json.streams?.[0];
  if (!stream) throw new Error('ffprobe found no video stream in the clip');
  const durationS = Number(json.format?.duration);
  const width = Number(stream.width);
  const height = Number(stream.height);
  const [num, den] = (stream.r_frame_rate ?? '').split('/');
  const fps = Number(num) / Number(den ?? 1);

  const bad = (what: string, value: unknown): Error =>
    new Error(`ffprobe gave no usable ${what} (${String(value)})`);
  if (!Number.isFinite(durationS) || durationS <= 0) {
    throw bad('duration', json.format?.duration);
  }
  if (!Number.isFinite(fps) || fps <= 0) throw bad('fps', stream.r_frame_rate);
  if (!Number.isFinite(width) || width <= 0) throw bad('width', stream.width);
  if (!Number.isFinite(height) || height <= 0) throw bad('height', stream.height);

  return {
    durationMs: durationS * 1000,
    // 120000/1001 and friends: the row wants the frame rate, not the ratio
    fps: Math.round(fps * 1000) / 1000,
    width,
    height,
  };
}

export function createFfmpegTrimmer(): ClipTrimmer {
  return {
    async preflight() {
      try {
        await run('ffmpeg', ['-version']);
        await run('ffprobe', ['-version']);
      } catch (err) {
        throw new TrimToolsMissingError(
          err instanceof Error ? err.message.split('\n')[0] : String(err),
        );
      }
    },

    async trimFromEnd(input, output, fromEndMs) {
      await run('ffmpeg', trimArgs(input, output, fromEndMs), {
        maxBuffer: 1024 * 1024,
      });
    },

    async probe(file) {
      const { stdout } = await run('ffprobe', probeArgs(file), {
        maxBuffer: 1024 * 1024,
      });
      return parseProbe(stdout);
    },
  };
}
