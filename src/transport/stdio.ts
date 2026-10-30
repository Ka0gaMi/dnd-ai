import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Db } from '../db/connection.js';
import { createGameServer } from '../mcp/server.js';

/** stdout is the protocol channel here, so nothing but JSON-RPC may be written to it. */
export async function startStdioServer(db: Db): Promise<void> {
  serveStdio(() => createGameServer(db), {
    onerror: (e) => console.error(new Date().toISOString(), 'stdio MCP error:', e.message),
  });
  console.error(new Date().toISOString(), 'dnd-ai MCP server ready on stdio');
}
