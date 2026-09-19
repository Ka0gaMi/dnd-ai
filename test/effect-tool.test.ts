// effect{op: apply|end} replaces apply_effect and end_effect: one tool, one handler per op.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';
import type { BattleState } from '../src/combat/state.js';

let db: Db;
let stopClicking: () => void;
const realRandom = Math.random;

/** 0.041 pins every d20 to a natural 20, so the fight plays out the same way every run. */
const NAT_20 = 0.041;

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

const textOf = (result: CallToolResult): string => (result.content as Array<{ type: string; text: string }>)[0]!.text;

/** A campaign, a lone Fighter and a single goblin on a small road, returning the enemy id. */
async function openFight(client: Client): Promise<{ campaignId: number; enemyId: number }> {
  const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
    name: 'Effect Tool',
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
  await call(client, 'start_encounter', {
    campaign_id,
    seed: 7,
    terrain: 'road',
    size: 'small',
    features: ['road'],
    enemies: [{ creature: 'Goblin Warrior' }],
  });
  const state = await call<{ encounter: BattleState }>(client, 'get_battle_state', { campaign_id });
  return { campaignId: campaign_id, enemyId: state.encounter.combatants.find((c) => c.team === 'enemy')!.id };
}

beforeEach(() => {
  db = openDb(':memory:');
  stopClicking = resolvePendingRollsImmediately(db);
  Math.random = () => NAT_20;
});

afterEach(() => {
  stopClicking();
  Math.random = realRandom;
});

describe('the effect tool', () => {
  it('applies an effect with a turn view, lists it, then ends it by id', async () => {
    const client = await connect();
    const { campaignId, enemyId } = await openFight(client);

    const applied = await client.callTool({
      name: 'effect',
      arguments: {
        op: 'apply',
        campaign_id: campaignId,
        target_id: enemyId,
        name: 'on fire',
        kind: 'damage',
        damage_expr: '1d6',
        damage_type: 'fire',
        tick: 'start',
        ends: 'manual',
      },
    });
    expect(applied.isError).toBeUndefined();
    const structured = applied.structuredContent as {
      effect: { id: number; name: string };
      turn: { touched: Array<{ id: number }> };
    };
    expect(structured.turn.touched.map((t) => t.id)).toContain(enemyId);

    const state = await call<{ encounter: BattleState }>(client, 'get_battle_state', { campaign_id: campaignId });
    const listed = state.encounter.effects.find((e) => e.id === structured.effect.id);
    expect(listed?.name).toBe('on fire');

    const ended = await client.callTool({
      name: 'effect',
      arguments: { op: 'end', campaign_id: campaignId, effect_id: structured.effect.id },
    });
    expect(ended.isError).toBeUndefined();
    const after = await call<{ encounter: BattleState }>(client, 'get_battle_state', { campaign_id: campaignId });
    expect(after.encounter.effects.map((e) => e.id)).not.toContain(structured.effect.id);

    await client.close();
  });

  it('teaches the missing required field for op=apply', async () => {
    const client = await connect();
    const { campaignId, enemyId } = await openFight(client);

    const result = (await client.callTool({
      name: 'effect',
      arguments: {
        op: 'apply',
        campaign_id: campaignId,
        target_id: enemyId,
        kind: 'damage',
        tick: 'start',
        ends: 'manual',
      },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'Missing name for op=apply (requires target_id, name, kind, tick, ends). Re-call with name set.',
    );

    await client.close();
  });

  it('refuses an apply-only field on op=end', async () => {
    const client = await connect();

    const result = (await client.callTool({
      name: 'effect',
      arguments: { op: 'end', campaign_id: 1, effect_id: 1, damage_expr: '1d6' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'damage_expr does not apply to op=end; it takes campaign_id, effect_id. Re-call without it.',
    );

    await client.close();
  });

  it('registers effect and neither of the old tools, with both op lines in the description', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('effect');
    expect(names).not.toContain('apply_effect');
    expect(names).not.toContain('end_effect');

    const description = tools.find((tool) => tool.name === 'effect')!.description ?? '';
    expect(description).toContain('op=apply:');
    expect(description).toContain('op=end:');

    await client.close();
  });
});
