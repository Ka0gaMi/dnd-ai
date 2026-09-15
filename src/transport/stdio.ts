import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Db } from '../db/connection.js';
import { createGameServer } from '../mcp/server.js';

/** stdout is the protocol channel here, so nothing but JSON-RPC may be written to it. */
export async function startStdioServer(db: Db): Promise<void> {
  const server = createGameServer(db);
  await server.connect(new StdioServerTransport());
  console.error(new Date().toISOString(), 'dnd-ai MCP server ready on stdio');
}
