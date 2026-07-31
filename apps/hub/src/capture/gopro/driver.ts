import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { CaptureRequest, ClipView } from '@golf/types';

import { ClipSeam } from '../client';
import { GoProCamera, HindsightWindow } from './camera';
import { ClipTrimmer } from './trim';

/**
 * The GoPro half of the capture seam: a client that polls the hub for the
 * footage the hub asked for, and answers with nine seconds of swing.
 *
 * Per shot the loop is: lock the Hindsight pre-roll with `shutter/start`, record
 * a few seconds forward, stop, wait out the encode, pull the save over USB, trim
 * it down from the end, and upload it against the request that asked for it.
 *
 * Two things it will not do, both for the same reason — a clip filed against
 * the wrong swing is worse than no clip at all:
 *
 *  - It never captures against a request whose shot has aged out of the
 *    pre-roll. Hindsight's buffer is a window ending at the trigger, so a
 *    request the driver got to late would save the seconds AFTER the swing and
 *    file them as the swing.
 *  - It never uploads a clip whose measured run-up is too short to hold the
 *    backswing, however the trim came out.
 *
 * A dropped request is left to expire. There is no way to tell the seam "not
 * this one" and there should not be: the hub having asked and no clip arriving
 * is already the whole story.
 */
export interface GoProDriverConfig {
  camera: GoProCamera;
  seam: ClipSeam;
  trimmer: ClipTrimmer;
  /** Which view this body is pointed at — it answers only its own requests. */
  view: ClipView;
  /** Scratch space for the untrimmed save; cleared as it goes. */
  workDir: string;
  /** Pre-roll the camera holds (setting 167). 15 s is plenty for a swing. */
  hindsight?: Exclude<HindsightWindow, 'off'>;
  /** How much run-up before impact to keep. */
  preRollMs?: number;
  /** How long to keep recording forward after the trigger. */
  holdMs?: number;
  /** Below this much measured run-up the clip is not a swing; refuse it. */
  minPreRollMs?: number;
  pollMs?: number;
  keepAliveMs?: number;
  /** Budget for the save to finish encoding and appear in the media list. */
  encodeTimeoutMs?: number;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  log?(message: string): void;
}

export interface GoProDriver {
  /**
   * Preflight the trim tools, then arm. Rejects only when ffmpeg/ffprobe are
   * missing — that will not fix itself, and every capture would pull 200 MB
   * over USB and then have nothing to do with it. A camera that is unreachable
   * is NOT fatal: the watchdog keeps trying, so plugging the cable in after the
   * hub has started is enough.
   */
  start(): Promise<void>;
  /** Clears the timers. Leaves the camera armed; it idles down on its own. */
  stop(): void;
  /** One pass over the pending queue. The poll timer calls this. */
  poll(): Promise<void>;
  /** Keep-alive plus the re-arm check. The watchdog timer calls this. */
  tend(): Promise<void>;
  status(): { armed: boolean; busy: boolean };
}

