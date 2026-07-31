import { FairwayTool, ToolContext } from '@golf/mcp';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * The MCP wire protocol for the hub's tool server: JSON-RPC 2.0 over
 * newline-delimited JSON.
 *
 * WHY THIS IS HAND-ROLLED. `@modelcontextprotocol/sdk` is ESM-only, and the
 * hub is CJS end to end (swc-node + tsconfig-paths); a dynamic import of it
 * is rewritten to `require` and fails at runtime. A tools-only server needs
 * exactly four methods, so framing them here costs less than an ESM seam
 * through the whole app would — the same trade `@golf/analysis` already made
 * with its hand-rolled SSE client. If this server ever needs resources,
 * prompts, sampling or a non-stdio transport, that calculus flips and the
 * right move is to make the hub dual-format rather than to grow this file.
 *
 * This module is pure: messages in, messages out. Nothing here reads stdin,
 * writes stdout, or touches a clock — stdio.ts owns all of that, which is
 * what lets the conformance spec drive the real server without a pipe.
 */

/** Newest first. The first entry is what an unknown-version client is told. */
const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

/* ── JSON-RPC framing ─────────────────────────────────────────────────────── */

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/** id is absent on notifications, and a notification gets no response. */
const RequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type JsonRpcRequest = z.infer<typeof RequestSchema>;

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/* ── the server ───────────────────────────────────────────────────────────── */

export interface McpServerConfig {
  tools: readonly FairwayTool[];
  ctx: ToolContext;
  /** server-level guidance, surfaced to the model at initialize */
  instructions: string;
  serverInfo: { name: string; version: string };
}

export interface McpServer {
  /** null = the message was a notification and takes no response */
  handle(message: unknown): Promise<JsonRpcResponse | null>;
}

export function createMcpServer(config: McpServerConfig): McpServer {
  // Converted once at construction: the schemas are static, and a client may
  // call tools/list repeatedly.
  const listing = config.tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: zodToJsonSchema(z.object(tool.inputSchema).strict(), {
      // MCP clients read the schema inline; $ref/definitions indirection is
      // legal JSON Schema but not every client resolves it.
      $refStrategy: 'none',
      target: 'jsonSchema7',
    }),
  }));

  const byName = new Map(config.tools.map((tool) => [tool.name, tool]));

  const callTool = async (
    id: JsonRpcId,
    params: Record<string, unknown> | undefined,
  ): Promise<JsonRpcResponse> => {
    const name = params?.name;
    if (typeof name !== 'string') {
      return errorResponse(id, JSONRPC_INVALID_PARAMS, 'tools/call needs a name');
    }
    const tool = byName.get(name);
    if (!tool) {
      return errorResponse(id, JSONRPC_METHOD_NOT_FOUND, `unknown tool: ${name}`);
    }

    const args = params?.arguments;
    const argsRecord =
      args !== null && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};

    try {
      const result = await tool.run(config.ctx, argsRecord);
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: false,
      });
    } catch (err) {
      // A tool failure is a RESULT, not a protocol error. The distinction is
      // load-bearing: a JSON-RPC error is the client's problem to handle and
      // the model never sees it, while `isError` puts the message in front of
      // the model, which can then fix its arguments and try again. Rejected
      // arguments — the common case, since the schemas are strict — are
      // exactly the failure a model can recover from on its own.
      const message = err instanceof Error ? err.message : String(err);
      return ok(id, {
        content: [{ type: 'text', text: `tool ${name} failed: ${message}` }],
        isError: true,
      });
    }
  };

  return {
    async handle(message: unknown): Promise<JsonRpcResponse | null> {
      const parsed = RequestSchema.safeParse(message);
      if (!parsed.success) {
        // No usable id means nothing to correlate a response to, so the id is
        // null per JSON-RPC — the client learns the shape was wrong.
        const id =
          message !== null && typeof message === 'object' && 'id' in message
            ? ((message as { id?: JsonRpcId }).id ?? null)
            : null;
        return errorResponse(id, JSONRPC_INVALID_REQUEST, 'not a JSON-RPC request');
      }

      const { id, method, params } = parsed.data;
      const isNotification = id === undefined;
      const responseId: JsonRpcId = id ?? null;

      switch (method) {
        case 'initialize': {
          // Echo the client's version when it is one we speak, otherwise name
          // ours and let the client decide whether it can proceed.
          const requested = params?.protocolVersion;
          const agreed =
            typeof requested === 'string' &&
            (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
              ? requested
              : SUPPORTED_PROTOCOL_VERSIONS[0];
          return ok(responseId, {
            protocolVersion: agreed,
            capabilities: { tools: { listChanged: false } },
            serverInfo: config.serverInfo,
            instructions: config.instructions,
          });
        }

        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;

        case 'ping':
          return ok(responseId, {});

        case 'tools/list':
          return ok(responseId, { tools: listing });

        case 'tools/call':
          return callTool(responseId, params);

        default:
          // A notification for a method we do not implement is silently
          // dropped: JSON-RPC forbids responding to one at all, and an
          // unsolicited error frame would desynchronize the client.
          if (isNotification) return null;
          return errorResponse(
            responseId,
            JSONRPC_METHOD_NOT_FOUND,
            `unknown method: ${method}`,
          );
      }
    },
  };
}
