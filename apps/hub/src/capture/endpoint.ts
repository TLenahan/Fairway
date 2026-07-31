import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';

import { Clip, DataStore } from '@golf/types';

import { CaptureRegistry } from './requests';
import { ClipStore } from './clip-store';

/**
 * The capture endpoints: cameras push clips in, the UI reads them back.
 *
 *   GET  /api/clips/pending                → what the hub is waiting for
 *   POST /api/clips?request=<id>&durationMs=&fps=&width=&height=[&impactOffsetMs=]
 *   GET  /api/clips?shotId=<id> | ?sessionId=<id>
 *   GET  /api/clips/<id>/file
 *
 * A camera's whole loop is the first two: poll for asks addressed to it, send
 * bytes back quoting the id. Polling rather than pushing because the hub does
 * not know what cameras exist or how to reach them — a phone on the range
 * moves between networks, and the GoPro is driven by a client inside this same
 * process. Both can ask; neither can reliably be told.
 */

export interface CaptureEndpointDeps {
  data: DataStore;
  clips: ClipStore;
  registry: CaptureRegistry;
}

/**
 * A ~9 s 1080p120 clip runs 60–110 MB (GOPRO_CAPTURE.md). The cap is an order
 * of magnitude clear of that: it exists to stop a stuck or lying client from
 * filling the disk, not to police clip length.
 */
export const MAX_CLIP_BYTES = 256 * 1024 * 1024;

/** Uploaded bytes exceeded MAX_CLIP_BYTES. */
export class ClipTooLargeError extends Error {
  constructor() {
    super(`Clip exceeds ${MAX_CLIP_BYTES} bytes`);
    this.name = 'ClipTooLargeError';
  }
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res
    .writeHead(status, { 'content-type': 'application/json' })
    .end(JSON.stringify(body));
};

/**
 * Read the whole body, refusing anything over the cap as it arrives rather
 * than after — a client that ignores the limit should not get to spend the
 * disk first.
 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_CLIP_BYTES) throw new ClipTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** A required positive number off the query string. */
