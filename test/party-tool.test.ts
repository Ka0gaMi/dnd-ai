// The party family tool: one registration behind op=add|retire|promote, replacing the four separate tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let stopClicking: () => void;

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
    name: 'The Party',
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

type PartyLine = { name: string; role: string; class: string | null; creature: string | null };
type AddResult = { companion: { id: number; name: string }; party: { companions: PartyLine[] } };
type RetireResult = { name: string; party: { companions: PartyLine[] } };
type PromoteResult = { character: { id: number; name: string; role: string }; previous_pc: string | null };

beforeEach(() => {
  db = openDb(':memory:');
  stopClicking = resolvePendingRollsImmediately(db);
});

afterEach(() => {
  stopClicking();
});

describe('the party tool', () => {
  it('advertises party and none of the four old tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('party');
    expect(names).not.toContain('create_companion');
    expect(names).not.toContain('list_party');
    expect(names).not.toContain('retire_companion');
    expect(names).not.toContain('promote_companion');
    await client.close();
  });

  it('names each op in the description', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'party')!;
    const description = tool.description ?? '';
    expect(description).toContain('op=add:');
    expect(description).toContain('op=retire:');
    expect(description).toContain('op=promote:');
    await client.close();
  });

  it('adds a class companion and returns the whole party', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const created = await call<AddResult>(client, 'party', {
      campaign_id: campaignId,
      op: 'add',
      name: 'Sella',
      source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
    });
    expect(created.companion.name).toBe('Sella');
    expect(created.party.companions.map((c) => c.name)).toEqual(['Sella']);
    expect(created.party.companions[0]!.role).toBe('companion');
    await client.close();
  });

  it('adds a stat block companion and returns the whole party', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const created = await call<AddResult>(client, 'party', {
      campaign_id: campaignId,
      op: 'add',
      name: 'Rook',
      source: { creature: 'Wolf' },
    });
    expect(created.companion.name).toBe('Rook');
    expect(created.party.companions[0]).toMatchObject({ name: 'Rook', role: 'companion', class: null, creature: 'Wolf' });
    await client.close();
  });

  it('retires a companion and drops it from the party', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const created = await call<AddResult>(client, 'party', {
      campaign_id: campaignId,
      op: 'add',
      name: 'Rook',
      source: { creature: 'Wolf' },
    });
    const retired = await call<RetireResult>(client, 'party', {
      campaign_id: campaignId,
      op: 'retire',
      character_id: created.companion.id,
    });
    expect(retired.name).toBe('Rook');
    expect(retired.party.companions).toEqual([]);
    await client.close();
  });

  it('promotes a companion after the player character dies', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const created = await call<AddResult>(client, 'party', {
      campaign_id: campaignId,
      op: 'add',
      name: 'Rook',
      source: { creature: 'Wolf' },
    });
    await call(client, 'hp', { campaign_id: campaignId, op: 'damage', amount: 40, source: 'ogre' });
    const promoted = await call<PromoteResult>(client, 'party', {
      campaign_id: campaignId,
      op: 'promote',
      character_id: created.companion.id,
    });
    expect(promoted.previous_pc).toBe('Borg');
    expect(promoted.character).toMatchObject({ name: 'Rook', role: 'pc' });
    const sheet = await call<{ character: { name: string; role: string } }>(client, 'get_character_sheet', {
      campaign_id: campaignId,
    });
    expect(sheet.character.name).toBe('Rook');
    await client.close();
  });

  it('answers add without source with the teaching error', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const result = await client.callTool({
      name: 'party',
      arguments: { campaign_id: campaignId, op: 'add', name: 'Sella' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe(
      'Missing source for op=add (requires name, source). Re-call with source set.',
    );
    await client.close();
  });

  it('refuses a field that belongs to another op', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const refused = await client.callTool({
      name: 'party',
      arguments: { campaign_id: campaignId, op: 'retire', character_id: 1, name: 'x' },
    });
    expect(refused.isError).toBe(true);
    expect((refused.content as Array<{ text: string }>)[0]!.text).toBe(
      'name does not apply to op=retire; it takes campaign_id, character_id. Re-call without it.',
    );
    await client.close();
  });
});
