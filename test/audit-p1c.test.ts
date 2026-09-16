import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';

let db: Db;

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

interface JsonSchema {
  properties?: Record<string, JsonSchema>;
  enum?: unknown[];
}

/** The JSON Schema the running server publishes for one named tool. */
async function toolSchema(client: Client, name: string): Promise<JsonSchema> {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === name);
  expect(tool).toBeDefined();
  return tool!.inputSchema as JsonSchema;
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('audit-p1c DM surface cleanup', () => {
  it('offers every remaining effect duration and no longer offers "rest"', async () => {
    const client = await connect();
    const durations = ['rounds', 'save', 'concentration', 'manual'];

    const applied = await toolSchema(client, 'apply_effect');
    expect(applied.properties!.ends!.enum).toEqual(durations);

    const cast = await toolSchema(client, 'use_action');
    expect(cast.properties!.effect!.properties!.ends!.enum).toEqual(durations);

    await client.close();
  });

  it('does not name Stunned among the speed 0 conditions', async () => {
    const client = await connect();
    for (const name of ['move_token', 'set_combat_condition']) {
      const { tools } = await client.listTools();
      const description = tools.find((t) => t.name === name)!.description ?? '';
      const speedZero = [
        description.match(/([A-Z][a-z]+(?:, [A-Z][a-z]+)*(?: and [A-Z][a-z]+)) all mean speed 0/)?.[1],
        description.match(/speed 0 for ([A-Z][a-z]+(?:, [A-Z][a-z]+)* and [A-Z][a-z]+)/)?.[1],
      ]
        .filter((list) => list !== undefined)
        .join(' ');
      expect(speedZero).not.toBe('');
      expect(speedZero).not.toContain('Stunned');
    }
    await client.close();
  });
});
