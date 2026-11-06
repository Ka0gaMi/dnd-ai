// A party ally with no character sheet falls Unconscious at 0 HP and makes death saves as a character
// does; enemies and neutrals still die there, and massive damage still kills.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import {
  addCombatant,
  advanceTurn,
  applyEffect,
  attack,
  damageCombatant,
  endEncounter,
  startEncounter,
  undoLastCombatAction,
  useAction,
} from '../src/combat/engine.js';
import { legalActions } from '../src/combat/actions.js';
import { stabilizeCombatant } from '../src/combat/hp.js';
import { createGameServer } from '../src/mcp/server.js';
import { activeEncounter, getCombatant, listCombatants, type Combatant, type EncounterRow, type Team } from '../src/combat/state.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

/** Pins the RNG; the mapping is not linear, so the values used here are named. */
const FAIL_D20 = 0.5; // 9
const PASS_D20 = 0.6; // 18

/** Acting out of turn is a reaction: it needs a stated trigger. */
const REACTION = { out_of_turn: true, reason: 'a reaction the fiction called for' };

/** A new round refreshes the reaction; these tests only want the turn order bypassed. */
const clearReaction = (id: number): void => {
  db.prepare('UPDATE combatant SET reaction_used = 0 WHERE id = ?').run(id);
};

beforeEach(async () => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, {
    name: 'Allies',
    story_shape: 'sandbox',
    settings: { player_rolls: 'none' },
  }).campaign_id;
  createCharacter(db, {
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
  Math.random = () => FAIL_D20;
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior' }],
  });
});

afterEach(() => {
  Math.random = realRandom;
  db.close();
});

const encounter = (): EncounterRow => activeEncounter(db, campaignId)!;
const row = (id: number): Combatant => getCombatant(db, encounter().id, id);
const pcId = (): number => listCombatants(db, encounter().id).find((c) => c.kind === 'pc')!.id;
const goblinId = (): number => listCombatants(db, encounter().id).find((c) => c.team === 'enemy')!.id;

async function join(name: string, team: Team): Promise<number> {
  return (await addCombatant(db, { campaign_id: campaignId, creature: 'Guard', name, team, unique: true })).combatant_id;
}

/** Drops the combatant to exactly 0 HP from full, so no damage is left over. */
function knockDown(id: number): void {
  damageCombatant(db, encounter(), row(id), { amount: row(id).hp_max, type: 'piercing' });
}

