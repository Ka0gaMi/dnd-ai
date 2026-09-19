// The language family tool: one registration behind op=define|teach, replacing add_language and grant_language.
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
    name: 'Languages',
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

describe('the language tool', () => {
  it('advertises language and none of the two old tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('language');
    expect(names).not.toContain('add_language');
    expect(names).not.toContain('grant_language');
    await client.close();
  });

  it('names each op in the description', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'language')!;
    const description = tool.description ?? '';
    expect(description).toContain('op=define:');
    expect(description).toContain('op=teach:');
    await client.close();
  });

  it('defines a campaign language and lists it among the campaign languages', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const defined = await call<{ name: string; definition: string; languages: string[] }>(client, 'language', {
      campaign_id: campaignId,
      op: 'define',
      name: 'Old Ashfallen',
      speakers: 'the drowned court and its servants',
      script: 'Ash script',
    });
    expect(defined.name).toBe('Old Ashfallen');
    expect(defined.definition).toContain('the drowned court and its servants');
    expect(defined.languages).toContain('Old Ashfallen');
    await client.close();
  });

  it('teaches a character a language and it appears on the sheet', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const taught = await call<{ added: boolean; languages: string[] }>(client, 'language', {
      campaign_id: campaignId,
      op: 'teach',
      name: 'Elvish',
    });
    expect(taught.added).toBe(true);
    expect(taught.languages).toContain('Elvish');

    const sheet = await call<{ character: { proficiencies: { languages: string[] } } }>(client, 'get_character_sheet', {
      campaign_id: campaignId,
    });
    expect(sheet.character.proficiencies.languages).toContain('Elvish');
    await client.close();
  });

  it('teaches a language the world defined in this campaign', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    await call(client, 'language', {
      campaign_id: campaignId,
      op: 'define',
      name: 'Old Ashfallen',
      speakers: 'the drowned court and its servants',
    });
    const taught = await call<{ added: boolean; languages: string[] }>(client, 'language', {
      campaign_id: campaignId,
      op: 'teach',
      name: 'Old Ashfallen',
    });
    expect(taught.added).toBe(true);
    expect(taught.languages).toContain('Old Ashfallen');
    await client.close();
  });

  it('answers define without speakers with the teaching error', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const result = await client.callTool({
      name: 'language',
      arguments: { campaign_id: campaignId, op: 'define', name: 'Old Ashfallen' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe(
      'Missing speakers for op=define (requires speakers). Re-call with speakers set.',
    );
    await client.close();
  });

  it('refuses a field that belongs to another op', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const refused = await client.callTool({
      name: 'language',
      arguments: { campaign_id: campaignId, op: 'teach', name: 'Elvish', script: 'x' },
    });
    expect(refused.isError).toBe(true);
    expect((refused.content as Array<{ text: string }>)[0]!.text).toBe(
      'script does not apply to op=teach; it takes campaign_id, name, character_id. Re-call without it.',
    );
    await client.close();
  });
});
