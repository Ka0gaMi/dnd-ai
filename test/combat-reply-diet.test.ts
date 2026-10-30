// The mutating combat tools answer with the compact turn view: what changed, whose turn it is and
// no whole battle state. get_battle_state still carries the whole field.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';
import { replyData } from './helpers/reply.js';
import { getBattleState, type BattleState, type CombatantView } from '../src/combat/state.js';

let db: Db;
let stopClicking: () => void;
const realRandom = Math.random;

/** 0.041 pins every d20 to a natural 20, so the fight plays out the same way every run. */
const NAT_20 = 0.041;

/** A grid row is three padded digits, a space and the cells, e.g. "  0 .....". */
const GRID_ROW = /^\s{2,3}\d+ [.~#A-Za-z]+$/;

/** A legend line of the whole battle render, e.g. "g = Goblin Warrior (enemy, 10/10 HP, ...". */
const LEGEND_LINE = /^\S+ = .+ \((party|enemy|neutral), /gm;

interface ToolAnswer {
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
  return replyData<T>(result);
}

/** The whole answer, for the tools that reply in rendered text rather than JSON. */
async function answer(client: Client, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result as unknown as ToolAnswer;
}

const bodyOf = (a: ToolAnswer): string => a.content[0]!.text;

/** The DM's view of the fight, read from the engine since get_battle_state answers in words. */
const stateOf = (campaignId: number): BattleState => getBattleState(db, campaignId, false)!;

/** The turn view's "<marker> <name>: ..." line for one touched combatant. */
const touchedLine = (body: string, c: CombatantView): string | undefined =>
  body.split('\n').find((line) => line.startsWith(`${c.marker} ${c.name}: `));

function assertTurnReply(a: ToolAnswer): void {
  const body = bodyOf(a);
  // The turn view in words: the round and who is up, the legal actions, and the touched combatants.
  expect(body).toMatch(/^Round \d+ - (.+ is up, has (acted|not acted yet)|no active combatant)\.$/m);
  expect(body).toMatch(/^Actions: /m);
  expect(body).toMatch(/^\S+ .+: (\d+\/\d+ HP|dead)/m);
  // No whole battle state: neither the render's legend nor a JSON dump of the field.
  expect(body).not.toContain('Terrain: . open');
  expect(body).not.toContain('"combatants"');
  expect(body).toContain('Round ');
  // The turn brief replaced the get_battle_state footer: the reply ends with the foes or the end_encounter line.
  expect(body).not.toContain('get_battle_state');
  expect(body.trimEnd().split('\n').at(-1)).toMatch(/^(Foes within|No foe within|No enemies left standing)/);
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
  const state = stateOf(campaign_id);
  return { campaignId: campaign_id, pcId: state.combatants.find((c) => c.kind === 'pc')!.id, started };
}

/** Walks the turn round to the PC and closes to melee, returning the enemy id. */
async function closeOnEnemy(client: Client, campaignId: number, pcId: number): Promise<number> {
  for (let step = 0; step < 12; step += 1) {
    const state = stateOf(campaignId);
    if (state.active?.id !== pcId) {
      await answer(client, 'advance_turn', { campaign_id: campaignId });
      continue;
    }
    const pc = state.combatants.find((c) => c.id === pcId)!;
    const enemy = state.combatants.find((c) => c.team === 'enemy' && c.alive)!;
    if ((enemy.distance_ft ?? 99) <= 5) return enemy.id;
    if (pc.movement_left < 5) {
      await answer(client, 'advance_turn', { campaign_id: campaignId });
      continue;
    }
    await answer(client, 'move_token', { campaign_id: campaignId, combatant_id: pcId, toward: enemy.id });
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
    let current = stateOf(campaignId);
    for (let step = 0; step < 4 && current.active?.id !== pcId; step += 1) {
      assertTurnReply(await answer(client, 'advance_turn', { campaign_id: campaignId }));
      current = stateOf(campaignId);
    }
    expect(current.active?.id).toBe(pcId);

    const enemy = current.combatants.find((c) => c.team === 'enemy' && c.alive)!;
    assertTurnReply(
      await answer(client, 'move_token', { campaign_id: campaignId, combatant_id: pcId, toward: enemy.id }),
    );

    const targetId = await closeOnEnemy(client, campaignId, pcId);

    // A condition set through the shared helper names its target in touched, with the condition on it.
    const marked = await answer(client, 'condition', {
      op: 'set',
      campaign_id: campaignId,
      combatant_id: targetId,
      condition: 'prone',
      active: true,
    });
    assertTurnReply(marked);
    const proneTarget = stateOf(campaignId).combatants.find((c) => c.id === targetId)!;
    expect(touchedLine(bodyOf(marked), proneTarget)).toContain('prone');

    const hit = await answer(client, 'attack', {
      campaign_id: campaignId,
      attacker_id: pcId,
      target_id: targetId,
      action_name: 'Greatsword',
    });
    assertTurnReply(hit);

    // The attack's damage and the log ride along in words, the target is in touched with the HP the damage
    // line reports, and the body words the last log row the call wrote.
    const hitBody = bodyOf(hit);
    const target = stateOf(campaignId).combatants.find((c) => c.id === targetId)!;
    const damage = hitBody.split('\n').find((line) => line.startsWith(`${target.name} takes `));
    expect(damage).toContain(`- ${target.hp_current}/${target.hp_max} HP.`);
    expect(touchedLine(hitBody, target)).toContain(target.alive ? `${target.hp_current}/${target.hp_max} HP` : 'dead');
    const lastLog = db
      .prepare('SELECT text FROM combat_log WHERE encounter_id = ? ORDER BY id DESC LIMIT 1')
      .get(target.encounter_id) as { text: string };
    expect(hitBody).toContain(lastLog.text);

    // Undo keeps the whole grid in its text so the rewind can be checked, headed by the turn and with no JSON dump.
    const undone = bodyOf(await answer(client, 'undo_last_combat_action', { campaign_id: campaignId }));
    expect(undone).toMatch(/^Round \d+, turn \d+/);
    expect(undone).not.toContain('"combatants"');
    expect(undone).toContain('Terrain: . open');

    await client.close();
  });

  it('leads with the Act for line only when a monster is up', async () => {
    const client = await connect();
    const { campaignId } = await openFight(client);

    const seen = { monster: false, pc: false };
    for (let step = 0; step < 4 && !(seen.monster && seen.pc); step += 1) {
      const a = await answer(client, 'advance_turn', { campaign_id: campaignId });
      // Who is up is named in the body but not their kind, so the active combatant comes from the engine.
      const turn = { active: stateOf(campaignId).active };
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

    // The whole field in words: a legend line for every combatant, the terrain key and the grid.
    const fighters = stateOf(campaignId).combatants.length;
    const startText = bodyOf(started);
    expect(startText.match(LEGEND_LINE)).toHaveLength(fighters);
    expect(startText).toContain('Terrain: . open');
    expect(startText.split('\n').some((line) => GRID_ROW.test(line))).toBe(true);

    const full = await answer(client, 'get_battle_state', { campaign_id: campaignId });
    const fullText = bodyOf(full);
    expect(fullText.match(LEGEND_LINE)).toHaveLength(fighters);
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

    // The reply is its text alone; the whole battle state it no longer carries is the engine's DM view.
    const attackBytes = bodyOf(hit).length;
    const stateBytes = JSON.stringify(stateOf(campaignId)).length;
    expect(attackBytes).toBeLessThan(stateBytes / 2);

    await client.close();
  });
});
