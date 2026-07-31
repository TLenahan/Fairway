import { callTool } from './catalog';
import { Fixture, SHOTS_PER_SESSION, TOTAL_SHOTS, seedFixture } from './testing/history-fixture';
import { ToolContext } from './tool';

/**
 * Every tool against a real SQLite store seeded with a real persisted
 * history. What these specs are actually protecting:
 *
 * - the filters bite (a club filter that silently does nothing returns the
 *   whole bag labelled as one club);
 * - the numbers a tool reports are the ENGINE's, not a second derivation
 *   that happens to look similar;
 * - nothing here writes.
 */

let fixture: Fixture;
let ctx: ToolContext;

beforeAll(async () => {
  fixture = await seedFixture();
  ctx = { data: fixture.data };
});

afterAll(() => fixture.close());

/** Narrow a tool result without `any` — every tool returns a JSON object. */
function rows<T>(result: unknown, key: string): T[] {
  const record = result as Record<string, unknown>;
  return record[key] as T[];
}

function field<T>(result: unknown, key: string): T {
  return (result as Record<string, unknown>)[key] as T;
}

describe('list_clubs', () => {
  it('returns the ids other tools take, with each club’s shot count', async () => {
    const result = await callTool(ctx, 'list_clubs');
    const clubs = rows<Record<string, unknown>>(result, 'clubs');
    expect(clubs).toHaveLength(2);

    const iron = clubs.find((c) => c.club_id === fixture.iron.id);
    expect(iron).toMatchObject({
      name: '7 iron',
      category: 'iron',
      loft_deg: 34,
      shot_count: TOTAL_SHOTS,
      archived: false,
    });
    expect(iron?.last_shot_at_ms).toEqual(expect.any(Number));

    const wedge = clubs.find((c) => c.club_id === fixture.wedge.id);
    expect(wedge).toMatchObject({ name: '60 degree', shot_count: 1 });
  });
});

describe('list_sessions', () => {
  it('reports the focus club and per-session counts, newest first', async () => {
    const result = await callTool(ctx, 'list_sessions');
    const sessions = rows<Record<string, unknown>>(result, 'sessions');
    expect(sessions).toHaveLength(5);

    const started = sessions.map((s) => s.started_at_ms as number);
    expect([...started].sort((a, b) => b - a)).toEqual(started);

    // The wedge session is newest, and one session means one club (v10).
    expect(sessions[0]).toMatchObject({
      session_id: fixture.wedgeSessionId,
      focus_club_id: fixture.wedge.id,
      focus_club_name: '60 degree',
      shot_count: 1,
    });
    expect(sessions[1]).toMatchObject({
      focus_club_id: fixture.iron.id,
      shot_count: SHOTS_PER_SESSION,
      warmup_count: 0,
    });
  });

  it('filters by club before applying the limit, not after', async () => {
    // The regression this pins: the wedge session is the newest, so a limit
    // applied first would return zero iron sessions for limit=1.
    const result = await callTool(ctx, 'list_sessions', {
      club_id: fixture.iron.id,
      limit: 1,
    });
    expect(field<number>(result, 'total_matched')).toBe(4);
    const sessions = rows<Record<string, unknown>>(result, 'sessions');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].focus_club_id).toBe(fixture.iron.id);
  });
});

