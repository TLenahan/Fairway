import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CaptureRequest, Clip } from '@golf/types';

import { createHttpClipSeam } from '../client';
import { CaptureHarness, buildCaptureHarness } from '../testing';
import { GoProCamera, GoProState, HindsightWindow } from './camera';
import { GoProDriver, createGoProDriver } from './driver';
import { ClipProbe, ClipTrimmer } from './trim';

/**
 * The driver against the real seam — real endpoints, real registry, real
 * SQLite, real clip files. Only the two things that are not code are faked: the
 * camera body, and the ffmpeg the trim shells out to.
 *
 * The clock is fake and only moves when the driver sleeps, so a capture that
 * takes 9 seconds of camera time takes none of jest's, and every timing the
 * driver derives is exactly reproducible.
 */
const T0 = 1_800_000_000_000;
const HOLD_MS = 3_500;
const PRE_ROLL_MS = 5_000;
/**
 * How much longer than asked a `-c copy` cut comes out, because it snaps back
 * to the previous keyframe. The whole point of measuring from the end is that
 * this number does not have to be known — so the fake picks an awkward one.
 */
const KEYFRAME_SLOP_MS = 437;

class FakeCamera implements GoProCamera {
  readonly address = '172.24.106.51';
  hindsightActive = false;
  encoding = false;
  batteryPct: number | null = 88;
  /** What is on the card. A save appends to it. */
  files = ['100GOPRO/GX010001.MP4'];
  /** Untrimmed length of the file a trigger produces. */
  saveDurationMs = 18_500;
  /** Set false to play a body that will not come back after a save. */
  rearmsAfterSave = true;
  /** Set false to play a body that is not plugged in. */
  reachable = true;
  /** Every call, in order — what the timing assertions read. */
  readonly calls: string[] = [];
  /** Milliseconds the save takes to appear, on the shared fake clock. */
  encodeMs = 1_000;
  private appearsAt: number | null = null;
  private nextFile = 2;

  constructor(private readonly clock: () => number) {}

  private check(call: string): void {
    this.calls.push(call);
    if (!this.reachable) throw new Error('connect ECONNREFUSED');
  }

  async enableWiredControl(): Promise<void> {
    this.check('wired');
  }

  async setClock(): Promise<void> {
    this.check('clock');
  }

  async setHindsight(window: HindsightWindow): Promise<void> {
    this.check(`hindsight:${window}`);
    this.hindsightActive = window !== 'off';
  }

  async state(): Promise<GoProState> {
    this.check('state');
    // A pending save becomes visible on the card once the encode window passes.
    if (this.appearsAt !== null && this.clock() >= this.appearsAt) {
      this.files.push(`100GOPRO/GX0100${String(this.nextFile++).padStart(2, '0')}.MP4`);
      this.appearsAt = null;
      this.hindsightActive = this.rearmsAfterSave;
    }
    return {
      hindsightActive: this.hindsightActive,
      encoding: this.encoding,
      batteryPct: this.batteryPct,
    };
  }

  async shutter(on: boolean): Promise<void> {
    this.check(`shutter:${on ? 'start' : 'stop'}`);
    if (on) {
      this.hindsightActive = false; // the buffer is locked, not rolling
      return;
    }
    this.appearsAt = this.clock() + this.encodeMs;
  }

  async keepAlive(): Promise<void> {
    this.check('keepalive');
  }

  async mediaList(): Promise<string[]> {
    this.check('media');
    if (this.appearsAt !== null && this.clock() >= this.appearsAt) {
      this.files.push(`100GOPRO/GX0100${String(this.nextFile++).padStart(2, '0')}.MP4`);
      this.appearsAt = null;
      this.hindsightActive = this.rearmsAfterSave;
    }
    return [...this.files];
  }

  async download(remotePath: string, destFile: string): Promise<number> {
    this.check(`download:${remotePath}`);
    const bytes = Buffer.from(`save-of-${remotePath}`);
    writeFileSync(destFile, bytes);
    return bytes.length;
  }
}

interface TrimCall {
  input: string;
  output: string;
  fromEndMs: number;
}

/**
 * ffmpeg as far as the driver can tell: the cut lands on the keyframe before
 * the one asked for, so the output is SLOP longer than requested — and never
 * longer than the source.
 */
