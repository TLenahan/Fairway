import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createDataStore } from '@golf/data';
import { openNodeDatabase } from '@golf/data/node';
import { SERVER_INSTRUCTIONS, TOOLS } from '@golf/mcp';

import { createMcpServer } from './protocol';
import { serveStdio } from './stdio';

/**
 * MCP entry (`yarn nx run hub:mcp`): publishes the practice history as MCP
 * tools over stdio, for Claude Desktop / Claude Code to call.
 *
 * Runs as its OWN process, separate from the hub server, and holds a
 * READ-ONLY connection to the same `~/.fairway/hub.db`. Two consequences
 * worth knowing:
 *
 * - The hub does not have to be running. Questions about last week's session
 *   are answerable from a laptop with no launch monitor in sight.
 * - Both processes can be live at once. SQLite handles a reader alongside a
 *   writer, and the reader here cannot corrupt anything even if it tried —
 *   the driver rejects writes outright.
 *
 * STDOUT IS THE PROTOCOL: every diagnostic in this process goes to stderr.
 */
const SERVER_INFO = { name: 'fairway', version: '0.0.1' };

function main(): void {
  const dataDir = process.env.FAIRWAY_DATA_DIR ?? join(homedir(), '.fairway');
  const dbPath = join(dataDir, 'hub.db');

  // Fail here, loudly, rather than opening an empty database and answering
  // every question with "no shots on record" — which is indistinguishable
  // from a golfer who has not practised.
  if (!existsSync(dbPath)) {
    console.error(
      `[mcp] no hub database at ${dbPath}\n` +
        '[mcp] start the hub once (open FairwayHub.app) to create it, or set ' +
        'FAIRWAY_DATA_DIR to a directory that has one.',
    );
    process.exit(1);
  }

  // Read-only, so migrations cannot run here: the schema is whatever the hub
  // last migrated it to. That is the correct direction of dependency — the
  // writer owns the schema.
  const db = openNodeDatabase(dbPath, { readonly: true });
  const server = createMcpServer({
    tools: TOOLS,
    ctx: { data: createDataStore(db) },
    instructions: SERVER_INSTRUCTIONS,
    serverInfo: SERVER_INFO,
  });

  serveStdio({ server, input: process.stdin, output: process.stdout });

  console.error(`[mcp] serving ${TOOLS.length} tools from ${dbPath} (read-only)`);

  // The client closing the pipe is the shutdown signal for a stdio server.
  process.stdin.on('end', () => {
    db.close();
    process.exit(0);
  });
}

main();
