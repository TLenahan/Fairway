import { Readable, Writable } from 'node:stream';

import {
  JSONRPC_PARSE_ERROR,
  McpServer,
  errorResponse,
} from './protocol';

/**
 * The stdio half of the MCP server: newline-delimited JSON in, the same out.
 *
 * STDOUT IS THE PROTOCOL. Nothing but JSON-RPC frames may ever be written to
 * it — one stray `console.log` anywhere in this process corrupts the stream
 * and the client drops the connection. Diagnostics go to stderr, which MCP
 * clients collect as server logs.
 */
export interface StdioOptions {
  server: McpServer;
  input: Readable;
  output: Writable;
  /** diagnostics sink; defaults to stderr, which is where they belong */
  log?(message: string): void;
}

export function serveStdio(options: StdioOptions): { stop(): void } {
  const { server, input, output } = options;
  // console.error, not console.log — see the note above about stdout.
  const log = options.log ?? ((message: string): void => console.error(message));

  // Frames arrive split across chunk boundaries — a 120-shot query_shots
  // response is far larger than one pipe read — so lines are reassembled here
  // rather than assumed to be whole.
  let buffer = '';

  // Responses are written in completion order, but a client correlates by id,
  // so out-of-order completion is legal. What is NOT legal is two writes
  // interleaving mid-frame, which is why every frame is written in one call.
  const send = (payload: unknown): void => {
    output.write(`${JSON.stringify(payload)}\n`);
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      send(errorResponse(null, JSONRPC_PARSE_ERROR, 'invalid JSON'));
      return;
    }

    server
      .handle(message)
      .then((response) => {
        if (response !== null) send(response);
      })
      .catch((err: Error) => {
        // The handler is meant to turn every failure into a response; landing
        // here means a bug rather than a bad request, so it goes to the log
        // where it is visible instead of vanishing.
        log(`[mcp] unhandled: ${err.message}`);
      });
  };

  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line);
      newline = buffer.indexOf('\n');
    }
  };

  input.on('data', onData);

  return {
    stop(): void {
      input.off('data', onData);
    },
  };
}
