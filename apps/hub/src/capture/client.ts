import { readFile } from 'node:fs/promises';

import { CaptureRequest, CaptureRequestSchema } from '@golf/types';

/**
 * The camera's half of the capture endpoints — poll for asks, send bytes back
 * quoting the id.
 *
 * The GoPro driver runs inside the hub process and could reach the registry
 * directly. It goes over HTTP anyway, deliberately: the seam then has exactly
 * one shape, the same one the phone speaks, so a contract change cannot be
 * half-applied. It also means the driver is not actually tied to the process —
 * point it at another host's hub and it works unchanged.
 */
export interface ClipUploadMeta {
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  /**
   * Milliseconds from the first frame to impact. Always an estimate here — it
   * is derived from when the camera was told to stop — which is why ingest
   * files it as `sync: 'coarse'` no matter what a client claims.
   */
  impactOffsetMs: number;
}

export interface ClipSeam {
  /** Every live ask; the caller filters to the camera it is. */
  pending(): Promise<CaptureRequest[]>;
  /** Send a file against a request. Throws unless the hub files a clip. */
  upload(
    request: CaptureRequest,
    meta: ClipUploadMeta,
    file: string,
  ): Promise<void>;
}

export function createHttpClipSeam(baseUrl: string): ClipSeam {
  const root = baseUrl.replace(/\/$/, '');
  return {
    async pending() {
      const res = await fetch(`${root}/api/clips/pending`);
      if (!res.ok) throw new Error(`pending → ${res.status}`);
      const body = (await res.json()) as { requests: unknown };
      // Parsed, not cast: a driver that misreads a request captures the wrong
      // swing, and the shape is the only thing tying the two halves together.
      return CaptureRequestSchema.array().parse(body.requests);
    },

    async upload(request, meta, file) {
      const query = new URLSearchParams({
        request: request.id,
        durationMs: String(Math.round(meta.durationMs)),
        fps: String(meta.fps),
        width: String(meta.width),
        height: String(meta.height),
        impactOffsetMs: String(Math.round(meta.impactOffsetMs)),
      });
      const res = await fetch(`${root}/api/clips?${query}`, {
        method: 'POST',
        body: new Uint8Array(await readFile(file)),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`upload → ${res.status} ${detail}`.trim());
      }
    },
  };
}
