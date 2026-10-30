// The combat text replies carry what a text-only DM needs: the encounter id, effect ids that effect {op: end}
// takes, the active combatant's legal actions, the recent log, the call an undo took back, and new ids.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeEncounter, combatLog, getBattleState, type BattleState } from '../src/combat/state.js';
import { addItem } from '../src/core/character.js';
import { estimateTokens } from '../src/core/token-budget.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';
import { replyText } from './helpers/reply.js';

/** The Playability review's cap on one turn reply, in estimated tokens. */
const TURN_REPLY = 300;

/** 0.041 pins every d20 to a natural 20, so the fight plays out the same way every run. */
const NAT_20 = 0.041;

let db: Db;
let stopClicking: () => void;
const realRandom = Math.random;

beforeEach(() => {
  db = openDb(':memory:');
  stopClicking = resolvePendingRollsImmediately(db);
  Math.random = () => NAT_20;
});

afterEach(() => {
  stopClicking();
  Math.random = realRandom;
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** A tool's reply text; a refusal throws with its words. */
async function text(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(replyText(result));
  return replyText(result);
}

/** Borg the Fighter, carrying an unidentified +1 Longsword, against the enemies given on a small road. */
async function openFight(
  client: Client,
  enemies: Array<{ creature: string; count?: number }> = [{ creature: 'Goblin Warrior', count: 2 }],
): Promise<{ campaignId: number; started: string }> {
  const created = await text(client, 'create_campaign', { name: 'Render Gaps', story_shape: 'sandbox' });
  const campaignId = Number(/"campaign_id":(\d+)/.exec(created)![1]);
  await text(client, 'create_character', {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
  addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true, equipped: true });
  const started = await text(client, 'start_encounter', {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies,
  });
  return { campaignId, started };
}

/** Combatant ids for the calls, read off the engine because the text names combatants rather than ids. */
const battle = (campaignId: number): BattleState => getBattleState(db, campaignId, false)!;

/** Advances the turn until the PC is up. */
async function toPc(client: Client, campaignId: number): Promise<void> {
  for (let step = 0; step < 12 && battle(campaignId).active?.kind !== 'pc'; step += 1) {
    await text(client, 'advance_turn', { campaign_id: campaignId });
  }
  expect(battle(campaignId).active?.kind).toBe('pc');
}

/** The lines of one titled section of the battle text, up to the next blank line. */
function section(body: string, title: string): string[] {
  const lines = body.split('\n');
  const start = lines.indexOf(title);
  if (start < 0) return [];
  const end = lines.indexOf('', start);
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

describe('start_encounter', () => {
  it('names the encounter id in its first line', async () => {
    const client = await connect();
    const { campaignId, started } = await openFight(client);
    const encounter = activeEncounter(db, campaignId)!;
    const up = battle(campaignId).active!;
    expect(started.split('\n')[0]).toBe(`Encounter ${encounter.id}, round 1, turn 0 - ${up.name} #${up.id} is up.`);
    await client.close();
  });
});

describe('get_battle_state', () => {
  it('lists each ongoing effect with an id that effect {op: end} accepts', async () => {
    const client = await connect();
    const { campaignId } = await openFight(client);
    const state = battle(campaignId);
    const borg = state.combatants.find((c) => c.kind === 'pc')!;
    const goblin = state.combatants.find((c) => c.team === 'enemy')!;
    await text(client, 'effect', {
      op: 'apply',
      campaign_id: campaignId,
      target_id: goblin.id,
      source_id: borg.id,
      name: 'on fire',
      kind: 'damage',
      damage_expr: '1d6',
      damage_type: 'fire',
      tick: 'start',
      ends: 'rounds',
      remaining_rounds: 3,
    });
    await text(client, 'effect', {
      op: 'apply',
      campaign_id: campaignId,
      target_id: borg.id,
      source_id: goblin.id,
      name: 'poisoned',
      kind: 'condition',
      save_ability: 'con',
      save_dc: 11,
      tick: 'end',
      ends: 'save',
    });

    const effects = section(await text(client, 'get_battle_state', { campaign_id: campaignId }), 'Effects:');
    expect(effects).toHaveLength(2);
    expect(effects[0]).toMatch(
      new RegExp(`^#\\d+ on ${goblin.name}: on fire \\(damage, from Borg\\) - 1d6 fire at its turn start; 3 rounds left$`),
    );
    expect(effects[1]).toMatch(
      new RegExp(`^#\\d+ on Borg: poisoned \\(condition, from ${goblin.name}\\) - DC 11 CON save at its turn end ends it$`),
    );

    const fireId = Number(/^#(\d+)/.exec(effects[0]!)![1]);
    const ended = await text(client, 'effect', { op: 'end', campaign_id: campaignId, effect_id: fireId });
    expect(ended).toContain(`on fire ends on ${goblin.name}.`);
    const after = section(await text(client, 'get_battle_state', { campaign_id: campaignId }), 'Effects:');
    expect(after).toEqual([effects[1]]);
    await client.close();
  });

  it("names the active combatant's legal actions in true names", async () => {
    const client = await connect();
    const { campaignId } = await openFight(client);
    await toPc(client, campaignId);

    const body = await text(client, 'get_battle_state', { campaign_id: campaignId });
    const line = body.split('\n').find((l) => l.startsWith('Legal actions for Borg: '));
    expect(line).toBeDefined();
    for (const action of battle(campaignId).legal_actions) expect(line).toContain(action.id);
    expect(line).toContain('attack:+1 Longsword');
    expect(line).toContain('move (Move (30 ft left))');
    expect(body).not.toContain('Unidentified');
    await client.close();
  });

  it('carries the last five log lines, newest last, without what an undo took back', async () => {
    const client = await connect();
    const { campaignId } = await openFight(client);
    for (let step = 0; step < 4; step += 1) await text(client, 'advance_turn', { campaign_id: campaignId });
    await text(client, 'undo_last_combat_action', { campaign_id: campaignId });

    const recent = section(await text(client, 'get_battle_state', { campaign_id: campaignId }), 'Recent log:');
    const encounterId = activeEncounter(db, campaignId)!.id;
    const kept = combatLog(db, encounterId, { omitReverted: true }).map((e) => e.text);
    // The undo line carries its DM-only note after the engine's own text.
    expect(recent.slice(0, -1)).toEqual(kept.slice(-5, -1));
    expect(recent.at(-1)).toBe(`${kept.at(-1)} That took back advance_turn.`);
    await client.close();
  });
});

describe('effect {op: apply}', () => {
  it('names the new effect id in its first line', async () => {
    const client = await connect();
    const { campaignId } = await openFight(client);
    const goblin = battle(campaignId).combatants.find((c) => c.team === 'enemy')!;
    const applied = await text(client, 'effect', {
      op: 'apply',
      campaign_id: campaignId,
      target_id: goblin.id,
      name: 'marked',
      kind: 'buff',
      tick: 'end',
      ends: 'manual',
    });
    const effect = battle(campaignId).effects.find((e) => e.name === 'marked')!;
    expect(applied.split('\n')[0]).toBe(`Effect #${effect.id} on ${goblin.name}: marked (buff) - until ended.`);
    expect(estimateTokens(applied)).toBeLessThanOrEqual(TURN_REPLY);
    await client.close();
  });
});

describe('undo_last_combat_action', () => {
  it('names the call it took back and who made it, then the whole field', async () => {
    const client = await connect();
    const { campaignId } = await openFight(client);
    await toPc(client, campaignId);
    const state = battle(campaignId);
    const borg = state.combatants.find((c) => c.kind === 'pc')!;
    const goblin = state.combatants.find((c) => c.team === 'enemy')!;
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(borg.x + 1, borg.y, goblin.id);
    const hit = await text(client, 'attack', {
      campaign_id: campaignId,
      attacker_id: borg.id,
      target_id: goblin.id,
      action_name: '+1 Longsword',
    });

    const undone = (await text(client, 'undo_last_combat_action', { campaign_id: campaignId })).split('\n');
    expect(undone[0]).toMatch(/^Undone: attack by Borg - Borg .+/);
    expect(hit).toContain(undone[0]!.replace('Undone: attack by Borg - ', ''));
    expect(undone[1]).toMatch(new RegExp(`^Encounter \\d+, round \\d+, turn \\d+ - Borg #${borg.id} is up\\.$`));
    expect(undone).toContain('Terrain: . open, ~ difficult (double cost), # blocked (full cover). Each cell is 5 ft.');

    await text(client, 'advance_turn', { campaign_id: campaignId });
    const turnBack = await text(client, 'undo_last_combat_action', { campaign_id: campaignId });
    expect(turnBack.split('\n')[0]).toBe('Undone: advance_turn by Borg - Borg ends their turn.');
    await client.close();
  });
});

describe('the turn replies', () => {
  it(`name a newcomer's id and stay within ${TURN_REPLY} tokens in a crowded fight`, async () => {
    const client = await connect();
    const { campaignId } = await openFight(client, [
      { creature: 'Goblin Warrior', count: 4 },
      { creature: 'Wolf', count: 2 },
      { creature: 'Goblin Boss' },
    ]);
    await toPc(client, campaignId);
    const state = battle(campaignId);
    const borg = state.combatants.find((c) => c.kind === 'pc')!;
    const boss = state.combatants.find((c) => c.name === 'Goblin Boss')!;

    const sizes: number[] = [];
    const applied = await text(client, 'effect', {
      op: 'apply',
      campaign_id: campaignId,
      target_id: borg.id,
      source_id: boss.id,
      name: 'poisoned',
      kind: 'condition',
      damage_expr: '1d4',
      damage_type: 'poison',
      save_ability: 'con',
      save_dc: 12,
      tick: 'end',
      ends: 'save',
    });
    sizes.push(estimateTokens(applied));
    expect(applied.split('\n')[0]).toMatch(/^Effect #\d+ on Borg: poisoned \(condition, from Goblin Boss\) - /);

    const added = await text(client, 'add_combatant', { campaign_id: campaignId, creature: 'Wolf', name: 'Grey Wolf' });
    sizes.push(estimateTokens(added));
    const wolf = battle(campaignId).combatants.find((c) => c.name === 'Grey Wolf')!;
    expect(added.split('\n')[0]).toBe(`Grey Wolf is combatant id ${wolf.id}.`);

    for (let step = 0; step < 3; step += 1) {
      sizes.push(estimateTokens(await text(client, 'advance_turn', { campaign_id: campaignId })));
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(TURN_REPLY);
    await client.close();
  });
});
