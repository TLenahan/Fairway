#!/bin/bash
# Launch the Fairway MCP server on stdio — the command an MCP client runs.
#
# Deliberately NOT an nx target: nx writes its own banner to stdout, and for a
# stdio MCP server stdout IS the protocol. Anything but JSON-RPC frames on it
# corrupts the stream and the client drops the connection. This script execs
# node directly so the only thing on stdout is the server.
#
# Claude Desktop / Claude Code config:
#   {
#     "mcpServers": {
#       "fairway": { "command": "/absolute/path/to/tools/fairway-mcp.sh" }
#     }
#   }
#
# Reads ~/.fairway/hub.db read-only (override with FAIRWAY_DATA_DIR). The hub
# does not need to be running, but it must have run at least once to create
# the database. Diagnostics go to stderr, which clients collect as logs.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

exec node \
  -r @swc-node/register \
  -r ./apps/hub/scripts/register-paths.cjs \
  apps/hub/src/mcp/main.ts
