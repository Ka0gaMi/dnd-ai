// The xp family tool: one registration behind op=award|milestone, replacing award_xp and grant_level.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateSettings } from '../src/core/settings.js';
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

const textOf = (result: unknown): string => ((result as CallToolResult).content as Array<{ text: string }>)[0]!.text;

async function makeCampaign(client: Client): Promise<{ campaign_id: number; character_id: number }> {
  const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
    name: 'Experience',
    story_shape: 'sandbox',
  });
  const created = await call<{ character: { id: number } }>(client, 'create_character', {
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
  return { campaign_id, character_id: created.character.id };
}

beforeEach(() => {
  db = openDb(':memory:');
  stopClicking = resolvePendingRollsImmediately(db);
});

afterEach(() => {
  stopClicking();
});

describe('the xp tool', () => {
  it('advertises xp, level_up and grant_feature and neither old tool', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('xp');
    expect(names).toContain('level_up');
    expect(names).toContain('grant_feature');
    expect(names).not.toContain('award_xp');
    expect(names).not.toContain('grant_level');
    await client.close();
  });

  it('names each op in the description', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'xp')!;
    const description = tool.description ?? '';
    expect(description).toContain('op=award:');
    expect(description).toContain('op=milestone:');
    await client.close();
  });

  it('awards XP and reports the level-up when the total reaches level 2', async () => {
    const client = await connect();
    const { campaign_id, character_id } = await makeCampaign(client);
    const awarded = await call<{ xp: number; level: number; level_up_available: boolean }>(client, 'xp', {
      campaign_id,
      character_id,
      op: 'award',
      amount: 300,
    });
    expect(awarded.xp).toBe(300);
    expect(awarded.level).toBe(1);
    expect(awarded.level_up_available).toBe(true);
    await client.close();
  });

  it('refuses milestone in an XP campaign with the engine message', async () => {
    const client = await connect();
    const { campaign_id, character_id } = await makeCampaign(client);
    const refused = await client.callTool({
      name: 'xp',
      arguments: { campaign_id, character_id, op: 'milestone' },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/counts experience points/);
    await client.close();
  });

  it('raises the level with milestone in a milestone campaign', async () => {
    const client = await connect();
    const { campaign_id } = await makeCampaign(client);
    updateSettings(db, campaign_id, { xp_mode: 'milestone' });
    const granted = await call<{
      xp: number;
      level: number;
      level_up_available: boolean;
      level_up_options: { to_level: number };
    }>(client, 'xp', { campaign_id, op: 'milestone' });
    expect(granted.level).toBe(1);
    expect(granted.xp).toBe(300);
    expect(granted.level_up_available).toBe(true);
    expect(granted.level_up_options.to_level).toBe(2);
    await client.close();
  });

  it('teaches the missing amount for op=award', async () => {
    const client = await connect();
    const { campaign_id, character_id } = await makeCampaign(client);
    const missing = await client.callTool({
      name: 'xp',
      arguments: { campaign_id, character_id, op: 'award' },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe('Missing amount for op=award (requires amount). Re-call with amount set.');
    await client.close();
  });
});
