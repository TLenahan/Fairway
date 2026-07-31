import { DataStore } from '@golf/types';

import { SERVER_INSTRUCTIONS, TOOLS, callTool, toolByName } from './catalog';

/**
 * Invariants of the tool surface itself, provable without a store: names are
 * the wire contract, and the argument schemas are the only thing standing
 * between a model's guess and a confidently wrong answer.
 */

// Never reached: every test here fails before a tool touches the store. The
// proxy makes that a hard assertion rather than a hope — a tool that read
// anything at all would fail loudly instead of quietly passing.
const noStore = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`the store was touched: ${String(prop)}`);
    },
  },
) as DataStore;

describe('tool catalog', () => {
  it('publishes uniquely named tools with prose and a schema', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);

    for (const tool of TOOLS) {
      // snake_case: the MCP naming convention every client renders
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.title.length).toBeGreaterThan(0);
      // the description is what a model reads to decide whether to call it;
      // a stub would make the tool undiscoverable in practice
      expect(tool.description.length).toBeGreaterThan(80);
      expect(typeof tool.inputSchema).toBe('object');
    }
  });

  it('resolves by name and refuses one it does not have', async () => {
    expect(toolByName('query_shots')?.name).toBe('query_shots');
    expect(toolByName('drop_everything')).toBeNull();

    // Not an empty result: an unknown tool means a stale tool list, and
    // "no data" is a different — and wrong — answer to that.
    await expect(callTool({ data: noStore }, 'drop_everything')).rejects.toThrow(
      /unknown tool/,
    );
  });

  it('rejects an argument no tool declares, before reading anything', async () => {
    // The failure mode this guards: a model filters on `club` instead of
    // `club_id`, the filter is silently dropped, and the whole bag comes back
    // presented as one club's history.
    await expect(
      callTool({ data: noStore }, 'query_shots', { club: '7 iron' }),
    ).rejects.toThrow();

    await expect(
      callTool({ data: noStore }, 'get_findings', { intent: 'slice' }),
    ).rejects.toThrow();

    await expect(
      callTool({ data: noStore }, 'query_shots', { limit: 0 }),
    ).rejects.toThrow();
  });

  it('states the golfer-relative standard in its instructions', () => {
    // The one thing a model cannot infer from the tool list: these baselines
    // are the golfer's own, not a tour benchmark.
    expect(SERVER_INSTRUCTIONS).toMatch(/read-only/);
    expect(SERVER_INSTRUCTIONS).toMatch(/own/);
  });
});