function fakeTrimmer(camera: FakeCamera): ClipTrimmer & { calls: TrimCall[] } {
  const calls: TrimCall[] = [];
  let last: ClipProbe | null = null;
  return {
    calls,
    async preflight() {},
    async trimFromEnd(input, output, fromEndMs) {
      calls.push({ input, output, fromEndMs });
      const durationMs = Math.min(
        fromEndMs + KEYFRAME_SLOP_MS,
        camera.saveDurationMs,
      );
      last = { durationMs, fps: 119.88, width: 1920, height: 1080 };
      writeFileSync(output, `trimmed-${Math.round(durationMs)}ms`);
    },
    async probe() {
      if (!last) throw new Error('probe before trim');
      return last;
    },
  };
}

interface Rig {
  harness: CaptureHarness;
  camera: FakeCamera;
  trimmer: ReturnType<typeof fakeTrimmer>;
  driver: GoProDriver;
  logs: string[];
  workDir: string;
  tick(ms: number): void;
  ask(shotId: string): CaptureRequest;
  close(): Promise<void>;
}

async function build(
  overrides: Partial<Parameters<typeof createGoProDriver>[0]> = {},
): Promise<Rig> {
  const workDir = mkdtempSync(join(tmpdir(), 'fairway-gopro-'));
  let clock = T0;
  const now = (): number => clock;
  // One clock for both halves: a request's age is the whole basis of the
  // driver's decision to trigger, so the hub and the camera client cannot be
  // reading different ones.
  const harness = await buildCaptureHarness({ now });
  const camera = new FakeCamera(now);
  const trimmer = fakeTrimmer(camera);
  const logs: string[] = [];

  const driver = createGoProDriver({
    camera,
    seam: createHttpClipSeam(harness.base),
    trimmer,
    view: 'down_the_line',
    workDir,
    preRollMs: PRE_ROLL_MS,
    holdMs: HOLD_MS,
    now,
    // The only clock that moves is the one the driver waits on.
    sleep: async (ms: number) => {
      clock += ms;
    },
    log: (m) => logs.push(m),
    ...overrides,
  });

  return {
    harness,
    camera,
    trimmer,
    driver,
    logs,
    workDir,
    tick: (ms) => {
      clock += ms;
    },
    ask: (shotId) =>
      harness.deps.registry.open({
        shotId,
        sessionId: harness.sessionId,
        source: 'gopro',
        view: 'down_the_line',
      }),
    async close() {
      driver.stop();
      await harness.close();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

describe('GoPro driver', () => {
  let rig: Rig;
  afterEach(async () => {
    await rig.close();
  });

  it('arms Hindsight before it will trigger on anything', async () => {
    rig = await build();
    expect(rig.driver.status().armed).toBe(false);

    await rig.driver.start();

    expect(rig.driver.status().armed).toBe(true);
    expect(rig.camera.calls).toEqual(['wired', 'clock', 'hindsight:15', 'state', 'state']);
    expect(rig.logs.join('\n')).toContain('armed on 172.24.106.51');
  });

  it('fulfils a request end to end and files the clip against that shot', async () => {
    rig = await build();
    await rig.driver.start();
    const request = rig.ask(rig.harness.shot.id);

    await rig.driver.poll();

    const clips = await rig.harness.data.listClipsByShot(rig.harness.shot.id);
    expect(clips).toHaveLength(1);
    const [clip] = clips;
    expect(clip.source).toBe('gopro');
    expect(clip.view).toBe('down_the_line');
    // the trigger instant, not the upload's
    expect(clip.capturedAt).toBe(request.requestedAt);
    expect(clip.fps).toBe(119.88);
    expect(clip.width).toBe(1920);

    // The camera did the whole dance, in order.
    expect(rig.camera.calls).toEqual(
      expect.arrayContaining([
        'shutter:start',
        'shutter:stop',
        'download:100GOPRO/GX010002.MP4',
      ]),
    );
    // Trim asked for the run-up plus everything from impact to the stop —
    // the poll had no lag on the fake clock, so the tail is just the hold.
    expect(rig.trimmer.calls).toEqual([
      expect.objectContaining({ fromEndMs: PRE_ROLL_MS + HOLD_MS }),
    ]);
    // and the request is spent
    expect(rig.harness.deps.registry.pending()).toEqual([]);
  });

  it('locates impact by measuring back from the end, not from the cut', async () => {
    rig = await build();
    await rig.driver.start();
    await rig.ask(rig.harness.shot.id);

    await rig.driver.poll();

    const [clip] = await rig.harness.data.listClipsByShot(rig.harness.shot.id);
    // The cut overshot to the previous keyframe, so the clip is longer at the
    // front than asked — and impact is that much further in. Anchoring on the
    // end is what makes the offset survive not knowing where the cut landed.
    expect(clip.durationMs).toBe(PRE_ROLL_MS + HOLD_MS + KEYFRAME_SLOP_MS);
    expect(clip.impactOffsetMs).toBe(PRE_ROLL_MS + KEYFRAME_SLOP_MS);
    // Ingest still refuses to call any of this a located impact.
    expect(clip.sync).toBe('coarse');
  });

  it('leaves other cameras and other views alone', async () => {
    rig = await build();
    await rig.driver.start();
    const phone = rig.harness.deps.registry.open({
      shotId: rig.harness.shot.id,
      sessionId: rig.harness.sessionId,
      source: 'phone',
      view: 'face_on',
    });
    const otherView = rig.harness.deps.registry.open({
      shotId: rig.harness.shot.id,
      sessionId: rig.harness.sessionId,
      source: 'gopro',
      view: 'face_on',
    });

    await rig.driver.poll();

    expect(rig.camera.calls).not.toContain('shutter:start');
    expect(rig.harness.deps.registry.pending()).toEqual([phone, otherView]);
  });

  it('refuses a request the pre-roll can no longer reach back to', async () => {
    rig = await build();
    await rig.driver.start();
    const request = rig.ask(rig.harness.shot.id);

    // 15 s of buffer, 5 s of run-up wanted: a trigger more than ~8.5 s after
    // the strike would save what happened AFTER the swing and file it as the
    // swing. Better the shot has no clip.
    rig.tick(9_000);
    await rig.driver.poll();

    expect(rig.camera.calls).not.toContain('shutter:start');
    expect(await rig.harness.data.listClipsByShot(rig.harness.shot.id)).toEqual([]);
    expect(rig.logs.join('\n')).toContain('past the 8.5s the pre-roll reaches back');

    // and it does not keep re-deciding that every 500 ms for the next two
    // minutes the request stays pending
    rig.logs.length = 0;
    await rig.driver.poll();
    await rig.driver.poll();
    expect(rig.logs).toEqual([]);
    expect(rig.harness.deps.registry.pending()).toEqual([request]);
  });

  it('refuses to upload a clip with no backswing in it', async () => {
    rig = await build();
    await rig.driver.start();
    // The buffer was nearly empty — the camera had just been armed — so the
    // save is barely longer than the forward recording.
    rig.camera.saveDurationMs = HOLD_MS + 900;
    await rig.ask(rig.harness.shot.id);

    await rig.driver.poll();

    expect(await rig.harness.data.listClipsByShot(rig.harness.shot.id)).toEqual([]);
    expect(rig.logs.join('\n')).toContain('the backswing is not in it');
  });

  it('will not trigger while Hindsight is down', async () => {
    rig = await build();
    await rig.driver.start();
    rig.camera.hindsightActive = false;
    rig.camera.rearmsAfterSave = false;
    // one capture that leaves the camera disarmed
    await rig.ask(rig.harness.shot.id);
    await rig.driver.poll();
    expect(rig.driver.status().armed).toBe(false);

    const second = await rig.harness.addShot('g-2');
    rig.camera.calls.length = 0;
    await rig.ask(second.id);
    await rig.driver.poll();

    // no trigger at all — a clip with no pre-roll is not worth having
    expect(rig.camera.calls).toEqual([]);
    expect(await rig.harness.data.listClipsByShot(second.id)).toEqual([]);
  });

  it('re-arms a camera that idled its Hindsight off', async () => {
    rig = await build();
    await rig.driver.start();
    rig.camera.hindsightActive = false; // the ~15 min idle self-disarm

    await rig.driver.tend();

    expect(rig.camera.calls).toContain('keepalive');
    expect(rig.driver.status().armed).toBe(true);
    expect(rig.logs.join('\n')).toContain('re-armed');
  });

  it('keeps trying a camera that was not plugged in at startup', async () => {
    rig = await build();
    rig.camera.reachable = false;

    await rig.driver.start();
    expect(rig.driver.status().armed).toBe(false);
    expect(rig.logs.join('\n')).toContain('camera not ready');

    rig.camera.reachable = true;
    await rig.driver.tend();

    expect(rig.driver.status().armed).toBe(true);
  });

  it('captures shot after shot, each against its own request', async () => {
    rig = await build();
    await rig.driver.start();
    const second = await rig.harness.addShot('g-2');

    await rig.ask(rig.harness.shot.id);
    await rig.driver.poll();
    rig.tick(15_000); // realistic spacing between shots
    await rig.ask(second.id);
    await rig.driver.poll();

    const first = await rig.harness.data.listClipsByShot(rig.harness.shot.id);
    const next = await rig.harness.data.listClipsByShot(second.id);
    expect(first).toHaveLength(1);
    expect(next).toHaveLength(1);
    expect(first[0].id).not.toBe(next[0].id);
    expect(first[0].path).not.toBe(next[0].path);
    // each clip is the file the camera saved for that trigger
    expect(rig.camera.calls.filter((c) => c.startsWith('download'))).toEqual([
      'download:100GOPRO/GX010002.MP4',
      'download:100GOPRO/GX010003.MP4',
    ]);
  });

  it('gives up on a save that never lands, and leaves no clip behind', async () => {
    rig = await build({ encodeTimeoutMs: 5_000 });
    await rig.driver.start();
    rig.camera.encodeMs = 60_000; // the card is thinking about it
    await rig.ask(rig.harness.shot.id);

    await rig.driver.poll();

    expect(await rig.harness.data.listClipsByShot(rig.harness.shot.id)).toEqual([]);
    expect(rig.logs.join('\n')).toContain('no save appeared within 5s');
  });

  it('cleans up the scratch files whether the capture worked or not', async () => {
    rig = await build();
    await rig.driver.start();
    await rig.ask(rig.harness.shot.id);
    await rig.driver.poll();

    expect(readdirSync(rig.workDir)).toEqual([]);
  });

  it('does not stand up at all without ffmpeg', async () => {
    rig = await build({
      trimmer: {
        preflight: () => Promise.reject(new Error('ffmpeg/ffprobe not usable')),
        trimFromEnd: () => Promise.reject(new Error('unreachable')),
        probe: () => Promise.reject(new Error('unreachable')),
      },
    });

    // Fatal on purpose: every capture would pull 200 MB over USB and then have
    // nothing to do with it.
    await expect(rig.driver.start()).rejects.toThrow('ffmpeg/ffprobe not usable');
    expect(rig.camera.calls).toEqual([]);
  });

  it('serves what it captured back for playback', async () => {
    rig = await build();
    await rig.driver.start();
    await rig.ask(rig.harness.shot.id);
    await rig.driver.poll();
    const [clip] = await rig.harness.data.listClipsByShot(rig.harness.shot.id);

    const res = await fetch(`${rig.harness.base}/api/clips/${clip.id}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    const body = Buffer.from(await res.arrayBuffer()).toString();
    expect(body).toBe(`trimmed-${clip.durationMs}ms`);
  });
});

describe('GoPro driver — the seam it speaks', () => {
  it('reports the clip it uploaded the way the hub reports it back', async () => {
    const rig = await build();
    try {
      await rig.driver.start();
      await rig.ask(rig.harness.shot.id);
      await rig.driver.poll();

      const res = await fetch(
        `${rig.harness.base}/api/clips?shotId=${rig.harness.shot.id}`,
      );
      const { clips } = (await res.json()) as { clips: Clip[] };
      expect(clips).toHaveLength(1);
      expect(clips[0]).toMatchObject({
        source: 'gopro',
        view: 'down_the_line',
        sync: 'coarse',
        fps: 119.88,
        width: 1920,
        height: 1080,
      });
    } finally {
      await rig.close();
    }
  });
});
