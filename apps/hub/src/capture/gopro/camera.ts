import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * The camera as the driver needs it — Open GoPro 2.0 HTTP, over the wired USB
 * (NCM) link rather than wifi: one cable carries power, control and the media
 * pull at ~40 MB/s, and the range is a bad place to be sharing a wifi radio
 * with a launch monitor.
 *
 * An interface rather than direct fetch calls so the driver's whole loop —
 * arm, trigger, wait for the encode, pull, re-arm — runs in jest against a fake
 * body. The same seam the BLE, monitor and MCP transports use.
 *
 * Camera IP derives from the serial: last three digits ABC → 172.2A.1BC.51.
 * Requires firmware >= v01.30.00 (HERO 10+); see handoff/GOPRO_CAPTURE.md.
 */
export interface GoProCamera {
  /** Human label for logs — the address, so two bodies are tellable apart. */
  readonly address: string;
  /** Wired control must be enabled before anything else answers. */
  enableWiredControl(): Promise<void>;
  /**
   * Camera clock. Cosmetic for our purposes: every timing the driver derives
   * is measured against the file's end on the HOST clock, so a camera an hour
   * out would still produce a correctly-aligned clip. Set anyway so the media
   * on the card is legible to a human.
   */
  setClock(at: Date): Promise<void>;
  /** Setting 167. `off` is how a shutdown leaves the camera idle. */
  setHindsight(window: HindsightWindow): Promise<void>;
  state(): Promise<GoProState>;
  /** shutter/start locks the pre-roll and records forward; stop saves it. */
  shutter(on: boolean): Promise<void>;
  /** Required at least every 120 s or the camera powers itself down. */
  keepAlive(): Promise<void>;
  /** `100GOPRO/GX010023.MP4` entries, newest last. */
  mediaList(): Promise<string[]>;
  /** Streams to `destFile` — a 15 s 1080p120 save is 150-250 MB. */
  download(remotePath: string, destFile: string): Promise<number>;
}

/** Seconds of pre-roll the camera holds, or off. Setting 167's options. */
export type HindsightWindow = 15 | 30 | 'off';

export interface GoProState {
  /** status 106 — the pre-roll buffer is live and a trigger will save it */
  hindsightActive: boolean;
  /** status 8 — encoding; settings changes are refused while it is true */
  encoding: boolean;
  /** status 70, percent */
  batteryPct: number | null;
}

const HINDSIGHT_OPTION: Record<string, number> = { '15': 2, '30': 3, off: 4 };

interface StateJson {
  status?: Record<string, number | undefined>;
}

interface MediaListJson {
  media?: { d?: string; fs?: { n?: string }[] }[];
}

/** The camera's HTTP server, on every body. */
const GOPRO_PORT = 8080;

/**
 * `address` is the camera's IP — `172.24.106.51`. A port may be appended to
 * point this at something other than a camera; the GoPro's own is always 8080.
 */
export function createHttpCamera(
  address: string,
  timeoutMs = 5_000,
): GoProCamera {
  const base = `http://${
    address.includes(':') ? address : `${address}:${GOPRO_PORT}`
  }`;

  const get = async (path: string, ms = timeoutMs): Promise<Response> => {
    const res = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(ms),
    });
    // 503 while the camera is busy encoding is normal and retryable; the
    // caller decides whether to wait, so it needs the status, not a boolean.
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res;
  };

  return {
    address,

    async enableWiredControl() {
      await get('/gopro/camera/control/wired_usb?p=1');
    },

    async setClock(at) {
      const date = `${at.getFullYear()}_${at.getMonth() + 1}_${at.getDate()}`;
      const time = `${at.getHours()}_${at.getMinutes()}_${at.getSeconds()}`;
      await get(`/gopro/camera/set_date_time?date=${date}&time=${time}`);
    },

    async setHindsight(window) {
      const option = HINDSIGHT_OPTION[String(window)];
      await get(`/gopro/camera/setting?setting=167&option=${option}`);
    },

    async state() {
      const json = (await (await get('/gopro/camera/state')).json()) as StateJson;
      const status = json.status ?? {};
      return {
        hindsightActive: status['106'] === 1,
        encoding: status['8'] === 1,
        batteryPct: status['70'] ?? null,
      };
    },

    async shutter(on) {
      await get(`/gopro/camera/shutter/${on ? 'start' : 'stop'}`);
    },

    async keepAlive() {
      await get('/gopro/camera/keep_alive');
    },

    async mediaList() {
      const json = (await (
        await get('/gopro/media/list')
      ).json()) as MediaListJson;
      const files: string[] = [];
      for (const dir of json.media ?? []) {
        for (const file of dir.fs ?? []) {
          if (dir.d && file.n) files.push(`${dir.d}/${file.n}`);
        }
      }
      return files;
    },

    async download(remotePath, destFile) {
      // Streamed, not buffered: the untrimmed save is the biggest thing that
      // crosses this process, and it is about to be thrown away down to nine
      // seconds. Five minutes is a stall guard, not a budget — the pull is
      // 2-4 s over USB.
      const res = await get(`/videos/DCIM/${remotePath}`, 300_000);
      if (!res.body) throw new Error(`${remotePath} → empty body`);
      const reader = res.body.getReader();
      let bytes = 0;
      const chunks = async function* (): AsyncGenerator<Uint8Array> {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          bytes += value.length;
          yield value;
        }
      };
      await pipeline(chunks(), createWriteStream(destFile));
      return bytes;
    },
  };
}
