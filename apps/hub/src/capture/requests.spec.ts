import { createCaptureRegistry } from './requests';

function build(ttlMs = 1_000) {
  let clock = 1_000;
  let id = 0;
  const registry = createCaptureRegistry({
    now: () => clock,
    newId: () => `req-${++id}`,
    ttlMs,
  });
  return {
    registry,
    tick: (ms: number): void => {
      clock += ms;
    },
  };
}

const ask = { shotId: 'shot-1', sessionId: 'sess-1' } as const;

describe('createCaptureRegistry', () => {
  it('stamps a request with the trigger instant and its deadline', () => {
    const { registry } = build();
    const request = registry.open({
      ...ask,
      source: 'gopro',
      view: 'down_the_line',
    });
    expect(request).toEqual({
      id: 'req-1',
      shotId: 'shot-1',
      sessionId: 'sess-1',
      source: 'gopro',
      view: 'down_the_line',
      requestedAt: 1_000,
      expiresAt: 2_000,
    });
    expect(registry.pending()).toEqual([request]);
  });

  it('claims once — a second upload quoting the same id is refused', () => {
    const { registry } = build();
    const request = registry.open({
      ...ask,
      source: 'phone',
      view: 'face_on',
    });

    expect(registry.claim(request.id)).toEqual(request);
    // both files cannot be the clip this request asked for; accepting the
    // second would file it against a swing it is not of
    expect(registry.claim(request.id)).toBeNull();
    expect(registry.pending()).toEqual([]);
  });

  it('refuses an id it never issued', () => {
    const { registry } = build();
    expect(registry.claim('req-nope')).toBeNull();
  });

  it('expires a request the camera never answered', () => {
    const { registry, tick } = build();
    const request = registry.open({
      ...ask,
      source: 'gopro',
      view: 'down_the_line',
    });

    tick(999);
    expect(registry.pending()).toEqual([request]);

    tick(1); // exactly at expiresAt — the window is closed, not closing
    expect(registry.pending()).toEqual([]);
    expect(registry.claim(request.id)).toBeNull();
  });

  it('keeps one request per camera for the same shot, oldest first', () => {
    const { registry, tick } = build();
    // the two-view station: one swing, two asks, two clips
    const dtl = registry.open({
      ...ask,
      source: 'gopro',
      view: 'down_the_line',
    });
    tick(5);
    const faceOn = registry.open({ ...ask, source: 'phone', view: 'face_on' });

    expect(registry.pending()).toEqual([dtl, faceOn]);
    expect(registry.claim(faceOn.id)).toEqual(faceOn);
    expect(registry.pending()).toEqual([dtl]);
  });

  it('does not let dead requests accumulate across a session', () => {
    const { registry, tick } = build();
    for (let i = 0; i < 20; i += 1) {
      registry.open({
        shotId: `shot-${i}`,
        sessionId: 'sess-1',
        source: 'gopro',
        view: 'down_the_line',
      });
      tick(100);
    }
    // 20 asks at 100 ms spacing from t=1000; the clock ends at t=3000 and the
    // TTL is 1 s, so everything opened at or before t=2000 is gone — the nine
    // from t=2100 on are all that is still worth waiting for.
    expect(registry.pending().map((r) => r.requestedAt)).toEqual([
      2_100, 2_200, 2_300, 2_400, 2_500, 2_600, 2_700, 2_800, 2_900,
    ]);
  });
});
