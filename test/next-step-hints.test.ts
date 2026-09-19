// Two replies carry a one-line next_step naming the call that should follow: awarding the XP after a
// fight, and the death saves owed by a character dropped to 0 HP outside one.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';
import type { BattleState } from '../src/combat/state.js';

let db: Db;
let stopClicking: () => void;
const realRandom = Math.random;

/** 0.041 pins every d20 to a natural 20, so the goblin dies to one critical greatsword hit. */
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

const stateOf = async (client: Client, campaignId: number): Promise<BattleState> =>
  (await call<{ encounter: BattleState }>(client, 'get_battle_state', { campaign_id: campaignId })).encounter;

async function makeCampaign(client: Client): Promise<number> {
  const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
    name: 'Next Step',
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

/** Reads the enemy id and PC id out of a freshly started fight. */
async function openFight(client: Client, campaignId: number): Promise<{ pcId: number; enemyId: number }> {
  await call(client, 'start_encounter', {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    features: ['road'],
    enemies: [{ creature: 'Goblin Warrior' }],
  });
  const state = await stateOf(client, campaignId);
  return {
    pcId: state.combatants.find((c) => c.kind === 'pc')!.id,
    enemyId: state.combatants.find((c) => c.team === 'enemy')!.id,
  };
}

/** Closes to melee and swings until the lone goblin is down, as the seeded fight always can. */
async function killTheEnemy(client: Client, campaignId: number, pcId: number): Promise<void> {
  for (let step = 0; step < 20; step += 1) {
    const current = await stateOf(client, campaignId);
    if (current.combatants.filter((c) => c.team === 'enemy' && c.alive).length === 0) return;
    if (current.active?.id !== pcId) {
      await call(client, 'advance_turn', { campaign_id: campaignId });
      continue;
    }
    const pc = current.combatants.find((c) => c.id === pcId)!;
    const target = current.combatants.find((c) => c.team === 'enemy' && c.alive)!;
    if ((target.distance_ft ?? 99) > 5) {
      if (pc.movement_left < 5) {
        await call(client, 'advance_turn', { campaign_id: campaignId });
        continue;
      }
      await call(client, 'move_token', { campaign_id: campaignId, combatant_id: pcId, toward: target.id });
      continue;
    }
    await call(client, 'attack', {
      campaign_id: campaignId,
      attacker_id: pcId,
      target_id: target.id,
      action_name: 'Greatsword',
    });
  }
  throw new Error('the goblin would not die');
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

describe('next_step hints', () => {
  it('tells the DM no XP is due when end_encounter defeats nobody', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    await openFight(client, campaignId);

    const ended = await call<{ xp_suggestion: number; state: unknown; next_step: string }>(
      client,
      'end_encounter',
      { campaign_id: campaignId, outcome: 'victory' },
    );

    expect(ended.xp_suggestion).toBe(0);
    expect(ended.state).toBeTruthy();
    expect(ended.next_step).toBe(
      'Nothing was defeated, so no XP is due; checkpoint {op: save} when the scene is done.',
    );

    await client.close();
  });

  it('tells the DM to award the XP after a defeated enemy', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const { pcId } = await openFight(client, campaignId);
    await killTheEnemy(client, campaignId, pcId);

    const ended = await call<{ xp_suggestion: number; next_step: string }>(client, 'end_encounter', {
      campaign_id: campaignId,
      outcome: 'victory',
    });

    expect(ended.xp_suggestion).toBeGreaterThan(0);
    expect(ended.next_step).toBe(
      `Award the ${ended.xp_suggestion} XP with xp {op: award} now; the engine only suggests it. Then checkpoint {op: save}.`,
    );

    await client.close();
  });

  it('names the death saves only at 0 HP, and nothing once the character is dead', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);

    const grazed = await call<{ hp_current: number; hp_max: number; status: string }>(client, 'hp', {
      campaign_id: campaignId,
      op: 'damage',
      amount: 1,
    });
    expect(grazed.hp_current).toBeGreaterThan(0);
    expect(grazed).not.toHaveProperty('next_step');

    const down = await call<{ hp_current: number; status: string; next_step: string }>(client, 'hp', {
      campaign_id: campaignId,
      op: 'damage',
      amount: grazed.hp_max - 1,
    });
    expect(down.hp_current).toBe(0);
    expect(down.status).toBe('active');
    expect(down.next_step).toContain('death_save');

    // Stabilised at 0 HP: no death saves are due, so no hint; a fresh wound at 0 HP would start them again.
    await call(client, 'condition', { campaign_id: campaignId, op: 'stabilize' });
    const stableAtZero = await call<{ hp_current: number; stable: boolean; next_step?: string }>(client, 'hp', {
      campaign_id: campaignId,
      op: 'damage',
      amount: 0,
    });
    expect(stableAtZero.hp_current).toBe(0);
    expect(stableAtZero.stable).toBe(true);
    expect(stableAtZero).not.toHaveProperty('next_step');

    const killed = await call<{ hp_current: number; status: string; death_options: string[]; next_step?: string }>(
      client,
      'hp',
      { campaign_id: campaignId, op: 'damage', amount: grazed.hp_max },
    );
    expect(killed.status).toBe('dead');
    expect(killed.death_options).toBeTruthy();
    expect(killed).not.toHaveProperty('next_step');

    await client.close();
  });
});