describe('query_shots', () => {
  it('caps the rows but reports how many matched', async () => {
    const result = await callTool(ctx, 'query_shots', {
      club_id: fixture.iron.id,
      limit: 5,
    });
    expect(field<number>(result, 'total_matched')).toBe(TOTAL_SHOTS);
    expect(rows(result, 'shots')).toHaveLength(5);
  });

  it('orders newest-first by default and oldest-first on request', async () => {
    const newest = rows<Record<string, number>>(
      await callTool(ctx, 'query_shots', { club_id: fixture.iron.id, limit: 3 }),
      'shots',
    ).map((s) => s.captured_at_ms);
    expect([...newest].sort((a, b) => b - a)).toEqual(newest);

    const oldest = rows<Record<string, number>>(
      await callTool(ctx, 'query_shots', {
        club_id: fixture.iron.id,
        limit: 3,
        order: 'oldest',
      }),
      'shots',
    ).map((s) => s.captured_at_ms);
    expect([...oldest].sort((a, b) => a - b)).toEqual(oldest);
  });

  it('filters by club, session and time window', async () => {
    const wedge = await callTool(ctx, 'query_shots', {
      club_id: fixture.wedge.id,
    });
    expect(field<number>(wedge, 'total_matched')).toBe(1);

    const oneSession = await callTool(ctx, 'query_shots', {
      session_id: fixture.sessionIds[0],
    });
    expect(field<number>(oneSession, 'total_matched')).toBe(SHOTS_PER_SESSION);

    const all = rows<Record<string, number>>(
      await callTool(ctx, 'query_shots', {
        club_id: fixture.iron.id,
        limit: 500,
        order: 'oldest',
      }),
      'shots',
    );
    const cutoff = all[10].captured_at_ms;
    const since = await callTool(ctx, 'query_shots', {
      club_id: fixture.iron.id,
      since_ms: cutoff,
      limit: 500,
    });
    expect(field<number>(since, 'total_matched')).toBe(TOTAL_SHOTS - 10);
  });

  it('carries the engine’s great-shot verdict, and great_only agrees with it', async () => {
    const all = rows<Record<string, unknown>>(
      await callTool(ctx, 'query_shots', {
        club_id: fixture.iron.id,
        limit: 500,
      }),
      'shots',
    );
    // Every shot in a live bucket gets classified — never left unanswered.
    expect(all.every((s) => typeof s.great === 'boolean')).toBe(true);
    const greatCount = all.filter((s) => s.great === true).length;
    expect(greatCount).toBeGreaterThan(0);
    expect(greatCount).toBeLessThan(TOTAL_SHOTS);

    const greatOnly = await callTool(ctx, 'query_shots', {
      club_id: fixture.iron.id,
      great_only: true,
      limit: 500,
    });
    expect(field<number>(greatOnly, 'total_matched')).toBe(greatCount);

    // A shot that failed on smash carries the disambiguation the engine made,
    // which is the whole point of low_smash_cause existing.
    const lowSmash = all.find((s) => s.low_smash_cause !== null);
    expect(lowSmash).toBeDefined();
    expect(['contact', 'delivery', 'ambiguous']).toContain(
      lowSmash?.low_smash_cause,
    );
  });

  it('reports SI numbers straight off the persisted shot', async () => {
    const shot = rows<Record<string, number>>(
      await callTool(ctx, 'query_shots', {
        club_id: fixture.iron.id,
        limit: 1,
        order: 'oldest',
      }),
      'shots',
    )[0];

    const stored = (await fixture.data.listShots(fixture.sessionIds[0]))[0];
    expect(shot.shot_id).toBe(stored.id);
    expect(shot.ball_speed_ms).toBeCloseTo(stored.measured.ball.speedMs, 6);
    expect(shot.carry_m).toBeCloseTo(stored.flight?.carryM ?? 0, 6);
    expect(shot.club_path_deg).toBeCloseTo(1.1, 6);
    // no wrist unit in this fixture — absent, not zeroed
    expect(shot.wrist).toBeNull();
  });
});

describe('get_bucket_status', () => {
  it('reports the bucket the engine built, filtered by club', async () => {
    const result = await callTool(ctx, 'get_bucket_status', {
      club_id: fixture.iron.id,
    });
    const buckets = rows<Record<string, unknown>>(result, 'buckets');
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      club_id: fixture.iron.id,
      club_name: '7 iron',
      intent: 'stock',
      n_total: TOTAL_SHOTS,
    });
    expect(buckets[0].certification).toEqual(expect.any(String));

    // Both clubs are live buckets; unfiltered must show both.
    const every = await callTool(ctx, 'get_bucket_status');
    expect(field<number>(every, 'total')).toBe(2);
  });
});

describe('get_baseline', () => {
  it('exposes the per-metric reference and dispersion numbers', async () => {
    const result = await callTool(ctx, 'get_baseline', {
      club_id: fixture.iron.id,
      intent: 'stock',
    });
    const baselines = rows<Record<string, unknown>>(result, 'baselines');
    expect(baselines).toHaveLength(1);

    const baseline = baselines[0];
    expect(baseline.club_name).toBe('7 iron');
    expect(baseline.n_total).toBe(TOTAL_SHOTS);

    const reference = baseline.reference as {
      n_great: number;
      per_metric: Record<string, { n: number; median: number; iqr: number }>;
    };
    expect(reference.n_great).toBeGreaterThan(0);
    expect(reference.per_metric.carryM.median).toBeGreaterThan(0);

    const dispersion = baseline.dispersion as {
      n_total: number;
      carry_sigma_m: number;
      per_metric_sigma: Record<string, number>;
    };
    // §6.3's cardinal rule, visible in the numbers: dispersion counts the
    // WHOLE bucket while the reference counts great shots only. If dispersion
    // were ever computed over the filtered set these two would agree.
    expect(dispersion.n_total).toBe(TOTAL_SHOTS);
    expect(dispersion.n_total).toBeGreaterThan(reference.n_great);
    expect(dispersion.carry_sigma_m).toBeGreaterThan(0);
    expect(dispersion.per_metric_sigma.carryM).toBeGreaterThan(0);
  });
});