/** Puts the turn just before this combatant's and advances into it. */
async function turnOf(id: number) {
  const order = listCombatants(db, encounter().id);
  const index = order.findIndex((c) => c.id === id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run((index - 1 + order.length) % order.length, encounter().id);
  return advanceTurn(db, campaignId);
}

async function strike(actor: number, target: number, damage: string) {
  clearReaction(actor);
  return useAction(db, {
    campaign_id: campaignId,
    actor_id: actor,
    action_name: 'Coup de grace',
    target_id: target,
    damage_expr: damage,
    damage_type: 'slashing',
    ...REACTION,
  });
}

describe('a party ally with no sheet at 0 HP', () => {
  it('falls Unconscious instead of dying, logs no kill, and is offered a death save', async () => {
    const ally = await join('Sergeant Torvald', 'party');
    expect(row(ally).kind).toBe('monster');

    const hit = await strike(goblinId(), ally, '15');

    const down = row(ally);
    expect(down.hp_current).toBe(0);
    expect(down.alive).toBe(true);
    expect(down.conditions).toEqual(expect.arrayContaining(['unconscious', 'prone']));
    expect(down.death_saves).toEqual({ successes: 0, failures: 0 });
    expect(hit.log.some((entry) => entry.kind === 'kill')).toBe(false);
    expect(hit.log.map((entry) => entry.text).join('\n')).not.toMatch(/drops dead/);
    expect(legalActions(down, null).map((a) => a.id)).toEqual(['death_save']);
  });

  it('rolls a death save on its turn and dies on the third failure', async () => {
    const ally = await join('Sergeant Torvald', 'party');
    knockDown(ally);

    for (let failures = 1; failures <= 3; failures += 1) {
      const turn = await turnOf(ally);
      const saves = turn.log.filter((entry) => entry.kind === 'death_save' && entry.actor_id === ally);
      expect(saves).toHaveLength(1);
      expect((saves[0]!.payload as { outcome: string }).outcome).toBe('failure');
      // The window's chip reads result, as it does on a character's death save.
      expect((saves[0]!.payload as { result: string }).result).toBe('failure');
      if (failures < 3) {
        expect(row(ally).death_saves.failures).toBe(failures);
        expect(row(ally).alive).toBe(true);
        expect(turn.legal_actions.map((a) => a.id)).toEqual(['death_save']);
      } else {
        expect(saves[0]!.text).toMatch(/and dies\.$/);
      }
    }

    const dead = row(ally);
    expect(dead.alive).toBe(false);
    expect(dead.conditions).not.toContain('unconscious');
    expect(dead.conditions).not.toContain('prone');
    expect(legalActions(dead, null)).toEqual([]);
  });

  it('dies outright to massive damage, from full HP or while down', async () => {
    const ally = await join('Sergeant Torvald', 'party');
    const felled = await strike(goblinId(), ally, '22');
    expect(row(ally).alive).toBe(false);
    expect(felled.log.filter((entry) => entry.kind === 'kill')).toHaveLength(1);

    const other = await join('Corporal Ana', 'party');
    knockDown(other);
    const result = damageCombatant(db, encounter(), row(other), { amount: 11, type: 'piercing' });
    expect(result.dead).toBe(true);
    expect(row(other).alive).toBe(false);
  });

  it('takes a death-save failure from damage while down, two from a critical, and the kill line waits for the death', async () => {
    const ally = await join('Sergeant Torvald', 'party');
    knockDown(ally);

    const graze = await strike(goblinId(), ally, '1');
    expect(row(ally).death_saves.failures).toBe(1);
    expect(row(ally).alive).toBe(true);
    expect(graze.log.some((entry) => entry.kind === 'kill')).toBe(false);

    // A hit on an Unconscious creature from 5 ft is a critical: two failures, and the third kills.
    const goblin = goblinId();
    const at = row(ally);
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(at.x + 1, at.y, goblin);
    clearReaction(goblin);
    const finished = await attack(db, {
      campaign_id: campaignId,
      attacker_id: goblin,
      target_id: ally,
      action_name: 'Scimitar',
      roll: { total: 30, natural: 12 },
      ...REACTION,
    });
    expect(finished.hit).toBe(true);
    expect(finished.critical).toBe(true);
    expect(row(ally).alive).toBe(false);
    expect(finished.log.filter((entry) => entry.kind === 'kill')).toHaveLength(1);
  });

  it('wakes when healed, keeping the Prone the fall gave it', async () => {
    const ally = await join('Sergeant Torvald', 'party');
    knockDown(ally);
    await strike(goblinId(), ally, '1');

    await useAction(db, {
      campaign_id: campaignId,
      actor_id: pcId(),
      action_name: 'Healing word',
      target_id: ally,
      heal_expr: '3',
      ...REACTION,
    });

    const awake = row(ally);
    expect(awake.hp_current).toBe(3);
    expect(awake.conditions).not.toContain('unconscious');
    expect(awake.conditions).toContain('prone');
    expect(awake.death_saves).toEqual({ successes: 0, failures: 0 });
    expect(legalActions(awake, null).map((a) => a.id)).not.toContain('death_save');
  });

  it('is stable after three successes, until damage lands again', async () => {
    const ally = await join('Sergeant Torvald', 'party');
    knockDown(ally);
    Math.random = () => PASS_D20;
    for (let i = 0; i < 3; i += 1) await turnOf(ally);
    expect(row(ally).flags.stable).toBe(true);
    expect(row(ally).alive).toBe(true);

    const quiet = await turnOf(ally);
    expect(quiet.log.some((entry) => entry.kind === 'death_save' && entry.actor_id === ally)).toBe(false);

    damageCombatant(db, encounter(), row(ally), { amount: 1, type: 'piercing' });
    expect(row(ally).flags.stable).toBeUndefined();
    expect(row(ally).death_saves).toEqual({ successes: 0, failures: 1 });
    const again = await turnOf(ally);
    expect(again.log.some((entry) => entry.kind === 'death_save' && entry.actor_id === ally)).toBe(true);
  });

  it('rolls a blessed death save once and keeps that roll', async () => {
    const ally = await join('Sergeant Torvald', 'party');
    knockDown(ally);
    applyEffect(db, { campaign_id: campaignId, target_id: ally, source_id: pcId(), name: 'Bless', kind: 'buff', ends: 'manual' });
    let calls = 0;
    Math.random = () => ((calls += 1) * 0.137) % 1;

    const turn = await turnOf(ally);

    const recorded = db.prepare("SELECT total FROM roll WHERE purpose = 'Death saving throw'").all() as Array<{ total: number }>;
    expect(recorded).toHaveLength(1);
    const save = turn.log.find((entry) => entry.kind === 'death_save' && entry.actor_id === ally)!;
    expect((save.payload as { roll: number }).roll).toBe(recorded[0]!.total);
  });
});

describe('an enemy or a neutral at 0 HP', () => {
  it('still dies, with the kill line', async () => {
    const foe = await join('Hostile Guard', 'enemy');
    const felled = await strike(pcId(), foe, '11');
    expect(row(foe).alive).toBe(false);
    expect(felled.log.filter((entry) => entry.kind === 'kill')).toHaveLength(1);

    const bystander = await join('Gate Guard', 'neutral');
    const result = damageCombatant(db, encounter(), row(bystander), { amount: 11, type: 'piercing' });
    expect(result.dead).toBe(true);
    expect(row(bystander).alive).toBe(false);
  });
});

describe('end_encounter', () => {
  it('counts only enemies in the XP suggestion and the defeated list', async () => {
    const ally = await join('Sergeant Torvald', 'party');
    const downed = await join('Corporal Ana', 'party');
    await strike(goblinId(), ally, '22');
    knockDown(downed);
    await strike(pcId(), goblinId(), '40');
    expect(row(ally).alive).toBe(false);

    const ended = endEncounter(db, { campaign_id: campaignId, outcome: 'victory' });
    expect(ended.xp_suggestion).toBe(50);
    expect(ended.defeated.map((d) => d.name)).not.toContain('Sergeant Torvald');
    expect(ended.defeated.map((d) => d.name)).not.toContain('Corporal Ana');
    expect(ended.defeated).toHaveLength(1);
  });
});

type Reply = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function stabilise(client: Client, args: Record<string, unknown>): Promise<Reply> {
  const result = await client.callTool({ name: 'condition', arguments: { campaign_id: campaignId, op: 'stabilize', ...args } });
  return result as unknown as Reply;
}

const textOf = (reply: Reply): string => reply.content.map((c) => c.text ?? '').join('');

/** The rows a call that cost something would leave behind: an undo snapshot and fight-log lines. */
const footprint = (): { undo: number; log: number } => ({
  undo: (db.prepare('SELECT COUNT(*) AS n FROM combat_undo').get() as { n: number }).n,
  log: (db.prepare('SELECT COUNT(*) AS n FROM combat_log').get() as { n: number }).n,
});

describe('stabilising a party ally with no sheet', () => {
  it('ends its death saves through condition {op: stabilize} with combatant_id', async () => {
    const ally = await join('Sergeant Torvald', 'party');
    knockDown(ally);
    await strike(goblinId(), ally, '1');
    const client = await connect();

    const answer = await stabilise(client, { combatant_id: ally, source: "Borg's healer's kit" });

    expect(answer.isError).toBeFalsy();
    expect(textOf(answer)).toContain("Sergeant Torvald is stabilised by Borg's healer's kit");
    expect(row(ally).flags.stable).toBe(true);
    expect(row(ally).death_saves).toEqual({ successes: 0, failures: 0 });
    const quiet = await turnOf(ally);
    expect(quiet.log.some((entry) => entry.kind === 'death_save' && entry.actor_id === ally)).toBe(false);
    await client.close();
  });

  it('names the ally stable in the DM view and in its death-save hint', async () => {
    const ally = await join('Sergeant Torvald', 'party');
    knockDown(ally);
    expect(legalActions(row(ally), null)[0]!.hint).toMatch(/^Rolled automatically at the start of Sergeant Torvald's turn/);
    const client = await connect();

    const answer = await stabilise(client, { combatant_id: ally, source: "Borg's healer's kit" });

    expect(answer.isError).toBeFalsy();
    expect(textOf(answer)).toMatch(/Sergeant Torvald #\d+: [^\n]*\bstable\b/);
    expect(legalActions(row(ally), null)).toEqual([
      {
        id: 'death_save',
        label: 'Death saving throw',
        hint: 'Stable at 0 HP: no death saves until it takes damage; healing wakes it.',
      },
    ]);
    await client.close();
  });

  it('is taken back by undo, and the death saves resume', async () => {
    const ally = await join('Sergeant Torvald', 'party');
    knockDown(ally);
    await strike(goblinId(), ally, '1');

    stabilizeCombatant(db, { campaign_id: campaignId, combatant_id: ally });
    expect(row(ally).flags.stable).toBe(true);
    undoLastCombatAction(db, campaignId);

    expect(row(ally).flags.stable).toBeUndefined();
    expect(row(ally).death_saves).toEqual({ successes: 0, failures: 1 });
    const turn = await turnOf(ally);
    expect(turn.log.some((entry) => entry.kind === 'death_save' && entry.actor_id === ally)).toBe(true);
  });

  it('refuses an enemy, a combatant above 0 HP, a dead ally, a character and no fight, at no cost', async () => {
    const foe = await join('Hostile Guard', 'enemy');
    const standing = await join('Corporal Ana', 'party');
    const fallen = await join('Sergeant Torvald', 'party');
    await strike(goblinId(), fallen, '22');
    const cases: Array<[number, RegExp]> = [
      [foe, /not on the party's team/],
      [standing, /is at 11 HP and is not dying/],
      [fallen, /already dead/],
      [pcId(), /Re-call with character_id \d+ instead of combatant_id/],
    ];
    for (const [id, why] of cases) {
      const before = { row: row(id), ...footprint() };
      expect(() => stabilizeCombatant(db, { campaign_id: campaignId, combatant_id: id })).toThrow(why);
      expect({ row: row(id), ...footprint() }).toEqual(before);
    }

    endEncounter(db, { campaign_id: campaignId, outcome: 'victory' });
    expect(() => stabilizeCombatant(db, { campaign_id: campaignId, combatant_id: standing })).toThrow(/no active encounter/);
  });

  it('refuses character_id and combatant_id together; with neither it stays on the player character path', async () => {
    const ally = await join('Sergeant Torvald', 'party');
    knockDown(ally);
    const characterId = listCombatants(db, encounter().id).find((c) => c.kind === 'pc')!.character_id!;
    const client = await connect();
    const before = { row: row(ally), ...footprint() };

    const both = await stabilise(client, { combatant_id: ally, character_id: characterId });
    expect(both.isError).toBe(true);
    expect(textOf(both)).toContain('not both');

    // Leaving both out still means the player character, who is on their feet.
    const neither = await stabilise(client, {});
    expect(neither.isError).toBe(true);
    expect(textOf(neither)).toMatch(/Borg is at \d+ HP and is not dying/);

    expect({ row: row(ally), ...footprint() }).toEqual(before);
    await client.close();
  });
});
