import {
  AnalysisRecord,
  AnalysisVerdict,
  DataStore,
  SessionSummary,
} from '@golf/types';

import { createAnalysisService } from './analysis-service';
import { createBaselineSet } from './baselines';
import {
  AnalysisAuthError,
  AnalysisOverloadedError,
  AnalysisParseError,
  AnalysisRateLimitError,
  MissingKeyError,
} from './errors';
import { validateApiKey } from './key-validation';
import { buildAnalysisPayload } from './payload';
import { VERDICT_SENTINEL } from './prompts';

const summary: SessionSummary = {
  sessionId: 's1',
  environment: { altitudeM: 1849, temperatureC: null, presetName: 'Home' },
  shotCount: 12,
  clubs: [
    {
      clubId: 'c7',
      clubName: '7 Iron',
      shotCount: 12,
      metrics: {
        ballSpeedMs: {
          n: 12,
          mean: 52,
          median: 52.2,
          sd: 1.1,
          min: 50,
          max: 54,
        },
        faceAngleDeg: { n: 8, mean: 3.2, median: 3, sd: 1.4, min: 1, max: 5.5 },
        carryM: { n: 12, mean: 148, median: 149, sd: 6, min: 132, max: 156 },
      },
      dispersion: {
        centerX: 148,
        centerZ: 7.5,
        ellipseSemiMajorM: 8,
        ellipseSemiMinorM: 4,
        ellipseAngleDeg: 12,
        biasLateralM: 7.5,
        biasDepthM: -1,
        lateralSpreadM: 5,
        depthSpreadM: 6,
      },
      contact: {
        faceCentroidHMm: null,
        faceCentroidVMm: null,
        faceSpreadHMm: null,
        faceSpreadVMm: null,
        smashMean: 1.31,
        smashSd: 0.04,
      },
      pathFaceGapDeg: 4.1,
      carryM: { n: 12, mean: 148, median: 149, sd: 6, min: 132, max: 156 },
      baselineGap: null,
    },
  ],
  gapping: [],
};

const verdict: AnalysisVerdict = {
  headline: 'Open face relative to path is the leak',
  issues: [
    {
      area: 'face control',
      severity: 'high',
      evidence: 'face +3.2°, path-face gap 4.1°',
      why: 'push-fade pattern, 7.5 m right bias',
    },
  ],
  strengths: [{ area: 'speed', evidence: 'ball speed sd 1.1 m/s' }],
  drills: [
    {
      name: 'Gate drill',
      goal: 'square face',
      howMeasured: 'faceAngleDeg mean → 0',
    },
  ],
  caveats: ['face measured on 8/12 shots'],
};