function requireNumber(params: URLSearchParams, key: string): number {
  const raw = params.get(key);
  if (raw === null) throw new Error(`Missing ${key}`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${key}: ${raw}`);
  }
  return value;
}

async function handleUpload(
  deps: CaptureEndpointDeps,
  req: IncomingMessage,
  res: ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  const requestId = params.get('request');
  if (!requestId) {
    json(res, 400, { error: 'Missing request id' });
    return;
  }

  // Claimed BEFORE the body is read: the claim is what says this upload is
  // wanted, and a request that is unknown, expired or already redeemed should
  // not get to spend a hundred megabytes of socket first.
  const request = deps.registry.claim(requestId);
  if (!request) {
    json(res, 404, {
      error: `No open capture request ${requestId} — unknown, expired or already fulfilled`,
    });
    return;
  }

  let meta: {
    durationMs: number;
    fps: number;
    width: number;
    height: number;
    impactOffsetMs: number | null;
  };
  try {
    const impactRaw = params.get('impactOffsetMs');
    const impactOffsetMs = impactRaw === null ? null : Number(impactRaw);
    if (impactOffsetMs !== null && !Number.isFinite(impactOffsetMs)) {
      throw new Error(`Invalid impactOffsetMs: ${impactRaw}`);
    }
    meta = {
      durationMs: requireNumber(params, 'durationMs'),
      fps: requireNumber(params, 'fps'),
      width: requireNumber(params, 'width'),
      height: requireNumber(params, 'height'),
      impactOffsetMs,
    };
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  let bytes: Buffer;
  try {
    bytes = await readBody(req);
  } catch (err) {
    const tooLarge = err instanceof ClipTooLargeError;
    json(res, tooLarge ? 413 : 400, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (bytes.length === 0) {
    json(res, 400, { error: 'Empty clip body' });
    return;
  }

  const path = await deps.clips.write(request, bytes);
  const clip = await deps.data.insertClip({
    shotId: request.shotId,
    sessionId: request.sessionId,
    source: request.source,
    view: request.view,
    path,
    bytes: bytes.length,
    durationMs: meta.durationMs,
    fps: meta.fps,
    width: meta.width,
    height: meta.height,
    // Ingest never claims 'fine'. Whatever offset the client sends is derived
    // from when it was told to stop, which is the trigger-time estimate by
    // definition — locating impact in the audio is a later pass, and it is
    // that pass alone that may call the sync fine (see setClipImpactOffset).
    sync: 'coarse',
    impactOffsetMs: meta.impactOffsetMs,
    capturedAt: request.requestedAt,
  });

  json(res, 201, clip);
}

async function handleList(
  deps: CaptureEndpointDeps,
  res: ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  const shotId = params.get('shotId');
  const sessionId = params.get('sessionId');
  if (shotId && sessionId) {
    json(res, 400, { error: 'Pass shotId or sessionId, not both' });
    return;
  }
  let clips: Clip[];
  if (shotId) clips = await deps.data.listClipsByShot(shotId);
  else if (sessionId) clips = await deps.data.listClips(sessionId);
  else {
    json(res, 400, { error: 'Pass shotId or sessionId' });
    return;
  }
  json(res, 200, { clips });
}

/**
 * Byte range off a `Range` header, or null for "whole file". Returns
 * 'unsatisfiable' when the header names a range outside the file, which is a
 * 416 rather than a silent full-file response.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  // suffix form (`bytes=-500`): the LAST n bytes
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

async function handleFile(
  deps: CaptureEndpointDeps,
  req: IncomingMessage,
  res: ServerResponse,
  clipId: string,
): Promise<void> {
  const clip = await deps.data.getClip(clipId);
  if (!clip) {
    json(res, 404, { error: `No clip ${clipId}` });
    return;
  }
  const absolute = deps.clips.resolve(clip.path);
  let size: number;
  try {
    size = (await stat(absolute)).size;
  } catch {
    // The row outlived its bytes. Say so plainly — a 404 here would read as
    // "no such clip", which is a different problem with a different fix.
    json(res, 410, { error: `Clip ${clipId} has no file at ${clip.path}` });
    return;
  }

  // Range support is not optional here: <video> needs 206 to scrub, and
  // scrubbing to impact is the entire point of looking at a swing clip.
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res
      .writeHead(416, { 'content-range': `bytes */${size}` })
      .end();
    return;
  }
  const headers: Record<string, string> = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
  };
  // Once the head is written there is no status code left to send, so a read
  // that fails mid-stream (the file deleted between stat and read) can only be
  // reported by killing the socket. Silence would hang the player instead.
  const send = (stream: ReturnType<typeof createReadStream>): void => {
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };
  if (!range) {
    res.writeHead(200, { ...headers, 'content-length': String(size) });
    send(createReadStream(absolute));
    return;
  }
  res.writeHead(206, {
    ...headers,
    'content-length': String(range.end - range.start + 1),
    'content-range': `bytes ${range.start}-${range.end}/${size}`,
  });
  send(createReadStream(absolute, { start: range.start, end: range.end }));
}

/**
 * Route a request at the capture endpoints. Returns false when the path is not
 * one of ours, so the caller falls through to the rest of the server.
 */
export async function handleCaptureRequest(
  deps: CaptureEndpointDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === '/api/clips/pending' && req.method === 'GET') {
    // Every live ask, not just this camera's: a camera filters by the source
    // and view it is. Filtering here would mean the hub deciding which device
    // is "the" phone, which it has no way to know and no reason to guess.
    json(res, 200, { requests: deps.registry.pending() });
    return true;
  }
  const fileMatch = /^\/api\/clips\/([^/]+)\/file$/.exec(url.pathname);
  if (fileMatch && req.method === 'GET') {
    await handleFile(deps, req, res, decodeURIComponent(fileMatch[1]));
    return true;
  }
  if (url.pathname !== '/api/clips') return false;
  if (req.method === 'POST') {
    await handleUpload(deps, req, res, url.searchParams);
    return true;
  }
  if (req.method === 'GET') {
    await handleList(deps, res, url.searchParams);
    return true;
  }
  json(res, 405, { error: `${req.method ?? 'unknown'} not allowed on /api/clips` });
  return true;
}
