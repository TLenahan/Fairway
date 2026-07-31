import { CaptureRequest, ClipSource, ClipView } from '@golf/types';

/**
 * The hub's outstanding asks for footage.
 *
 * A shot lands, the hub asks each configured camera for its pre-roll, and the
 * camera returns bytes quoting the request id. That id is the whole reason the
 * clip↔shot link is exact rather than a nearest-neighbour guess (see
 * @golf/types clip.ts): the hub knew the shot before the camera knew there was
 * anything to send.
 *
 * In memory only. An unfulfilled request is not history — a camera that missed
 * its window should leave nothing behind, and a request that outlives a hub
 * restart would be an ask no camera is still listening for.
 */
export interface CaptureRegistry {
  /** Ask for one camera's footage of one shot. */
  open(input: {
    shotId: string;
    sessionId: string;
    source: ClipSource;
    view: ClipView;
  }): CaptureRequest;
  /**
   * Redeem a request. Single-use: the second upload quoting an id gets
   * `null`, because two files cannot both be *the* clip that request asked
   * for, and accepting both would file one of them against a swing it is not
   * of. Returns null for unknown and for expired.
   */
  claim(id: string): CaptureRequest | null;
  /** Live requests, oldest first — what the UI and the phone client poll. */
  pending(): CaptureRequest[];
}

export interface CaptureRegistryOptions {
  now?(): number;
  newId?(): string;
  /**
   * How long a camera has to deliver. The GoPro path budgets stop-at-T+3.5,
   * encode, list-with-backoff and a USB pull at under 30 s end to end
   * (GOPRO_CAPTURE.md), so two minutes is slack, not a deadline — its job is
   * to make sure a camera that silently died stops being waited on.
   */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 120_000;

const defaultNewId = (): string => {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && 'randomUUID' in cryptoApi) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export function createCaptureRegistry(
  opts: CaptureRegistryOptions = {},
): CaptureRegistry {
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? defaultNewId;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const open = new Map<string, CaptureRequest>();

  /** Drop what nobody is coming back for. Called on every touch, so the map
      cannot grow across a long session on the strength of dead cameras. */
  const sweep = (at: number): void => {
    for (const [id, request] of open) {
      if (request.expiresAt <= at) open.delete(id);
    }
  };

  return {
    open(input) {
      const requestedAt = now();
      sweep(requestedAt);
      const request: CaptureRequest = {
        ...input,
        id: newId(),
        requestedAt,
        expiresAt: requestedAt + ttlMs,
      };
      open.set(request.id, request);
      return request;
    },

    claim(id) {
      const at = now();
      sweep(at);
      const request = open.get(id);
      if (!request) return null;
      open.delete(id);
      return request;
    },

    pending() {
      const at = now();
      sweep(at);
      return [...open.values()].sort((a, b) => a.requestedAt - b.requestedAt);
    },
  };
}
