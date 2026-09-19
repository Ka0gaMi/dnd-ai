import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { registerCodexTools } from '../src/mcp/tools/codex.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'entity-test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerCodexTools(server, db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name: 'entity', arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result.structuredContent as T;
}

const textOf = (result: CallToolResult): string => (result.content as Array<{ text: string }>)[0]!.text;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Entity Test', story_shape: 'sandbox' }).campaign_id;
});

describe('entity tool', () => {
  it('upserts an entity, then merges the next call into the same entry', async () => {
    const client = await connect();
    const first = await call<{ entity: { id: number; status: string }; created: boolean }>(client, {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'npc',
      name: 'Mira Vance',
      summary: 'The innkeeper of Ashfall.',
    });
    expect(first.created).toBe(true);
    expect(first.entity.status).toBe('alive');

    const second = await call<{ entity: { id: number; notes: string }; created: boolean }>(client, {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'npc',
      name: 'mira vance',
      notes: 'Keeps a crossbow under the bar.',
    });
    expect(second.created).toBe(false);
    expect(second.entity.id).toBe(first.entity.id);
    expect(second.entity.notes).toBe('Keeps a crossbow under the bar.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity').get()).toEqual({ n: 1 });
  });

  it('links two entities and get returns the entry with its links', async () => {
    const client = await connect();
    await call(client, { op: 'upsert', campaign_id: campaignId, kind: 'npc', name: 'Mira' });
    await call(client, { op: 'upsert', campaign_id: campaignId, kind: 'faction', name: 'Ash Court' });
    const link = await call<{ created: boolean }>(client, {
      op: 'link',
      campaign_id: campaignId,
      from: 'Mira',
      to: 'Ash Court',
      type: 'member_of',
    });
    expect(link.created).toBe(true);

    const mira = await call<{ name: string; relations: Array<{ as: string; entity: { name: string } }> }>(client, {
      op: 'get',
      campaign_id: campaignId,
      name: 'Mira',
    });
    expect(mira.name).toBe('Mira');
    expect(mira.relations).toEqual([
      expect.objectContaining({ as: 'member_of', entity: expect.objectContaining({ name: 'Ash Court' }) }),
    ]);
  });

  it('sets a voice card that get and get_codex both show', async () => {
    const client = await connect();
    await call(client, { op: 'upsert', campaign_id: campaignId, kind: 'npc', name: 'Mira' });
    const voiced = await call<{ voice: Record<string, string> }>(client, {
      op: 'voice',
      campaign_id: campaignId,
      name: 'Mira',
      speech_pattern: 'Short sentences.',
      catchphrase: 'Coin first.',
    });
    expect(voiced.voice).toEqual({ speech_pattern: 'Short sentences.', catchphrase: 'Coin first.' });

    const got = await call<{ voice: Record<string, string> }>(client, {
      op: 'get',
      campaign_id: campaignId,
      name: 'Mira',
    });
    expect(got.voice.catchphrase).toBe('Coin first.');

    const listed = await client.callTool({ name: 'get_codex', arguments: { campaign_id: campaignId } });
    const entities = (listed.structuredContent as { entities: Array<{ name: string; has_voice: boolean }> }).entities;
    expect(entities.find((e) => e.name === 'Mira')?.has_voice).toBe(true);
  });

  it('teaches the missing required field on upsert', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'entity',
      arguments: { op: 'upsert', campaign_id: campaignId, kind: 'npc' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Missing name for op=upsert (requires kind, name). Re-call with name set.');
  });

  it('refuses a field that belongs to another op', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'entity',
      arguments: { op: 'get', campaign_id: campaignId, voice: {} },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('voice does not apply to op=get; it takes campaign_id, id, name. Re-call without it.');
  });

  it('advertises entity and get_codex only, with the four op lines', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('entity');
    expect(names).toContain('get_codex');
    for (const old of ['upsert_entity', 'link_entities', 'get_entity', 'set_voice_card', 'entity_tree']) {
      expect(names).not.toContain(old);
    }
    const description = tools.find((t) => t.name === 'entity')!.description ?? '';
    expect(description).toContain('op=upsert:');
    expect(description).toContain('op=link:');
    expect(description).toContain('op=get:');
    expect(description).toContain('op=voice:');
    expect(description).toContain("The window shows an entity's tree; op=get returns its links.");
  });
});