/** Build an SSE Response streaming the given text pieces as text deltas. */
function sseResponse(pieces: string[]): Response {
  const events = pieces
    .map((text) =>
      [
        'event: content_block_delta',
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text },
        })}`,
        '',
        '',
      ].join('\n'),
    )
    .join('');
  const done = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  return new Response(events + done, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface FetchCall {
  body: Record<string, unknown>;
}

function fakeFetch(responses: Response[]): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls.push({
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = responses.shift();
    if (!next) throw new Error('fakeFetch exhausted');
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const buildService = (responses: Response[], withStore = false) => {
  const { fetchImpl, calls } = fakeFetch(responses);
  const saved: AnalysisRecord[] = [];
  // the service only calls saveAnalysis; the partial fake stands in for the
  // full DataStore interface
  const partialStore = {
    saveAnalysis: async (a: AnalysisRecord) => {
      saved.push(a);
    },
  };
  const service = createAnalysisService({
    getApiKey: async () => 'sk-test',
    fetchImpl,
    now: () => 1234,
    newId: () => 'analysis-1',
    ...(withStore
      ? { dataStore: partialStore as unknown as DataStore }
      : {}),
  });
  return { service, calls, saved };
};

describe('analyze()', () => {
  it('streams the narrative, splits at the sentinel, validates the verdict', async () => {
    const { service, calls } = buildService([
      sseResponse([
        'Your face control is the story. ',
        'The 7-iron misses right.\n',
        `${VERDICT_SENTINEL}\n`,
        JSON.stringify(verdict),
      ]),
    ]);
    const deltas: string[] = [];
    const result = await service.analyze(
      'session',
      { current: summary, environment: summary.environment },
      { model: 'claude-sonnet-5', onDelta: (t) => deltas.push(t) },
    );
    expect(result.narrative).toBe(
      'Your face control is the story. The 7-iron misses right.',
    );
    expect(result.verdict).toEqual(verdict);
    // narrative streamed, sentinel/JSON never leaked to onDelta
    expect(deltas.join('')).toBe(result.narrative + '\n');
    // request shape: streaming messages call with computed payload, no raw rows
    expect(calls[0].body['stream']).toBe(true);
    expect(calls[0].body['model']).toBe('claude-sonnet-5');
    const userContent = (calls[0].body['messages'] as { content: string }[])[0]
      .content;
    expect(userContent).toContain('"clubs"');
    expect(userContent).not.toContain('shotGuid'); // aggregates only
  });

  it('splits correctly when the sentinel spans chunk boundaries', async () => {
    const half = Math.floor(VERDICT_SENTINEL.length / 2);
    const { service } = buildService([
      sseResponse([
        'Narrative.',
        VERDICT_SENTINEL.slice(0, half),
        VERDICT_SENTINEL.slice(half),
        JSON.stringify(verdict),
      ]),
    ]);
    const deltas: string[] = [];
    const result = await service.analyze(
      'session',
      { current: summary, environment: summary.environment },
      { model: 'claude-sonnet-5', onDelta: (t) => deltas.push(t) },
    );
    expect(deltas.join('')).toBe('Narrative.');
    expect(result.verdict.headline).toBe(verdict.headline);
  });

  it('repairs malformed verdict JSON exactly once', async () => {
    const { service, calls } = buildService([
      sseResponse(['Narrative.', VERDICT_SENTINEL, '{ not json']),
      jsonResponse(200, {
        content: [{ type: 'text', text: JSON.stringify(verdict) }],
      }),
    ]);
    const result = await service.analyze(
      'session',
      { current: summary, environment: summary.environment },
      { model: 'claude-sonnet-5' },
    );
    expect(result.verdict).toEqual(verdict);
    expect(calls).toHaveLength(2);
    expect(calls[1].body['stream']).toBe(false);
  });

  it('throws AnalysisParseError when the repair also fails', async () => {
    const { service } = buildService([
      sseResponse(['Narrative.', VERDICT_SENTINEL, 'garbage']),
      jsonResponse(200, { content: [{ type: 'text', text: 'still garbage' }] }),
    ]);
    await expect(
      service.analyze(
        'session',
        { current: summary, environment: summary.environment },
        { model: 'claude-sonnet-5' },
      ),
    ).rejects.toBeInstanceOf(AnalysisParseError);
  });

  it('persists an AnalysisRecord when a DataStore is injected', async () => {
    const { service, saved } = buildService(
      [sseResponse(['N.', VERDICT_SENTINEL, JSON.stringify(verdict)])],
      true,
    );
    await service.analyze(
      'session',
      { current: summary, environment: summary.environment },
      { model: 'claude-sonnet-5' },
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      id: 'analysis-1',
      sessionId: 's1',
      scope: 'session',
      model: 'claude-sonnet-5',
      createdAt: 1234,
      narrative: 'N.',
    });
  });

  it('maps HTTP failures to typed errors', async () => {
    const cases: [number, unknown][] = [
      [401, AnalysisAuthError],
      [429, AnalysisRateLimitError],
      [529, AnalysisOverloadedError],
    ];
    for (const [status, errorClass] of cases) {
      const { service } = buildService([
        jsonResponse(status, { error: { message: 'nope' } }),
      ]);
      await expect(
        service.analyze(
          'session',
          { current: summary, environment: summary.environment },
          { model: 'claude-sonnet-5' },
        ),
      ).rejects.toBeInstanceOf(errorClass as never);
    }
  });

  it('throws MissingKeyError without a key', async () => {
    const service = createAnalysisService({ getApiKey: async () => null });
    await expect(
      service.analyze(
        'session',
        { current: summary, environment: summary.environment },
        { model: 'claude-sonnet-5' },
      ),
    ).rejects.toBeInstanceOf(MissingKeyError);
  });
});

describe('payload builder', () => {
  const baselines = createBaselineSet();

  it('includes computed-metric labeling and cited baselines, never raw shots', () => {
    const payload = buildAnalysisPayload(
      'session',
      { current: summary, environment: summary.environment },
      baselines,
    );
    expect(payload.computedMetricKeys).toContain('carryM');
    expect(payload.baselines.length).toBeGreaterThan(0);
    expect(payload.baselines[0].source.citation).toContain('TrackMan');
    expect(JSON.stringify(payload)).not.toContain('shotGuid');
  });

  it('attaches priors only for trend/compare', () => {
    const prior = { ...summary, sessionId: 's0' };
    const trend = buildAnalysisPayload(
      'trend',
      {
        current: summary,
        priorSummaries: [prior],
        environment: summary.environment,
      },
      baselines,
    );
    expect(trend.priorSummaries).toHaveLength(1);

    const session = buildAnalysisPayload(
      'session',
      {
        current: summary,
        priorSummaries: [prior],
        environment: summary.environment,
      },
      baselines,
    );
    expect(session.priorSummaries).toBeUndefined();
  });
});

describe('chat()', () => {
  it('streams a grounded follow-up answer', async () => {
    const { service, calls } = buildService([
      sseResponse(['Because your face is 3.2° open on average.']),
    ]);
    const deltas: string[] = [];
    const answer = await service.chat(
      { summary },
      [{ role: 'user', content: 'why right?' }],
      'Why do I miss right?',
      { model: 'claude-sonnet-5', onDelta: (t) => deltas.push(t) },
    );
    expect(answer).toContain('3.2°');
    expect(deltas.join('')).toBe(answer);
    const system = calls[0].body['system'] as string;
    expect(system).toContain('"sessionId": "s1"');
  });
});

describe('validateApiKey()', () => {
  const respond = (status: number) =>
    (async () => jsonResponse(status, {})) as unknown as typeof fetch;

  it('is false only for 401', async () => {
    expect(await validateApiKey('k', respond(401))).toBe(false);
    expect(await validateApiKey('k', respond(200))).toBe(true);
    expect(await validateApiKey('k', respond(400))).toBe(true);
    expect(await validateApiKey('k', respond(429))).toBe(true);
  });
});