const DEFAULTS = {
  hindsight: 15,
  preRollMs: 5_000,
  holdMs: 3_500,
  minPreRollMs: 1_500,
  pollMs: 500,
  keepAliveMs: 60_000,
  encodeTimeoutMs: 30_000,
  /**
   * Slack on the staleness gate. Two things it absorbs: the buffer is only
   * approximately its nominal length, and `requestedAt` is stamped when the
   * monitor's shot reached the hub, which is already some way after the strike
   * — so impact is always a little older than the arithmetic says.
   */
  staleMarginMs: 1_500,
  /** How long to wait for status 106 after asking for it. */
  armTimeoutMs: 10_000,
  /** Spacing for the two "has it happened yet" polls: re-arm and the save. */
  retryMs: 500,
} as const;

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10}s`;

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function createGoProDriver(config: GoProDriverConfig): GoProDriver {
  const { camera, seam, trimmer, view, workDir } = config;
  const hindsight = config.hindsight ?? DEFAULTS.hindsight;
  const preRollMs = config.preRollMs ?? DEFAULTS.preRollMs;
  const holdMs = config.holdMs ?? DEFAULTS.holdMs;
  const minPreRollMs = config.minPreRollMs ?? DEFAULTS.minPreRollMs;
  const pollMs = config.pollMs ?? DEFAULTS.pollMs;
  const keepAliveMs = config.keepAliveMs ?? DEFAULTS.keepAliveMs;
  const encodeTimeoutMs = config.encodeTimeoutMs ?? DEFAULTS.encodeTimeoutMs;
  const now = config.now ?? Date.now;
  const sleep =
    config.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const log = config.log ?? ((m: string): void => console.log(`[gopro:${view}] ${m}`));

  /**
   * How late the trigger may be and still catch the swing. The buffer is a
   * window ending at the trigger, so keeping `preRollMs` of run-up means
   * triggering within `window - preRoll` of impact.
   */
  const maxTriggerLagMs = hindsight * 1_000 - preRollMs - DEFAULTS.staleMarginMs;

  /** Requests already fulfilled or abandoned, so neither is retried. */
  const handled = new Set<string>();
  let armed = false;
  let busy = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let tendTimer: NodeJS.Timeout | null = null;

  const waitForArmed = async (budgetMs: number): Promise<boolean> => {
    const deadline = now() + budgetMs;
    for (;;) {
      const state = await camera.state().catch(() => null);
      if (state?.hindsightActive) return true;
      if (now() >= deadline) return false;
      await sleep(DEFAULTS.retryMs);
    }
  };

  /** Idempotent: safe armed, disarmed, or with the cable just back in. */
  const ensureArmed = async (): Promise<boolean> => {
    try {
      // Usually already on, and some firmwares answer this with an error
      // rather than a shrug. Either way it is not a reason to stop.
      await camera
        .enableWiredControl()
        .catch((err: unknown) => log(`wired control: ${message(err)}`));
      await camera.setClock(new Date(now()));
      await camera.setHindsight(hindsight);
      armed = await waitForArmed(DEFAULTS.armTimeoutMs);
      if (!armed) log('asked for Hindsight but status 106 never came up');
    } catch (err) {
      armed = false;
      log(`not armed: ${message(err)}`);
    }
    return armed;
  };

  /** The one new file this trigger produced. */
  const waitForSave = async (before: Set<string>): Promise<string> => {
    const deadline = now() + encodeTimeoutMs;
    for (;;) {
      // 503s and the odd 404 are normal while the camera writes the save.
      const files = await camera.mediaList().catch(() => [] as string[]);
      const fresh = files.filter((file) => !before.has(file)).sort();
      if (fresh.length > 1) {
        log(`${fresh.length} new files on the card; taking ${fresh.at(-1)}`);
      }
      const file = fresh.at(-1);
      if (file) return file;
      if (now() >= deadline) {
        throw new Error(`no save appeared within ${seconds(encodeTimeoutMs)}`);
      }
      await sleep(DEFAULTS.retryMs);
    }
  };

  const capture = async (request: CaptureRequest): Promise<void> => {
    const source = join(workDir, `${request.id}.src.mp4`);
    const trimmed = join(workDir, `${request.id}.mp4`);
    try {
      const before = new Set(await camera.mediaList());

      await camera.shutter(true);
      await sleep(holdMs);
      const stopSentAt = now();
      await camera.shutter(false);
      // The last frame lands somewhere inside this round trip. Splitting it is
      // the best guess available, and which end it really was is exactly the
      // uncertainty that keeps a clip's sync 'coarse' until an audio pass.
      const stoppedAt = (stopSentAt + now()) / 2;

      const remote = await waitForSave(before);
      const bytes = await camera.download(remote, source);

      // From here everything is measured backwards from the end of the file,
      // the one instant in it the hub knows (see trim.ts).
      const tailMs = stoppedAt - request.requestedAt;
      await trimmer.trimFromEnd(source, trimmed, preRollMs + tailMs);
      const probe = await trimmer.probe(trimmed);
      const impactOffsetMs = probe.durationMs - tailMs;
      if (impactOffsetMs < minPreRollMs) {
        throw new Error(
          `only ${Math.round(impactOffsetMs)} ms of run-up in the clip — ` +
            'the backswing is not in it',
        );
      }

      await seam.upload(request, { ...probe, impactOffsetMs }, trimmed);
      log(
        `shot ${request.shotId}: ${seconds(probe.durationMs)} @ ${probe.fps}fps, ` +
          `impact at ${seconds(impactOffsetMs)}, ${Math.round(bytes / 1e6)} MB pulled, ` +
          `${seconds(now() - request.requestedAt)} end to end`,
      );
    } catch (err) {
      log(`shot ${request.shotId}: no clip — ${message(err)}`);
    } finally {
      await rm(source, { force: true }).catch(() => undefined);
      await rm(trimmed, { force: true }).catch(() => undefined);
    }
  };

  /** The oldest live request this camera can still honestly answer. */
  const pick = (requests: CaptureRequest[]): CaptureRequest | null => {
    const at = now();
    for (const request of requests) {
      if (handled.has(request.id)) continue;
      const lag = at - request.requestedAt;
      if (lag > maxTriggerLagMs) {
        // Triggering now would save the seconds after the swing and file them
        // as the swing. Better that the shot has no clip.
        handled.add(request.id);
        log(
          `shot ${request.shotId}: skipped — ${seconds(lag)} old, past the ` +
            `${seconds(maxTriggerLagMs)} the pre-roll reaches back`,
        );
        continue;
      }
      return request;
    }
    return null;
  };

  const poll = async (): Promise<void> => {
    if (busy || !armed) return;
    let requests: CaptureRequest[];
    try {
      requests = await seam.pending();
    } catch (err) {
      log(`could not read pending requests: ${message(err)}`);
      return;
    }
    const mine = requests.filter((r) => r.source === 'gopro' && r.view === view);
    // Forget ids that are no longer live — claimed or expired — so the set
    // cannot grow all session on the strength of skipped shots.
    const live = new Set(mine.map((r) => r.id));
    for (const id of handled) if (!live.has(id)) handled.delete(id);

    const request = pick(mine);
    if (!request) return;

    busy = true;
    handled.add(request.id);
    try {
      await capture(request);
    } finally {
      // A save drops Hindsight while the camera writes it. Usually it comes
      // straight back; until it has, stay busy — triggering on the next shot
      // would hand back a clip with no pre-roll in it.
      armed = await waitForArmed(DEFAULTS.armTimeoutMs);
      if (!armed) log('Hindsight did not come back after the save');
      busy = false;
    }
  };

  const tend = async (): Promise<void> => {
    if (busy) return;
    try {
      await camera.keepAlive();
    } catch (err) {
      log(`keep-alive failed: ${message(err)}`);
    }
    if (armed) {
      const state = await camera.state().catch(() => null);
      if (state?.hindsightActive) return;
      armed = false;
      log('Hindsight went inactive — re-arming');
    }
    if (await ensureArmed()) log('re-armed');
  };

  return {
    async start() {
      await trimmer.preflight();
      await mkdir(workDir, { recursive: true });
      // A crash mid-capture leaves a couple hundred megabytes behind.
      for (const stale of await readdir(workDir).catch(() => [])) {
        await rm(join(workDir, stale), { force: true }).catch(() => undefined);
      }

      if (await ensureArmed()) {
        const battery = (await camera.state().catch(() => null))?.batteryPct;
        log(
          `armed on ${camera.address} — ${hindsight}s Hindsight, ` +
            `${seconds(preRollMs)} pre-roll` +
            (typeof battery === 'number' ? `, battery ${battery}%` : ''),
        );
      } else {
        log(
          `camera not ready on ${camera.address} — ` +
            `retrying every ${seconds(keepAliveMs)}`,
        );
      }

      pollTimer = setInterval(() => void poll(), pollMs);
      tendTimer = setInterval(() => void tend(), keepAliveMs);
      pollTimer.unref();
      tendTimer.unref();
    },

    stop() {
      if (pollTimer) clearInterval(pollTimer);
      if (tendTimer) clearInterval(tendTimer);
      pollTimer = null;
      tendTimer = null;
      // Deliberately not disarming: a shutdown should not need the camera to
      // answer, and an armed camera idles itself down within the quarter hour.
      log('stopped');
    },

    poll,
    tend,
    status: () => ({ armed, busy }),
  };
}
