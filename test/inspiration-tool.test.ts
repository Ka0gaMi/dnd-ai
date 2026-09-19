// The inspiration family tool: one registration behind op=grant|spend, replacing the two separate tools.
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

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result.structuredContent as T;
}

async function makeCampaign(client: Client): Promise<number> {
  const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
    name: 'Inspiration',
    story_shape: 'sandbox',
  });
  await call(client, 'create_character', {
    campaign_id,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
  return campaign_id;
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('the inspiration tool', () => {
  it('advertises inspiration and none of the two old tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('inspiration');
    expect(names).not.toContain('grant_inspiration');
    expect(names).not.toContain('spend_inspiration');
    await client.close();
  });

  it('names each op in the description', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'inspiration')!;
    const description = tool.description ?? '';
    expect(description).toContain('op=grant:');
    expect(description).toContain('op=spend:');
    await client.close();
  });

  it('grants and spends Heroic Inspiration, 0 to 1 to 0', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const before = await call<{ character: { inspiration: number } }>(client, 'get_character_sheet', { campaign_id: campaignId });
    expect(before.character.inspiration).toBe(0);

    const granted = await call<{ inspiration: number }>(client, 'inspiration', { campaign_id: campaignId, op: 'grant' });
    expect(granted.inspiration).toBe(1);

    const spent = await call<{ inspiration: number }>(client, 'inspiration', { campaign_id: campaignId, op: 'spend' });
    expect(spent.inspiration).toBe(0);

    const after = await call<{ character: { inspiration: number } }>(client, 'get_character_sheet', { campaign_id: campaignId });
    expect(after.character.inspiration).toBe(0);
    await client.close();
  });

  it('refuses to spend Heroic Inspiration the character does not have', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const result = await client.callTool({
      name: 'inspiration',
      arguments: { campaign_id: campaignId, op: 'spend' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('has no Heroic Inspiration to spend');
    await client.close();
  });
});
