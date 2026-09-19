// The mutating combat tools answer with the compact turn view: what changed, whose turn it is and
// no whole battle state. get_battle_state still carries the whole field.
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

/** 0.041 pins every d20 to a natural 20, so the fight plays out the same way every run. */
const NAT_20 = 0.041;

/** A grid row is three padded digits, a space and the cells, e.g. "  0 .....". */
const GRID_ROW = /^\s{2,3}\d+ [.~#A-Za-z]+$/;

interface ToolAnswer {
  structuredContent: Record<string, unknown>;
  content: Array<{ type: string; text: string }>;
}

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

/** Both halves of one answer, so a test can read structuredContent and the text body together. */
async function answer(client: Client, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result as unknown as ToolAnswer;
}

const bodyOf = (a: ToolAnswer): string => a.content[0]!.text;

const stateOf = async (client: Client, campaignId: number): Promise<BattleState> =>
  (await call<{ encounter: BattleState }>(client, 'get_battle_state', { campaign_id: campaignId })).encounter;

function assertTurnReply(a: ToolAnswer): void {
  expect(a.structuredContent.state).toBeUndefined();
  const turn = a.structuredContent.turn as {
    round: number;
    active: unknown;
    legal_actions: unknown[];
    touched: unknown[];
  };
  expect(turn).toBeTruthy();
  expect(typeof turn.round).toBe('number');
  expect(turn).toHaveProperty('active');
  expect(Array.isArray(turn.legal_actions)).toBe(true);
  expect(Array.isArray(turn.touched)).toBe(true);

  const body = bodyOf(a);
  expect(body).toContain('Round ');
  expect(body.trimEnd().endsWith('Call get_battle_state for the map and every combatant.')).toBe(true);
  expect(body.split('\n').some((line) => GRID_ROW.test(line))).toBe(false);
}

/** A campaign, a lone Fighter and a single goblin on a small road. */
async function openFight(
  client: Client,
): Promise<{ campaignId: number; pcId: number; started: ToolAnswer }> {
  const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
    name: 'Reply Diet',
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
  const started = await answer(client, 'start_encounter', {
    campaign_id,
    seed: 7,
    terrain: 'road',
    size: 'small',
    features: ['road'],
    enemies: [{ creature: 'Goblin Warrior' }],
  });
  const state = await stateOf(client, campaign_id);
  return { campaignId: campaign_id, pcId: state.combatants.find((c) => c.kind === 'pc')!.id, started };
}

/** Walks the turn round to the PC and closes to melee, returning the enemy id. */
async function closeOnEnemy(client: Client, campaignId: number, pcId: number): Promise<number> {
  for (let step = 0; step < 12; step += 1) {
    const state = await stateOf(client, campaignId);
    if (state.active?.id !== pcId) {
      await call(client, 'advance_turn', { campaign_id: campaignId });
      continue;
    }
    const pc = state.combatants.find((c) => c.id === pcId)!;
    const enemy = state.combatants.find((c) => c.team === 'enemy' && c.alive)!;
    if ((enemy.distance_ft ?? 99) <= 5) return enemy.id;
    if (pc.movement_left < 5) {
      await call(client, 'advance_turn', { campaign_id: campaignId });
      continue;
    }
    await call(client, 'move_token', { campaign_id: campaignId, combatant_id: pcId, toward: enemy.id });
  }
  throw new Error('could not close on the enemy');
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

describe('the combat reply diet', () => {
  it('answers attack, move_token and advance_turn with the compact turn view', async () => {
    const client = await connect();
    const { campaignId, pcId } = await openFight(client);

    // Bring the turn round to the PC so it can close and swing.
    let current = await stateOf(client, campaignId);
    for (let step = 0; step < 4 && current.active?.id !== pcId; step += 1) {
      assertTurnReply(await answer(client, 'advance_turn', { campaign_id: campaignId }));
      current = await stateOf(client, campaignId);
    }
    expect(current.active?.id).toBe(pcId);

    const enemy = current.combatants.find((c) => c.team === 'enemy' && c.alive)!;
    assertTurnReply(
      await answer(client, 'move_token', { campaign_id: campaignId, combatant_id: pcId, toward: enemy.id }),
    );

    const targetId = await closeOnEnemy(client, campaignId, pcId);

    // A condition set through the shared helper names its target in touched, with the condition on it.
    const marked = await answer(client, 'set_combat_condition', {
      campaign_id: campaignId,
      combatant_id: targetId,
      condition: 'prone',
      active: true,
    });
    assertTurnReply(marked);
    const markedTurn = marked.structuredContent.turn as { touched: Array<{ id: number; conditions: string[] }> };
    expect(markedTurn.touched.find((t) => t.id === targetId)?.conditions).toContain('prone');

    const hit = await answer(client, 'attack', {
      campaign_id: campaignId,
      attacker_id: pcId,
      target_id: targetId,
      action_name: 'Greatsword',
    });
    assertTurnReply(hit);

    // The attack's own fields and the log ride along unchanged, the target is in touched with its HP,
    // and the body words the log.
    const log = hit.structuredContent.log as Array<{ text: string }>;
    expect(Array.isArray(log)).toBe(true);
    expect(hit.structuredContent).toHaveProperty('total_damage');
    expect(hit.structuredContent).toHaveProperty('target_hp');
    const hitTurn = hit.structuredContent.turn as { touched: Array<{ id: number; hp_current: number }> };
    expect(hitTurn.touched.map((t) => t.id)).toContain(targetId);
    const targetHp = hit.structuredContent.target_hp as { current: number };
    expect(hitTurn.touched.find((t) => t.id === targetId)?.hp_current).toBe(targetHp.current);
    expect(bodyOf(hit)).toContain(log[log.length - 1]!.text);

    // Undo keeps the whole grid in its text so the rewind can be checked, and the turn view in its payload.
    const undone = await answer(client, 'undo_last_combat_action', { campaign_id: campaignId });
    expect(undone.structuredContent).toHaveProperty('turn');
    expect(undone.structuredContent).not.toHaveProperty('state');
    expect(bodyOf(undone)).toContain('Terrain: . open');

    await client.close();
  });

  it('leads with the Act for line only when a monster is up', async () => {
    const client = await connect();
    const { campaignId } = await openFight(client);

    const seen = { monster: false, pc: false };
    for (let step = 0; step < 4 && !(seen.monster && seen.pc); step += 1) {
      const a = await answer(client, 'advance_turn', { campaign_id: campaignId });
      const turn = a.structuredContent.turn as { active: { kind: string; name: string } | null };
      const body = bodyOf(a);
      if (turn.active?.kind === 'monster') {
        seen.monster = true;
        const [leadLine] = body.split('\n');
        expect(leadLine).toBe(
          `Act for ${turn.active.name} now with attack or use_action, then call advance_turn once.`,
        );
        expect(body).toContain('Round ');
      } else {
        seen.pc = true;
        expect(body).not.toContain('Act for');
      }
    }
    expect(seen.monster).toBe(true);
    expect(seen.pc).toBe(true);

    await client.close();
  });

  it('still answers start_encounter and get_battle_state with the whole field', async () => {
    const client = await connect();
    const { campaignId, started } = await openFight(client);

    const startedState = started.structuredContent.state as { combatants: unknown[] };
    expect(Array.isArray(startedState.combatants)).toBe(true);
    const startText = bodyOf(started);
    expect(startText).toContain('Terrain: . open');
    expect(startText.split('\n').some((line) => GRID_ROW.test(line))).toBe(true);

    const full = await answer(client, 'get_battle_state', { campaign_id: campaignId });
    const encounter = full.structuredContent.encounter as { combatants: unknown[] };
    expect(Array.isArray(encounter.combatants)).toBe(true);
    const fullText = bodyOf(full);
    expect(fullText).toContain('Terrain: . open');
    expect(fullText.split('\n').some((line) => GRID_ROW.test(line))).toBe(true);

    await client.close();
  });

  it('makes an attack answer less than half the size of the whole battle state', async () => {
    const client = await connect();
    const { campaignId, pcId } = await openFight(client);
    const targetId = await closeOnEnemy(client, campaignId, pcId);
    const hit = await answer(client, 'attack', {
      campaign_id: campaignId,
      attacker_id: pcId,
      target_id: targetId,
      action_name: 'Greatsword',
    });
    const full = await answer(client, 'get_battle_state', { campaign_id: campaignId });

    const attackBytes = JSON.stringify(hit.structuredContent).length;
    const stateBytes = JSON.stringify(full.structuredContent).length;
    expect(attackBytes).toBeLessThan(stateBytes / 2);

    await client.close();
  });
});
