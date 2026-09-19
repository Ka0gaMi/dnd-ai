// The inventory family tool: one registration behind op=gold|add|remove|equip|list|use|sell,
// replacing the seven separate tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';

const OLD_TOOLS = [
  'adjust_gold',
  'add_item',
  'remove_item',
  'equip_item',
  'list_inventory',
  'use_item',
  'sell_item',
] as const;

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

/** Calls a tool expected to be refused and returns the teaching or engine error text. */
async function fail(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text: string }>)[0]!.text;
}

async function makeCampaign(client: Client): Promise<number> {
  const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
    name: 'Inventory',
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

interface ListedItem {
  name: string;
  qty: number;
  weight_lb: number;
}

beforeEach(() => {
  db = openDb(':memory:');
  stopClicking = resolvePendingRollsImmediately(db);
});

afterEach(() => {
  stopClicking();
});

describe('the inventory tool', () => {
  it('advertises inventory and none of the seven old tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('inventory');
    for (const old of OLD_TOOLS) expect(names).not.toContain(old);
    await client.close();
  });

  it('names each op in the description', async () => {
    const client = await connect();
    const description = (await client.listTools()).tools.find((t) => t.name === 'inventory')!.description ?? '';
    for (const op of ['gold', 'add', 'remove', 'equip', 'list', 'use', 'sell']) {
      expect(description).toContain(`op=${op}:`);
    }
    await client.close();
  });

  it('changes the purse with gold and refuses debt without allow_debt', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);

    const earned = await call<{ gold: number }>(client, 'inventory', {
      campaign_id: campaignId,
      op: 'gold',
      delta: 10,
      reason: 'a reward',
    });
    expect(earned.gold).toBe(28);

    const refused = await fail(client, 'inventory', {
      campaign_id: campaignId,
      op: 'gold',
      delta: -1000,
      reason: 'a ship',
    });
    expect(refused).toContain('cannot pay');
    expect(refused).toContain('allow_debt');

    const owed = await call<{ in_debt: boolean }>(client, 'inventory', {
      campaign_id: campaignId,
      op: 'gold',
      delta: -1000,
      reason: 'a ship',
      allow_debt: true,
    });
    expect(owed.in_debt).toBe(true);
    await client.close();
  });

  it('adds an SRD item and lists it with its weight', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);

    await call(client, 'inventory', { campaign_id: campaignId, op: 'add', name: 'Greataxe' });
    const listed = await call<{ items: ListedItem[] }>(client, 'inventory', {
      campaign_id: campaignId,
      op: 'list',
    });
    const axe = listed.items.find((item) => item.name === 'Greataxe')!;
    expect(axe.weight_lb).toBe(7);
    expect(axe.qty).toBe(1);
    await client.close();
  });

  it('equips a suit of armour and recomputes AC', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);

    const off = await call<{ ac: number }>(client, 'inventory', {
      campaign_id: campaignId,
      op: 'equip',
      name: 'Chain Mail',
      equipped: false,
    });
    expect(off.ac).toBe(10);

    const on = await call<{ ac: number }>(client, 'inventory', {
      campaign_id: campaignId,
      op: 'equip',
      name: 'Chain Mail',
      equipped: true,
    });
    expect(on.ac).toBe(16);
    await client.close();
  });

  it('removes an item from the sheet', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);

    await call(client, 'inventory', { campaign_id: campaignId, op: 'add', name: 'Greataxe' });
    await call(client, 'inventory', { campaign_id: campaignId, op: 'remove', name: 'Greataxe' });
    const listed = await call<{ items: ListedItem[] }>(client, 'inventory', {
      campaign_id: campaignId,
      op: 'list',
    });
    expect(listed.items.find((item) => item.name === 'Greataxe')).toBeUndefined();
    await client.close();
  });

  it('refuses use on an item without charges, pointing at the spell slot op', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);

    const refused = await fail(client, 'inventory', {
      campaign_id: campaignId,
      op: 'use',
      item: 'Chain Mail',
    });
    expect(refused).toContain('spells {op: spend_slot}');
    await client.close();
  });

  it('sells at half the SRD price into the purse', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);

    const sold = await call<{ price_gp: number; paid: string; coins: { sp: number } }>(client, 'inventory', {
      campaign_id: campaignId,
      op: 'sell',
      item: 'Spear',
    });
    expect(sold.price_gp).toBe(2.5);
    expect(sold.paid).toBe('2 gp, 5 sp');
    expect(sold.coins.sp).toBe(5);
    await client.close();
  });

  it('answers add without name with the helper teaching error', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);

    const refused = await fail(client, 'inventory', { campaign_id: campaignId, op: 'add' });
    expect(refused).toBe('Missing name for op=add (requires name). Re-call with name set.');
    await client.close();
  });

  it('refuses a field that belongs to another op', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);

    const refused = await fail(client, 'inventory', { campaign_id: campaignId, op: 'list', qty: 2 });
    expect(refused).toBe('qty does not apply to op=list; it takes campaign_id, character_id. Re-call without it.');
    await client.close();
  });
});
