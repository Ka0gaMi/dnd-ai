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

/** 0.041 pins every d20 to a natural 20, so the seeded ambush plays out the same way every run. */
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

const text = async (client: Client, name: string, args: Record<string, unknown>): Promise<string> => {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as Array<{ text: string }>)[0]!.text;
};

beforeEach(() => {
  db = openDb(':memory:');
  // Player rolls are on by default, so stand in for a player who clicks the moment they are asked.
  stopClicking = resolvePendingRollsImmediately(db);
  Math.random = () => NAT_20;
});

afterEach(() => {
  stopClicking();
  Math.random = realRandom;
});

describe('combat tools end to end', () => {
  it('plays a seeded goblin ambush from start_encounter to end_encounter', async () => {
    const client = await connect();
    const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
      name: 'Goblin Ambush',
      story_shape: 'structured',
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

    const started = await call<{ encounter_id: number; seed: number; state: BattleState }>(
      client,
      'start_encounter',
      {
        campaign_id,
        seed: 7,
        terrain: 'road',
        size: 'small',
        features: ['road'],
        enemies: [{ creature: 'Goblin Warrior', count: 2 }],
      },
    );
    expect(started.seed).toBe(7);
    expect(started.state.combatants).toHaveLength(3);
    expect(started.state.round).toBe(1);

    const grid = await text(client, 'get_battle_state', { campaign_id });
    expect(grid).toContain('Terrain: . open, ~ difficult (double cost), # blocked (full cover).');
    expect(grid).toContain('B = Borg (party');

    const briefing = await text(client, 'load_campaign', { campaign_id });
    expect(briefing).toContain('## Combat in progress');
    expect(briefing).toContain('Goblin Warrior 1 (enemy)');

    const state = async (): Promise<BattleState> =>
      (await call<{ encounter: BattleState }>(client, 'get_battle_state', { campaign_id })).encounter;

    const pcId = started.state.combatants.find((c) => c.kind === 'pc')!.id;
    let attacks = 0;
    let moves = 0;
    for (let step = 0; step < 16; step += 1) {
      const current = await state();
      if (current.combatants.filter((c) => c.team === 'enemy' && c.alive).length === 0) break;
      if (current.active?.id === pcId) {
        const target = current.combatants.find((c) => c.team === 'enemy' && c.alive)!;
        if ((target.distance_ft ?? 99) > 5) {
          const moved = await call<{ movement_left: number }>(client, 'move_token', {
            campaign_id,
            combatant_id: pcId,
            toward: target.id,
          });
          expect(moved.movement_left).toBeLessThan(30);
          moves += 1;
        }
        const after = await state();
        const reachable = after.combatants.find((c) => c.team === 'enemy' && c.alive && (c.distance_ft ?? 99) <= 5);
        if (reachable) {
          const hit = await call<{ critical: boolean; total_damage: number; target_hp: { alive: boolean } }>(
            client,
            'attack',
            { campaign_id, attacker_id: pcId, target_id: reachable.id, action_name: 'Greatsword' },
          );
          expect(hit.critical).toBe(true);
          expect(hit.total_damage).toBe(11);
          expect(hit.target_hp.alive).toBe(false);
          attacks += 1;
        }
      }
      await call(client, 'advance_turn', { campaign_id });
    }
    expect(attacks).toBe(2);
    expect(moves).toBeGreaterThan(0);

    const ended = await call<{
      xp_suggestion: number;
      rounds: number;
      defeated: Array<{ name: string; xp: number }>;
      combatants: Array<{ name: string; damage_dealt: number; damage_taken: number }>;
    }>(client, 'end_encounter', { campaign_id, outcome: 'victory', summary: 'Both goblins cut down.' });

    expect(ended.xp_suggestion).toBe(100);
    expect(ended.defeated.map((d) => d.xp)).toEqual([50, 50]);
    expect(ended.combatants.find((c) => c.name === 'Borg')!.damage_dealt).toBe(22);
    expect(ended.rounds).toBeGreaterThanOrEqual(2);

    const log = db
      .prepare('SELECT kind, COUNT(*) AS n FROM combat_log WHERE encounter_id = ? GROUP BY kind')
      .all(started.encounter_id) as Array<{ kind: string; n: number }>;
    const kinds = Object.fromEntries(log.map((row) => [row.kind, row.n]));
    expect(kinds.encounter_start).toBe(1);
    expect(kinds.initiative).toBe(3);
    expect(kinds.attack).toBe(2);
    expect(kinds.damage).toBe(2);
    expect(kinds.kill).toBe(2);
    expect(kinds.move).toBeGreaterThan(0);
    expect(kinds.turn_start).toBeGreaterThan(0);
    expect(kinds.turn_end).toBeGreaterThan(0);
    expect(kinds.round).toBeGreaterThan(0);
    expect(kinds.encounter_end).toBe(1);

    const events = db
      .prepare("SELECT payload_json FROM event WHERE campaign_id = ? AND kind = 'combat' ORDER BY id")
      .all(campaign_id) as Array<{ payload_json: string }>;
    expect(events.length).toBeGreaterThan(5);
    const last = JSON.parse(events[events.length - 1]!.payload_json) as {
      tool: string;
      encounter_id: number;
      log: Array<{ kind: string }>;
      state: BattleState;
    };
    expect(last.tool).toBe('end_encounter');
    expect(last.encounter_id).toBe(started.encounter_id);
    expect(last.state.combatants).toHaveLength(3);
    expect(last.state.encounter.status).toBe('ended');

    await client.close();
  });

  it('holds the checkpoint reminder back until the fight is over', async () => {
    const client = await connect();
    const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
      name: 'Long Fight',
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
    await call(client, 'start_encounter', { campaign_id, seed: 5, terrain: 'cave', enemies: [{ creature: 'Wolf' }] });

    // Each combat call writes an event, so the nag would fire mid-fight if it were not suppressed.
    for (let turn = 0; turn < 30; turn += 1) await call(client, 'advance_turn', { campaign_id });
    expect(await text(client, 'get_battle_state', { campaign_id })).not.toContain('Reminder: call checkpoint {op: save}');

    const ended = await text(client, 'end_encounter', { campaign_id, outcome: 'retreat' });
    expect(ended).toContain('Reminder: call checkpoint {op: save}');
    await client.close();
  });

  it('refuses a second encounter while one is running and reports no fight when none is', async () => {
    const client = await connect();
    const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
      name: 'One At A Time',
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
    expect(await text(client, 'get_battle_state', { campaign_id })).toBe('No active encounter in this campaign.');

    await call(client, 'start_encounter', {
      campaign_id,
      seed: 3,
      terrain: 'cave',
      enemies: [{ creature: 'Wolf' }],
    });
    const second = await client.callTool({
      name: 'start_encounter',
      arguments: { campaign_id, seed: 4, terrain: 'cave', enemies: [{ creature: 'Wolf' }] },
    });
    expect(second.isError).toBe(true);
    expect((second.content as Array<{ text: string }>)[0]!.text).toContain('end_encounter');
    await client.close();
  });

  it('refuses use_spell_slot while the caster is in a fight and spends nothing', async () => {
    const client = await connect();
    const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
      name: 'Slot Keeper',
      story_shape: 'sandbox',
    });
    await call(client, 'create_character', {
      campaign_id,
      name: 'Zel',
      species: 'Human',
      class: 'Wizard',
      background: 'Sage',
      ability_method: 'standard_array',
      abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
      ability_bonuses: { int: 2, con: 1 },
      skill_choices: ['arcana', 'investigation', 'perception'],
      cantrips: ['Light', 'Mage Hand', 'Ray of Frost'],
      spells: ['Magic Missile', 'Shield', 'Sleep', 'Detect Magic'],
    });
    const slots = async (): Promise<Record<string, { max: number; used: number }>> =>
      (
        await call<{ character: { spell_slots: Record<string, { max: number; used: number }> } }>(
          client,
          'get_character_sheet',
          { campaign_id },
        )
      ).character.spell_slots;
    const before = await slots();

    await call(client, 'start_encounter', {
      campaign_id,
      seed: 3,
      terrain: 'cave',
      enemies: [{ creature: 'Goblin Warrior' }],
    });
    const refused = await client.callTool({
      name: 'spells',
      arguments: { campaign_id, op: 'spend_slot', level: 1, spell: 'Magic Missile' },
    });
    expect(refused.isError).toBe(true);
    expect((refused.content as Array<{ text: string }>)[0]!.text).toContain(
      'Zel is in a fight: use_action {spell, slot_level} spends the slot itself. Call that instead.',
    );
    expect(await slots()).toEqual(before);
    await client.close();
  });

  it('answers find_position and undoes the last call over the tool interface', async () => {
    const client = await connect();
    const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
      name: 'Take Cover',
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
    const started = await call<{ state: BattleState }>(client, 'start_encounter', {
      campaign_id,
      seed: 7,
      terrain: 'cave',
      size: 'small',
      features: ['pillars'],
      enemies: [{ creature: 'Goblin Warrior' }],
    });
    const pc = started.state.combatants.find((c) => c.kind === 'pc')!;
    const goblin = started.state.combatants.find((c) => c.team === 'enemy')!;

    // Whoever won initiative, the turn has to come round to the PC before it can move.
    for (let step = 0; step < 4; step += 1) {
      const current = (await call<{ encounter: BattleState }>(client, 'get_battle_state', { campaign_id })).encounter;
      if (current.active?.id === pc.id) break;
      await call(client, 'advance_turn', { campaign_id });
    }

    const found = await call<{ candidates: Array<{ x: number; y: number; cover_from_target: string }>; reason: string | null }>(
      client,
      'find_position',
      { campaign_id, combatant_id: pc.id, cover_from: goblin.id, limit: 3 },
    );
    expect(found.reason).toBeNull();
    expect(found.candidates.length).toBeGreaterThan(0);
    for (const cell of found.candidates) expect(cell.cover_from_target).not.toBe('none');

    // The engine picks the cell, so the DM never has to guess one.
    const moved = await call<{ position: { x: number; y: number } }>(client, 'move_token', {
      campaign_id,
      combatant_id: pc.id,
      cover_from: goblin.id,
    });
    expect(moved.position).toEqual({ x: found.candidates[0]!.x, y: found.candidates[0]!.y });

    const undone = await call<{ undone: string }>(client, 'undo_last_combat_action', {
      campaign_id,
    });
    expect(undone.undone).toBe('move_token');
    // The mutating tools answer with the turn view now, so read the rewound battle state directly.
    const rewound = (await call<{ encounter: BattleState }>(client, 'get_battle_state', { campaign_id })).encounter;
    const back = rewound.combatants.find((c) => c.id === pc.id)!;
    expect({ x: back.x, y: back.y }).toEqual({ x: pc.x, y: pc.y });
    expect(back.movement_left).toBe(pc.movement_left);
    await client.close();
  });
});
