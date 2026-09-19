// The hp family tool: one registration behind op=damage|heal|temp, replacing the three separate tools.
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
    name: 'Hit Points',
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
  stopClicking = resolvePendingRollsImmediately(db);
});

afterEach(() => {
  stopClicking();
});

describe('the hp tool', () => {
  it('advertises hp and none of the three old tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('hp');
    expect(names).not.toContain('apply_damage');
    expect(names).not.toContain('heal');
    expect(names).not.toContain('set_temp_hp');
    await client.close();
  });

  it('names each op in the description', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'hp')!;
    const description = tool.description ?? '';
    expect(description).toContain('op=damage:');
    expect(description).toContain('op=heal:');
    expect(description).toContain('op=temp:');
    await client.close();
  });

  it('refuses hp without an op', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'hp', arguments: { campaign_id: 1, amount: 1 } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('subtracts damage and carries next_step at 0 HP', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);

    const grazed = await call<{ hp_current: number; hp_max: number; status: string; next_step?: string }>(client, 'hp', {
      campaign_id: campaignId,
      op: 'damage',
      amount: 1,
    });
    expect(grazed.hp_current).toBe(grazed.hp_max - 1);
    expect(grazed).not.toHaveProperty('next_step');

    const down = await call<{ hp_current: number; status: string; next_step: string }>(client, 'hp', {
      campaign_id: campaignId,
      op: 'damage',
      amount: grazed.hp_current,
    });
    expect(down.hp_current).toBe(0);
    expect(down.status).toBe('active');
    expect(down.next_step).toContain('death_save');
    await client.close();
  });

  it('restores hit points', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const hurt = await call<{ hp_current: number }>(client, 'hp', { campaign_id: campaignId, op: 'damage', amount: 5 });
    const healed = await call<{ hp_current: number }>(client, 'hp', { campaign_id: campaignId, op: 'heal', amount: 3 });
    expect(healed.hp_current).toBe(hurt.hp_current + 3);
    await client.close();
  });

  it('sets the temporary pool and clears it with 0', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const set = await call<{ temp_hp: number }>(client, 'hp', {
      campaign_id: campaignId,
      op: 'temp',
      amount: 4,
      source: 'Second Wind',
    });
    expect(set.temp_hp).toBe(4);

    const cleared = await call<{ temp_hp: number }>(client, 'hp', { campaign_id: campaignId, op: 'temp', amount: 0 });
    expect(cleared.temp_hp).toBe(0);
    await client.close();
  });

  it('refuses a field that belongs to another op', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const refused = await client.callTool({
      name: 'hp',
      arguments: { campaign_id: campaignId, op: 'heal', amount: 3, critical: true },
    });
    expect(refused.isError).toBe(true);
    expect((refused.content as Array<{ text: string }>)[0]!.text).toBe(
      'critical does not apply to op=heal; it takes campaign_id, amount, character_id. Re-call without it.',
    );
    await client.close();
  });
});
