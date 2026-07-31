import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Clip } from '@golf/types';

import { MAX_CLIP_BYTES, parseRange } from './endpoint';
import { CaptureHarness, buildCaptureHarness } from './testing';

const upload = (
  base: string,
  requestId: string,
  body: Buffer,
  extra = '',
): Promise<Response> =>
  fetch(
    `${base}/api/clips?request=${requestId}` +
      `&durationMs=6000&fps=120&width=1920&height=1080${extra}`,
    { method: 'POST', body: new Uint8Array(body) },
  );

describe('capture endpoints', () => {
  let h: CaptureHarness;
  beforeEach(async () => {
    h = await buildCaptureHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('takes a clip against a live request and files it under that shot', async () => {
    const request = h.deps.registry.open({
      shotId: h.shot.id,
      sessionId: h.sessionId,
      source: 'gopro',
      view: 'down_the_line',
    });
    const bytes = Buffer.from('fake-mp4-payload');

    const res = await upload(h.base, request.id, bytes);
    expect(res.status).toBe(201);
    const clip = (await res.json()) as Clip;

    expect(clip.shotId).toBe(h.shot.id);
    expect(clip.source).toBe('gopro');
    expect(clip.view).toBe('down_the_line');
    expect(clip.bytes).toBe(bytes.length);
    // the trigger instant, not the upload's — the swing happened when the hub
    // asked, not when the camera finished encoding
    expect(clip.capturedAt).toBe(request.requestedAt);
    // ingest never claims to have located impact
    expect(clip.sync).toBe('coarse');
    expect(clip.impactOffsetMs).toBeNull();

    // the file is named for the request that produced it
    expect(clip.path).toBe(`${h.sessionId}/${request.id}.mp4`);
    expect(readFileSync(join(h.clipsDir, clip.path))).toEqual(bytes);

    expect(await h.data.listClipsByShot(h.shot.id)).toEqual([clip]);
  });

  it('keeps ingest sync coarse even when the client sends an offset', async () => {
    const request = h.deps.registry.open({
      shotId: h.shot.id,
      sessionId: h.sessionId,
      source: 'phone',
      view: 'face_on',
    });
    const res = await upload(
      h.base,
      request.id,
      Buffer.from('x'),
      '&impactOffsetMs=4180',
    );
    const clip = (await res.json()) as Clip;

    expect(clip.impactOffsetMs).toBe(4_180);
    // the client's offset is derived from when it was told to stop, which is
    // the trigger-time estimate by definition. Only an audio pass earns 'fine'.
    expect(clip.sync).toBe('coarse');
  });

  it('refuses an upload with no live request', async () => {
    const res = await upload(h.base, 'req-nope', Buffer.from('x'));
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({
      error: expect.stringContaining('No open capture request'),
    });
    expect(await h.data.listClips(h.sessionId)).toEqual([]);
  });

  it('refuses a second upload against a request already fulfilled', async () => {
    const request = h.deps.registry.open({
      shotId: h.shot.id,
      sessionId: h.sessionId,
      source: 'phone',
      view: 'face_on',
    });
    expect((await upload(h.base, request.id, Buffer.from('a'))).status).toBe(201);

    const second = await upload(h.base, request.id, Buffer.from('b'));
    expect(second.status).toBe(404);
    // and the first clip's bytes are untouched — a late second file must not
    // overwrite the one that was actually of this swing
    const [clip] = await h.data.listClipsByShot(h.shot.id);
    expect(readFileSync(join(h.clipsDir, clip.path)).toString()).toBe('a');
  });

  it('rejects missing or nonsense metadata before writing anything', async () => {
    const open = () =>
      h.deps.registry.open({
        shotId: h.shot.id,
        sessionId: h.sessionId,
        source: 'phone',
        view: 'face_on',
      });

    const noFps = await fetch(
      `${h.base}/api/clips?request=${open().id}&durationMs=6000&width=1920&height=1080`,
      { method: 'POST', body: 'x' },
    );
    expect(noFps.status).toBe(400);

    const zeroWidth = await fetch(
      `${h.base}/api/clips?request=${open().id}` +
        '&durationMs=6000&fps=120&width=0&height=1080',
      { method: 'POST', body: 'x' },
    );
    expect(zeroWidth.status).toBe(400);

    const empty = await upload(h.base, open().id, Buffer.alloc(0));
    expect(empty.status).toBe(400);

    expect(await h.data.listClips(h.sessionId)).toEqual([]);
  });

  it('lists pending requests so a camera can find its own work', async () => {
    const dtl = h.deps.registry.open({
      shotId: h.shot.id,
      sessionId: h.sessionId,
      source: 'gopro',
      view: 'down_the_line',
    });
    const faceOn = h.deps.registry.open({
      shotId: h.shot.id,
      sessionId: h.sessionId,
      source: 'phone',
      view: 'face_on',
    });

    const res = await fetch(`${h.base}/api/clips/pending`);
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({
      requests: [dtl, faceOn],
    });

    await upload(h.base, dtl.id, Buffer.from('x'));
    const after = await fetch(`${h.base}/api/clips/pending`);
    expect((await after.json()) as { requests: unknown[] }).toEqual({
      requests: [faceOn],
    });
  });

  it('lists clips by shot or by session, and refuses both at once', async () => {
    const request = h.deps.registry.open({
      shotId: h.shot.id,
      sessionId: h.sessionId,
      source: 'phone',
      view: 'face_on',
    });
    await upload(h.base, request.id, Buffer.from('x'));

    const byShot = await fetch(`${h.base}/api/clips?shotId=${h.shot.id}`);
    expect(((await byShot.json()) as { clips: Clip[] }).clips).toHaveLength(1);

    const bySession = await fetch(`${h.base}/api/clips?sessionId=${h.sessionId}`);
    expect(((await bySession.json()) as { clips: Clip[] }).clips).toHaveLength(1);

    expect((await fetch(`${h.base}/api/clips`)).status).toBe(400);
    expect(
      (await fetch(`${h.base}/api/clips?shotId=a&sessionId=b`)).status,
    ).toBe(400);
  });

  it('serves the file whole, and by range so <video> can scrub', async () => {
    const request = h.deps.registry.open({
      shotId: h.shot.id,
      sessionId: h.sessionId,
      source: 'gopro',
      view: 'down_the_line',
    });
    const bytes = Buffer.from('0123456789');
    await upload(h.base, request.id, bytes);
    const [clip] = await h.data.listClipsByShot(h.shot.id);

    const whole = await fetch(`${h.base}/api/clips/${clip.id}/file`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await whole.arrayBuffer()).toString()).toBe('0123456789');

    const part = await fetch(`${h.base}/api/clips/${clip.id}/file`, {
      headers: { range: 'bytes=2-5' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe('2345');

    const past = await fetch(`${h.base}/api/clips/${clip.id}/file`, {
      headers: { range: 'bytes=99-' },
    });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe('bytes */10');
  });

  it('separates "no such clip" from "the bytes are gone"', async () => {
    const request = h.deps.registry.open({
      shotId: h.shot.id,
      sessionId: h.sessionId,
      source: 'phone',
      view: 'face_on',
    });
    await upload(h.base, request.id, Buffer.from('x'));
    const [clip] = await h.data.listClipsByShot(h.shot.id);

    expect((await fetch(`${h.base}/api/clips/nope/file`)).status).toBe(404);

    rmSync(join(h.clipsDir, clip.path));
    // 410, not 404: the clip is real and the row is right, the file is what
    // went missing — a different problem with a different fix
    expect((await fetch(`${h.base}/api/clips/${clip.id}/file`)).status).toBe(410);
  });

  it('refuses to serve a path that climbs out of the clips directory', async () => {
    const secret = join(h.clipsDir, '..', 'anthropic_api_key');
    writeFileSync(secret, 'sk-do-not-serve');
    // a row is only as trustworthy as whatever wrote it; the read side checks
    const clip = await h.data.insertClip({
      shotId: h.shot.id,
      sessionId: h.sessionId,
      source: 'phone',
      view: 'face_on',
      path: '../anthropic_api_key',
      bytes: 15,
      durationMs: 1,
      fps: 120,
      width: 1920,
      height: 1080,
      sync: 'coarse',
      impactOffsetMs: null,
      capturedAt: 1,
    });

    const res = await fetch(`${h.base}/api/clips/${clip.id}/file`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain(
      'escapes the clips directory',
    );
  });

  it('answers anything but GET/POST on /api/clips with 405', async () => {
    const res = await fetch(`${h.base}/api/clips`, { method: 'DELETE' });
    expect(res.status).toBe(405);
  });
});

describe('parseRange', () => {
  it('reads the forms <video> actually sends', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    // an end past the file is clamped, not refused — Safari asks for more
    // than exists on the opening probe
    expect(parseRange('bytes=90-999', 100)).toEqual({ start: 90, end: 99 });
    // suffix form: the last n bytes, which is how the moov atom gets found
    expect(parseRange('bytes=-20', 100)).toEqual({ start: 80, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });

  it('calls a range outside the file unsatisfiable rather than serving it all', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=50-40', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
  });

  it('ignores a header it cannot parse instead of guessing', () => {
    expect(parseRange('bytes=abc', 100)).toBeNull();
    expect(parseRange('items=0-10', 100)).toBeNull();
    expect(parseRange('bytes=-', 100)).toBeNull();
  });
});

describe('MAX_CLIP_BYTES', () => {
  it('clears a 1080p120 Hindsight save by an order of magnitude', () => {
    // GOPRO_CAPTURE.md: a ~9 s 1080p120 clip runs 60–110 MB
    expect(MAX_CLIP_BYTES).toBeGreaterThan(110 * 1024 * 1024);
  });
});