describe('get_findings', () => {
  it('returns the planted failure, and nothing for a bucket without one', async () => {
    const result = await callTool(ctx, 'get_findings', {
      club_id: fixture.iron.id,
    });
    const findings = rows<Record<string, unknown>>(result, 'findings');
    expect(findings.length).toBeGreaterThan(0);

    const lowSmash = findings.find((f) => f.failure_mode === 'low-smash');
    expect(lowSmash).toMatchObject({
      club_id: fixture.iron.id,
      club_name: '7 iron',
      intent: 'stock',
    });
    // The guardrail is what makes a finding worth reporting: it survived
    // more than one session and cleared the effect-size gate.
    expect(lowSmash?.sessions_seen as number).toBeGreaterThan(1);
    expect(Math.abs(lowSmash?.effect_size as number)).toBeGreaterThan(0);

    // One wedge shot cannot clear any gate — an empty list, not a guess.
    const wedge = await callTool(ctx, 'get_findings', {
      club_id: fixture.wedge.id,
    });
    expect(field<number>(wedge, 'total')).toBe(0);
  });
});

describe('get_training_blocks', () => {
  it('reads blocks without prescribing any', async () => {
    // The read-only property that matters most: the engine has a live finding
    // here, so a tool that ran the prescription loop would leave rows behind.
    const before = await fixture.data.listTrainingBlocks();
    const result = await callTool(ctx, 'get_training_blocks');
    const after = await fixture.data.listTrainingBlocks();

    expect(field<number>(result, 'total')).toBe(before.length);
    expect(after).toHaveLength(before.length);
  });

  it('serializes a persisted block with its drill resolved', async () => {
    const block = await fixture.data.insertTrainingBlock({
      source: 'finding',
      findingKey: `${fixture.iron.id}|stock|low-smash|clubSpeedMs`,
      drillId: 'tempo-ladder',
      drillVersion: 1,
      clubId: fixture.iron.id,
      intent: 'stock',
      tolerance: { metric: 'clubSpeedMs', center: 38.4, halfWidth: 0.9, nGreat: 20 },
      remeasureShots: 30,
      status: 'active',
      startedAt: 1_750_000_000_000,
      resolvedAt: null,
      resolutionNote: null,
    });

    const result = await callTool(ctx, 'get_training_blocks', {
      status: 'active',
    });
    const blocks = rows<Record<string, unknown>>(result, 'blocks');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      id: block.id,
      status: 'active',
      club_id: fixture.iron.id,
      failure_mode: 'low-smash',
      target_metric: 'clubSpeedMs',
      remeasure_shots: 30,
    });
    // the band the block is judged against, carried as issued
    expect(blocks[0].tolerance).toMatchObject({ metric: 'clubSpeedMs' });

    // and the club filter still bites on blocks
    const wedge = await callTool(ctx, 'get_training_blocks', {
      club_id: fixture.wedge.id,
    });
    expect(field<number>(wedge, 'total')).toBe(0);
  });
});

describe('get_recaps', () => {
  it('returns nothing before the coach has run, then the recap it wrote', async () => {
    expect(field<number>(await callTool(ctx, 'get_recaps'), 'total')).toBe(0);

    await fixture.data.saveAnalysis({
      id: 'analysis-1',
      sessionId: fixture.sessionIds[3],
      scope: 'session',
      model: 'claude-opus-5',
      createdAt: 1_750_000_100_000,
      narrative: 'Strike was the story today.',
      inputSummary: null,
      verdict: {
        headline: 'Centre-face contact is the lever',
        issues: [
          {
            area: 'contact',
            severity: 'medium',
            evidence: '30 of 120 below your smash floor',
            why: 'club speed drops on the misses',
          },
        ],
        strengths: [{ area: 'start line', evidence: 'tight corridor' }],
        drills: [
          {
            name: 'tempo-ladder',
            goal: 'stabilise delivery speed',
            howMeasured: 'club speed inside your great-shot band',
          },
        ],
        caveats: ['one club, four sessions'],
      },
    });

    const result = await callTool(ctx, 'get_recaps');
    const recaps = rows<Record<string, unknown>>(result, 'recaps');
    expect(recaps).toHaveLength(1);
    expect(recaps[0]).toMatchObject({
      session_id: fixture.sessionIds[3],
      model: 'claude-opus-5',
      headline: 'Centre-face contact is the lever',
    });

    // The coach names drills by library id; a reader needs the human name.
    const drills = recaps[0].drills as { drill_id: string; drill_name: string }[];
    expect(drills[0].drill_id).toBe('tempo-ladder');
    expect(drills[0].drill_name.length).toBeGreaterThan(0);
  });
});
