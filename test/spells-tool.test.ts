// The spells family tool: one registration behind op=prepare|learn|grant|spend_slot,
// replacing the four separate tools.
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

async function campaign(client: Client): Promise<number> {
  const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
    name: 'Spells',
    story_shape: 'sandbox',
  });
  return campaign_id;
}

/** A level 1 Wizard: prepares from the book, and the only class that learns a spell into a spellbook. */
async function wizard(client: Client, campaign_id: number): Promise<number> {
  const { character } = await call<{ character: { id: number } }>(client, 'create_character', {
    campaign_id,
    name: 'Zel',
    species: 'Human',
    class: 'Wizard',
    background: 'Sage',
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    ability_bonuses: { int: 2, con: 1 },
    skill_choices: ['arcana', 'history', 'investigation'],
    cantrips: ['Fire Bolt', 'Light', 'Prestidigitation'],
    spells: ['Magic Missile', 'Shield', 'Mage Armor', 'Sleep'],
    spellbook: ['Magic Missile', 'Shield', 'Mage Armor', 'Sleep', 'Grease', 'Thunderwave'],
  });
  return character.id;
}

/** A level 1 Sorcerer: knows its list rather than preparing it, so grant is the op for it. */
async function sorcerer(client: Client, campaign_id: number): Promise<number> {
  const { character } = await call<{ character: { id: number } }>(client, 'create_character', {
    campaign_id,
    name: 'Ryn',
    species: 'Human',
    class: 'Sorcerer',
    background: 'Acolyte',
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 },
    ability_bonuses: { cha: 2, int: 1 },
    skill_choices: ['arcana', 'persuasion', 'insight'],
    cantrips: ['Fire Bolt', 'Light', 'Prestidigitation', 'Shocking Grasp'],
    spells: ['Burning Hands', 'Shield'],
  });
  return character.id;
}

interface Sheet {
  character: {
    spells: { cantrips: string[]; known: string[]; prepared: string[]; spellbook?: string[] };
    spell_slots: Record<string, { max: number; used: number }>;
  };
}

const sheetOf = (client: Client, campaign_id: number, character_id: number): Promise<Sheet> =>
  call<Sheet>(client, 'get_character_sheet', { campaign_id, character_id });

beforeEach(() => {
  db = openDb(':memory:');
  stopClicking = resolvePendingRollsImmediately(db);
});

afterEach(() => {
  stopClicking();
});

describe('the spells tool', () => {
  it('advertises spells and none of the four old tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('spells');
    expect(names).not.toContain('prepare_spells');
    expect(names).not.toContain('learn_spell');
    expect(names).not.toContain('grant_spell');
    expect(names).not.toContain('use_spell_slot');
    await client.close();
  });

  it('names each op in the description', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'spells')!;
    const description = tool.description ?? '';
    expect(description).toContain('op=prepare:');
    expect(description).toContain('op=learn:');
    expect(description).toContain('op=grant:');
    expect(description).toContain('op=spend_slot:');
    await client.close();
  });

  it('prepares the whole list of a preparing caster', async () => {
    const client = await connect();
    const campaignId = await campaign(client);
    const characterId = await wizard(client, campaignId);

    const done = await call<{ prepared: string[]; prepared_count: number }>(client, 'spells', {
      campaign_id: campaignId,
      character_id: characterId,
      op: 'prepare',
      spells: ['Magic Missile', 'Shield', 'Mage Armor', 'Grease'],
    });
    expect(done.prepared_count).toBe(4);
    expect(done.prepared).toContain('Grease');

    const sheet = await sheetOf(client, campaignId, characterId);
    expect(sheet.character.spells.prepared).toContain('Grease');
    expect(sheet.character.spells.prepared).not.toContain('Sleep');
    await client.close();
  });

  it('learns a spell into the spellbook so it can then be prepared', async () => {
    const client = await connect();
    const campaignId = await campaign(client);
    const characterId = await wizard(client, campaignId);

    const learned = await call<{ added: boolean; spellbook: string[] }>(client, 'spells', {
      campaign_id: campaignId,
      character_id: characterId,
      op: 'learn',
      spell: 'Detect Magic',
    });
    expect(learned.added).toBe(true);
    expect(learned.spellbook).toContain('Detect Magic');

    await call(client, 'spells', {
      campaign_id: campaignId,
      character_id: characterId,
      op: 'prepare',
      spells: ['Magic Missile', 'Shield', 'Mage Armor', 'Detect Magic'],
    });
    const sheet = await sheetOf(client, campaignId, characterId);
    expect(sheet.character.spells.prepared).toContain('Detect Magic');
    await client.close();
  });

  it('grants a spell as a ruling and shows it on the sheet', async () => {
    const client = await connect();
    const campaignId = await campaign(client);
    const characterId = await sorcerer(client, campaignId);

    const granted = await call<{ added: boolean; where: string; spells: { known: string[]; prepared: string[] } }>(
      client,
      'spells',
      {
        campaign_id: campaignId,
        character_id: characterId,
        op: 'grant',
        spell: 'Magic Missile',
        reason: 'a boon from the patron',
      },
    );
    expect(granted.added).toBe(true);
    expect(granted.where).toBe('prepared');
    expect(granted.spells.known).toContain('Magic Missile');

    const sheet = await sheetOf(client, campaignId, characterId);
    expect(sheet.character.spells.known).toContain('Magic Missile');
    expect(sheet.character.spells.prepared).toContain('Magic Missile');

    const logged = db
      .prepare("SELECT text FROM event WHERE campaign_id = ? AND kind = 'feature' AND text LIKE '%ruling%'")
      .all(campaignId) as Array<{ text: string }>;
    expect(logged.some((row) => row.text.includes('a boon from the patron'))).toBe(true);
    await client.close();
  });

  it('spends a spell slot outside a fight and reduces the count', async () => {
    const client = await connect();
    const campaignId = await campaign(client);
    const characterId = await wizard(client, campaignId);

    const spent = await call<{ level: number; remaining: number }>(client, 'spells', {
      campaign_id: campaignId,
      character_id: characterId,
      op: 'spend_slot',
      level: 1,
      spell: 'Magic Missile',
    });
    expect(spent.level).toBe(1);
    expect(spent.remaining).toBe(1);

    const sheet = await sheetOf(client, campaignId, characterId);
    expect(sheet.character.spell_slots['1']!.used).toBe(1);
    await client.close();
  });

  it('teaches the missing level when spend_slot is called without one', async () => {
    const client = await connect();
    const campaignId = await campaign(client);
    await wizard(client, campaignId);

    const refused = await client.callTool({
      name: 'spells',
      arguments: { campaign_id: campaignId, op: 'spend_slot', spell: 'Magic Missile' },
    });
    expect(refused.isError).toBe(true);
    const message = (refused.content as Array<{ text: string }>)[0]!.text;
    expect(message).toContain('Missing level for op=spend_slot');
    expect(message).toMatch(/Re-call with level set/);
    await client.close();
  });
});
