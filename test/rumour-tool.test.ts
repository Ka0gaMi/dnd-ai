import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import type { Rumour } from '../src/core/story.js';
import { openDb, type Db } from '../src/db/connection.js';
import { registerStoryTools } from '../src/mcp/tools/story.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, {
    name: 'The Ashfall Road',
    story_shape: 'structured',
    premise: 'A road of cinders.',
  }).campaign_id;
});

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'rumour-tool-test', version: '0.0.0' });
  registerStoryTools(server, db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name: 'rumour', arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result.structuredContent as T;
}

const textOf = (result: CallToolResult): string => (result.content as Array<{ text: string }>)[0]!.text;

describe('rumour{op: add} and rumour{op: get}', () => {
  it('stores a rumour with its truth for the DM, and the player snapshot strips an unresolved one', async () => {
    const client = await connect();
    const { rumour } = await call<{ rumour: Rumour }>(client, {
      op: 'add',
      campaign_id: campaignId,
      text: 'The mill is haunted.',
      scope: 'region',
      truth: 'false',
      source_kind: 'tavern',
    });
    expect(rumour).toMatchObject({
      text: 'The mill is haunted.',
      scope: 'region',
      truth: 'false',
      source_kind: 'tavern',
    });

    const handed = await call<{ rumours: Rumour[] }>(client, { op: 'get', campaign_id: campaignId });
    expect(handed.rumours).toHaveLength(1);
    expect(handed.rumours[0]).toMatchObject({ id: rumour.id, truth: 'false' });
    expect(handed.rumours[0]!.heard_at).not.toBeNull();

    const snapshot = campaignSnapshot(db, campaignId, { forPlayer: true }).rumours.find((row) => row.id === rumour.id);
    expect(snapshot).toBeDefined();
    expect(snapshot).not.toHaveProperty('truth');
  });

  it('teaches what op=add is missing when text is absent', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'rumour',
      arguments: { op: 'add', campaign_id: campaignId, scope: 'region' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Missing text for op=add (requires text). Re-call with text set.');
  });

  it('refuses a field another op uses on op=get', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'rumour',
      arguments: { op: 'get', campaign_id: campaignId, text: 'Not this op.' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('text does not apply to op=get; it takes campaign_id, scope, limit. Re-call without it.');
  });
});

describe('the rumour tool surface', () => {
  it('advertises rumour and time, none of the four old names, with a line per op', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('rumour');
    expect(names).toContain('time');
    for (const old of ['add_rumour', 'get_rumours', 'advance_time', 'set_calendar']) {
      expect(names).not.toContain(old);
    }
    const description = tools.find((tool) => tool.name === 'rumour')!.description ?? '';
    expect(description).toContain('op=add:');
    expect(description).toContain('op=get:');
  });
});
