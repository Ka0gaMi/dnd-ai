// The condition family tool: one registration behind op=set|death_save|stabilize|exhaustion, replacing
// set_condition, set_combat_condition, death_save, stabilize and set_exhaustion.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import type { BattleState } from '../src/combat/state.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let stopClicking: () => void;
const realRandom = Math.random;

/** Pins every d20 to a natural 20, so rolls and the fight play out the same way every run. */
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

async function makeCampaign(client: Client): Promise<number> {
  const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
    name: 'Conditions',
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

/** Opens a fight and returns an enemy combatant to hang conditions on. */
async function openFight(client: Client): Promise<{ campaignId: number; targetId: number }> {
  const campaignId = await makeCampaign(client);
  await call(client, 'start_encounter', {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    features: ['road'],
    enemies: [{ creature: 'Goblin Warrior' }],
  });
  const { encounter } = await call<{ encounter: BattleState }>(client, 'get_battle_state', { campaign_id: campaignId });
  const target = encounter.combatants.find((c) => c.team === 'enemy' && c.alive)!;
  return { campaignId, targetId: target.id };
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

describe('the condition tool', () => {
  it('advertises condition and none of the five old tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('condition');
    for (const old of ['set_condition', 'set_combat_condition', 'death_save', 'stabilize', 'set_exhaustion']) {
      expect(names).not.toContain(old);
    }
    await client.close();
  });

  it('names each op in the description', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'condition')!;
    const description = tool.description ?? '';
    expect(description).toContain('op=set:');
    expect(description).toContain('op=death_save:');
    expect(description).toContain('op=stabilize:');
    expect(description).toContain('op=exhaustion:');
    await client.close();
  });

  it('adds and removes a condition on the sheet with the character path', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);

    const added = await call<{ name: string; conditions: string[] }>(client, 'condition', {
      campaign_id: campaignId,
      op: 'set',
      condition: 'prone',
      active: true,
    });
    expect(added.conditions).toContain('prone');
    const sheet = await call<{ character: { conditions: string[] } }>(client, 'get_character_sheet', {
      campaign_id: campaignId,
    });
    expect(sheet.character.conditions).toContain('prone');

    const removed = await call<{ conditions: string[] }>(client, 'condition', {
      campaign_id: campaignId,
      op: 'set',
      condition: 'prone',
      active: false,
    });
    expect(removed.conditions).not.toContain('prone');
    const sheetAfter = await call<{ character: { conditions: string[] } }>(client, 'get_character_sheet', {
      campaign_id: campaignId,
    });
    expect(sheetAfter.character.conditions).not.toContain('prone');
    await client.close();
  });

  it('sets a condition on a combatant and answers with the turn view', async () => {
    const client = await connect();
    const { campaignId, targetId } = await openFight(client);

    const result = await client.callTool({
      name: 'condition',
      arguments: { campaign_id: campaignId, op: 'set', combatant_id: targetId, condition: 'prone', active: true },
    });
    expect(result.isError).toBeUndefined();
    const turn = (result.structuredContent as { turn: { touched: Array<{ id: number; conditions: string[] }> } }).turn;
    expect(turn).toBeTruthy();
    expect(turn.touched.find((t) => t.id === targetId)?.conditions).toContain('prone');

    const { encounter } = await call<{ encounter: BattleState }>(client, 'get_battle_state', { campaign_id: campaignId });
    expect(encounter.combatants.find((c) => c.id === targetId)!.conditions).toContain('prone');
    await client.close();
  });

  it('refuses duration_rounds without a combatant and changes nothing', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);

    const refused = await client.callTool({
      name: 'condition',
      arguments: { campaign_id: campaignId, op: 'set', condition: 'prone', active: true, duration_rounds: 3 },
    });
    expect(refused.isError).toBe(true);
    expect((refused.content as Array<{ text: string }>)[0]!.text).toBe(
      'duration_rounds only applies to a combatant in a fight; pass combatant_id, or leave duration_rounds out.',
    );
    const sheet = await call<{ character: { conditions: string[] } }>(client, 'get_character_sheet', {
      campaign_id: campaignId,
    });
    expect(sheet.character.conditions).not.toContain('prone');
    await client.close();
  });

  it('teaches the caller that op=set needs condition and active', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const refused = await client.callTool({
      name: 'condition',
      arguments: { campaign_id: campaignId, op: 'set' },
    });
    expect(refused.isError).toBe(true);
    expect((refused.content as Array<{ text: string }>)[0]!.text).toMatch(/^Missing condition, active for op=set/);
    await client.close();
  });

  it('rolls the death save of a character at 0 HP', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const sheet = await call<{ character: { hp_max: number } }>(client, 'get_character_sheet', {
      campaign_id: campaignId,
    });
    await call(client, 'hp', { campaign_id: campaignId, op: 'damage', amount: sheet.character.hp_max });

    const answer = await call<{ roll: number; result: string }>(client, 'condition', {
      campaign_id: campaignId,
      op: 'death_save',
    });
    expect(answer.roll).toBe(20);
    expect(answer.result).toBe('critical_success');
    await client.close();
  });

  it('stabilises a character at 0 HP', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const sheet = await call<{ character: { hp_max: number } }>(client, 'get_character_sheet', {
      campaign_id: campaignId,
    });
    await call(client, 'hp', { campaign_id: campaignId, op: 'damage', amount: sheet.character.hp_max });

    const answer = await call<{ name: string; stable: boolean; hp_current: number }>(client, 'condition', {
      campaign_id: campaignId,
      op: 'stabilize',
      source: "a healer's kit",
    });
    expect(answer.stable).toBe(true);
    expect(answer.hp_current).toBe(0);
    await client.close();
  });

  it('sets the exhaustion level and reads it back on the sheet', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);

    const set = await call<{ exhaustion: number; previous: number }>(client, 'condition', {
      campaign_id: campaignId,
      op: 'exhaustion',
      level: 2,
    });
    expect(set.exhaustion).toBe(2);
    expect(set.previous).toBe(0);
    const sheet = await call<{ character: { exhaustion: number } }>(client, 'get_character_sheet', {
      campaign_id: campaignId,
    });
    expect(sheet.character.exhaustion).toBe(2);
    await client.close();
  });

  it('refuses combatant_id on op=death_save and rolls nothing', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);
    const sheet = await call<{ character: { hp_max: number } }>(client, 'get_character_sheet', {
      campaign_id: campaignId,
    });
    await call(client, 'hp', { campaign_id: campaignId, op: 'damage', amount: sheet.character.hp_max });

    const rolls = (): number => (db.prepare('SELECT COUNT(*) AS n FROM roll').get() as { n: number }).n;
    const before = rolls();

    const refused = await client.callTool({
      name: 'condition',
      arguments: { campaign_id: campaignId, op: 'death_save', combatant_id: 12 },
    });
    expect(refused.isError).toBe(true);
    expect((refused.content as Array<{ text: string }>)[0]!.text).toBe(
      'combatant_id does not apply to op=death_save; it takes campaign_id, character_id. Re-call without it.',
    );
    expect(rolls()).toBe(before);
    await client.close();
  });

  it('gives op=set a countdown effect when combatant_id and duration_rounds both arrive', async () => {
    const client = await connect();
    const { campaignId, targetId } = await openFight(client);

    const result = await client.callTool({
      name: 'condition',
      arguments: {
        campaign_id: campaignId,
        op: 'set',
        combatant_id: targetId,
        condition: 'prone',
        active: true,
        duration_rounds: 3,
      },
    });
    expect(result.isError).toBeUndefined();

    const { encounter } = await call<{ encounter: BattleState }>(client, 'get_battle_state', { campaign_id: campaignId });
    const effect = encounter.effects.find((e) => e.active && e.target_id === targetId && e.name === 'prone');
    expect(effect).toBeTruthy();
    expect(effect!.ends).toBe('rounds');
    expect(effect!.remaining_rounds).toBe(3);
    expect(encounter.combatants.find((c) => c.id === targetId)!.conditions).toContain('prone');
    await client.close();
  });

  it('mirrors an op=set by character_id onto the PC combatant row in a fight', async () => {
    const client = await connect();
    const { campaignId } = await openFight(client);

    const before = await call<{ encounter: BattleState }>(client, 'get_battle_state', { campaign_id: campaignId });
    const pcCombatant = before.encounter.combatants.find((c) => c.kind === 'pc');
    expect(pcCombatant).toBeTruthy();

    await call(client, 'condition', { campaign_id: campaignId, op: 'set', condition: 'prone', active: true });

    const after = await call<{ encounter: BattleState }>(client, 'get_battle_state', { campaign_id: campaignId });
    expect(after.encounter.combatants.find((c) => c.id === pcCombatant!.id)!.conditions).toContain('prone');
    await client.close();
  });
});
