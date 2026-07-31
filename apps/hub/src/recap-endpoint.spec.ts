import { createDataStore, runMigrations } from '@golf/data';
import { openNodeDatabase } from '@golf/data/node';
import { AnalysisVerdict, DataStore, Environment } from '@golf/types';

import { createRecapTracker, loadRecaps } from './recap-endpoint';

const ENVIRONMENT: Environment = {
  altitudeM: 1800,
  temperatureC: 22,
  presetName: null,
};

const verdict = (headline: string): AnalysisVerdict => ({
  headline,
  issues: [],
  strengths: [],
  drills: [],
  caveats: [],
});

describe('createRecapTracker', () => {
  it('reports idle until a run begins, then running', () => {
    const tracker = createRecapTracker();
    expect(tracker.snapshot()).toEqual({ status: 'idle', error: null });

    tracker.begin('session-1');
    expect(tracker.snapshot()).toEqual({ status: 'running', error: null });

    tracker.succeed();
    expect(tracker.snapshot()).toEqual({ status: 'idle', error: null });
  });

  it('keeps a failure visible until the next run starts', () => {
    const tracker = createRecapTracker();
    tracker.begin('session-1');
    tracker.fail('coach agent timed out');

    // the whole point of the error state: a failed run must not read as
    // silence, so it survives every read until a new run replaces it
    expect(tracker.snapshot()).toEqual({
      status: 'error',
      error: 'coach agent timed out',
    });
    expect(tracker.snapshot()).toEqual({
      status: 'error',
      error: 'coach agent timed out',
    });

    tracker.begin('session-2');
    expect(tracker.snapshot()).toEqual({ status: 'running', error: null });
  });
});

describe('loadRecaps', () => {
  const openStore = async (): Promise<{
    data: DataStore;
    close(): void;
  }> => {
    const db = openNodeDatabase(':memory:');
    await runMigrations(db);
    return { data: createDataStore(db), close: () => db.close() };
  };

  it('returns the newest recaps first, capped at the limit', async () => {
    const { data, close } = await openStore();
    const started = Date.UTC(2026, 6, 20);

    // one session per day, seeded oldest-first so ordering can only come from
    // the sort and not from insertion order
    for (let day = 0; day < 4; day += 1) {
      const session = await data.createSession({
        name: `day ${day}`,
        notes: null,
        startedAt: started + day * 86_400_000,
        environment: ENVIRONMENT,
      });
      await data.saveAnalysis({
        id: `analysis-${day}`,
        sessionId: session.id,
        scope: 'session',
        model: 'claude-opus-5',
        createdAt: started + day * 86_400_000 + 3_600_000,
        verdict: verdict(`day ${day}`),
        narrative: `narrative ${day}`,
        inputSummary: null,
      });
    }

    const recaps = await loadRecaps(data, 3);
    expect(recaps.map((r) => r.verdict.headline)).toEqual([
      'day 3',
      'day 2',
      'day 1',
    ]);
    expect(recaps[0].session_started_at_ms).toBe(started + 3 * 86_400_000);
    expect(recaps[0].created_at_ms).toBe(started + 3 * 86_400_000 + 3_600_000);
    expect(recaps[0].model).toBe('claude-opus-5');
    expect(recaps[0].narrative).toBe('narrative 3');

    close();
  });

  it('orders multiple recaps for one session by creation time', async () => {
    const { data, close } = await openStore();
    const startedAt = Date.UTC(2026, 6, 24);
    const session = await data.createSession({
      name: null,
      notes: null,
      startedAt,
      environment: ENVIRONMENT,
    });
    const createdAts = [startedAt + 10, startedAt + 30, startedAt + 20];
    for (const [i, createdAt] of createdAts.entries()) {
      await data.saveAnalysis({
        id: `analysis-${i}`,
        sessionId: session.id,
        scope: 'session',
        model: 'claude-opus-5',
        createdAt,
        verdict: verdict(`at ${createdAt - startedAt}`),
        narrative: 'narrative',
        inputSummary: null,
      });
    }

    const recaps = await loadRecaps(data, 5);
    expect(recaps.map((r) => r.verdict.headline)).toEqual([
      'at 30',
      'at 20',
      'at 10',
    ]);
    expect(recaps.every((r) => r.session_id === session.id)).toBe(true);

    close();
  });

  it('is empty when nothing has been recapped', async () => {
    const { data, close } = await openStore();
    await data.createSession({
      name: null,
      notes: null,
      startedAt: Date.now(),
      environment: ENVIRONMENT,
    });

    await expect(loadRecaps(data, 5)).resolves.toEqual([]);

    close();
  });
});
