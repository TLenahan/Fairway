import { PassThrough } from 'node:stream';

import { createDataStore, runMigrations } from '@golf/data';
import { openNodeDatabase } from '@golf/data/node';
import { SERVER_INSTRUCTIONS, TOOLS, ToolContext } from '@golf/mcp';
import { Club, DataStore, Environment } from '@golf/types';

import {
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  JsonRpcResponse,
  McpServer,
  createMcpServer,
} from './protocol';
import { serveStdio } from './stdio';

/**
 * MCP conformance for the hand-rolled transport. Since there is no SDK
 * underneath, these specs ARE the protocol guarantee: initialize negotiates,
 * tools/list publishes real JSON Schema, tools/call reaches the real tools
 * over a real SQLite store, notifications get no reply, and a tool failure
 * comes back as a result the model can read rather than an error it cannot.
 */

const ENVIRONMENT: Environment = {
  altitudeM: 0,
  temperatureC: 20,
  presetName: null,
};

let db: ReturnType<typeof openNodeDatabase>;
let data: DataStore;
let club: Club;
let server: McpServer;
let ctx: ToolContext;

beforeAll(async () => {
  db = openNodeDatabase(':memory:');
  await runMigrations(db);
  data = createDataStore(db);
  club = await data.createClub({
    name: '7 iron',
    category: 'iron',
    swingTag: 'full',
    loftDeg: 34,
    notes: null,
    tracerColor: null,
    focusNote: null,
    archived: false,
  });
  await data.createSession({
    name: null,
    notes: null,
    startedAt: 1_750_000_000_000,
    environment: ENVIRONMENT,
    defaultIntent: 'stock',
    focusClubId: club.id,
  });

  ctx = { data };
  server = createMcpServer({
    tools: TOOLS,
    ctx,
    instructions: SERVER_INSTRUCTIONS,
    serverInfo: { name: 'fairway', version: '0.0.1' },
  });
});

afterAll(() => db.close());

const request = (
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params ? { params } : {}),
});

/** Every tool result is JSON in a text block; unwrap it the way a client does. */
function toolPayload(response: JsonRpcResponse | null): {
  isError: boolean;
  parsed: Record<string, unknown>;
  text: string;
} {
  const result = response?.result as {
    isError: boolean;
    content: { type: string; text: string }[];
  };
  const text = result.content[0].text;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // an isError payload is prose, not JSON
  }
  return { isError: result.isError, parsed, text };
}

describe('initialize', () => {
  it('echoes a version it speaks and advertises tools', async () => {
    const response = await server.handle(
      request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'spec', version: '1' },
      }),
    );
    const result = response?.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.capabilities).toMatchObject({ tools: {} });
    expect(result.serverInfo).toEqual({ name: 'fairway', version: '0.0.1' });
    expect(result.instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it('names its own version when the client asks for one it does not speak', async () => {
    const response = await server.handle(
      request(2, 'initialize', { protocolVersion: '1999-01-01' }),
    );
    const result = response?.result as { protocolVersion: string };
    expect(result.protocolVersion).toBe('2025-06-18');
  });

  it('answers ping and returns nothing for the initialized notification', async () => {
    expect((await server.handle(request(3, 'ping')))?.result).toEqual({});
    // A notification has no id, and JSON-RPC forbids responding to one.
    expect(
      await server.handle({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    ).toBeNull();
  });
});

describe('tools/list', () => {
  it('publishes every tool with an inline JSON Schema', async () => {
    const response = await server.handle(request(4, 'tools/list'));
    const { tools } = response?.result as {
      tools: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }[];
    };
    expect(tools).toHaveLength(TOOLS.length);

    const query = tools.find((tool) => tool.name === 'query_shots');
    expect(query).toBeDefined();
    expect(query?.inputSchema.type).toBe('object');

    const properties = query?.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(['club_id', 'intent', 'limit', 'great_only']),
    );
    // $refStrategy: 'none' — clients that do not resolve $ref must still see
    // the whole schema.
    expect(JSON.stringify(query?.inputSchema)).not.toContain('$ref');
  });
});

describe('tools/call', () => {
  it('runs a tool against the real store and returns JSON text', async () => {
    const response = await server.handle(
      request(5, 'tools/call', { name: 'list_clubs', arguments: {} }),
    );
    const { isError, parsed } = toolPayload(response);
    expect(isError).toBe(false);

    const clubs = parsed.clubs as { club_id: string; name: string }[];
    expect(clubs).toHaveLength(1);
    expect(clubs[0]).toMatchObject({ club_id: club.id, name: '7 iron' });
  });

  it('treats missing arguments as an empty object', async () => {
    const response = await server.handle(
      request(6, 'tools/call', { name: 'list_sessions' }),
    );
    const { isError, parsed } = toolPayload(response);
    expect(isError).toBe(false);
    expect(parsed.total_matched).toBe(1);
  });

  it('reports a rejected argument as a readable result, not a protocol error', async () => {
    // The recovery path: the model guessed a filter that does not exist, and
    // it needs to SEE that to fix the call. A JSON-RPC error would be handled
    // by the client and never reach it.
    const response = await server.handle(
      request(7, 'tools/call', {
        name: 'query_shots',
        arguments: { club: '7 iron' },
      }),
    );
    expect(response?.error).toBeUndefined();
    const { isError, text } = toolPayload(response);
    expect(isError).toBe(true);
    expect(text).toContain('query_shots failed');
  });

  it('rejects an unknown tool and a malformed request at the protocol level', async () => {
    const unknown = await server.handle(
      request(8, 'tools/call', { name: 'delete_everything' }),
    );
    expect(unknown?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND);

    const badMethod = await server.handle(request(9, 'resources/list'));
    expect(badMethod?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND);

    const notJsonRpc = await server.handle({ id: 10, method: 'tools/list' });
    expect(notJsonRpc?.error).toBeDefined();
    expect(notJsonRpc?.id).toBe(10);
  });
});

describe('stdio framing', () => {
  it('reassembles frames split across chunks and answers each one', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => {
      lines.push(...chunk.toString().split('\n').filter((l) => l.length > 0));
    });

    const stdio = serveStdio({ server, input, output });

    // One frame arriving in three pieces, then a second frame — exactly what
    // a pipe does with a large request.
    const frame = `${JSON.stringify(request(20, 'tools/list'))}\n`;
    input.write(frame.slice(0, 12));
    input.write(frame.slice(12, 30));
    input.write(frame.slice(30));
    input.write(`${JSON.stringify(request(21, 'ping'))}\n`);
    input.write('   \n'); // blank lines are not requests

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line) as JsonRpcResponse);
    expect(parsed[0].id).toBe(20);
    expect((parsed[0].result as { tools: unknown[] }).tools).toHaveLength(
      TOOLS.length,
    );
    expect(parsed[1].id).toBe(21);

    stdio.stop();
  });

  it('answers unparseable input with a parse error rather than dying', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => lines.push(chunk.toString().trim()));

    const stdio = serveStdio({ server, input, output });
    input.write('{ this is not json }\n');
    await new Promise((resolve) => setImmediate(resolve));

    const response = JSON.parse(lines[0]) as JsonRpcResponse;
    expect(response.id).toBeNull();
    expect(response.error?.code).toBe(JSONRPC_PARSE_ERROR);

    stdio.stop();
  });
});
