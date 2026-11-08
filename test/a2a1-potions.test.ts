// Healing potions through use_action, in a fight and out of one, and Lay On Hands and Divine Spark with no
// fight running: the potion's SRD dice come from dice.ts, one potion leaves the pack, and a refusal costs nothing.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  addItem,
  applyDamage,
  awardXp,
  createCharacter,
  createCompanion,
  levelUp,
  levelUpOptions,
  setCondition,
  type CreateCharacterInput,
  type LevelUpChoices,
} from '../src/core/character.js';
import { startEncounter, undoLastCombatAction, useAction } from '../src/combat/engine.js';
import { FEATURES, resourceState } from '../src/combat/features.js';
import { combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import { XP_THRESHOLDS } from '../src/core/rules.js';
import { classLevelRow, findClass, findMagicItem, findSpecies, HEALING_TIERS, skillChoiceGroups, spellsForClass } from '../src/srd/lookup.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { replyData } from './helpers/reply.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
/** Every die rolls its lowest face; the dice roller turns 0.49 into the top face of a d4 and of a d8. */
const LOWEST = (): number => 0;
const HIGHEST = (): number => 0.49;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Potions', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
});

afterEach(() => {
  Math.random = realRandom;
});

// --- characters ----------------------------------------------------------------

const ABILITIES = { str: 15, dex: 14, con: 13, int: 8, wis: 15, cha: 15 };

const sheetOf = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;

function skillPicks(cls: string): string[] {
  const picks: string[] = [];
  for (const group of skillChoiceGroups(findClass(cls), findSpecies('Human'))) {
    picks.push(...group.from.filter((option) => !picks.includes(option)).slice(0, group.choose));
  }
  return picks;
}

function make(cls: string, name: string): number {
  const data = findClass(cls);
  const casting = data.spellcasting ? classLevelRow(data.index, 1).spellcasting : undefined;
  return createCharacter(db, {
    campaign_id: campaignId,
    name,
    species: 'Human',
    class: cls,
    background: 'Acolyte',
    ability_method: 'manual',
    abilities: ABILITIES,
    ability_bonuses: { wis: 2, cha: 1 },
    skill_choices: skillPicks(cls),
    cantrips: spellsForClass(data.index, 0).slice(0, casting?.cantrips_known ?? 0),
    spells: spellsForClass(data.index, 1).slice(0, casting?.prepared_spells ?? 0),
  } as CreateCharacterInput).character!.id;
}

/** Levels a caster up, taking the first spells on offer at each level. */
function climbTo(id: number, level: number): void {
  awardXp(db, { campaign_id: campaignId, character_id: id, amount: XP_THRESHOLDS[level - 1]! });
  while (sheetOf(id).level < level) {
    const options = levelUpOptions(db, campaignId, id) as {
      spellcasting?: { cantrips_to_add: number; spells_to_add: number; cantrip_options: string[]; spell_options: Record<string, string[]> };
    };
    const spells = sheetOf(id).spells as { cantrips: string[]; known: string[] };
    const choices: LevelUpChoices = { hp: 'average' };
    if (options.spellcasting) {
      choices.cantrips = options.spellcasting.cantrip_options
        .filter((name) => !spells.cantrips.includes(name))
        .slice(0, options.spellcasting.cantrips_to_add);
      choices.spells = Object.values(options.spellcasting.spell_options)
        .flat()
        .filter((name) => !spells.known.includes(name))
        .slice(0, options.spellcasting.spells_to_add);
    }
    levelUp(db, { campaign_id: campaignId, character_id: id, choices });
  }
}

const squire = (): number =>
  createCompanion(db, {
    campaign_id: campaignId,
    name: 'Squire',
    source: { class: 'Fighter', species: 'Human', background: 'Soldier' },
  }).companion!.id;

const hp = (id: number): number => sheetOf(id).hp_current!;
const hpMax = (id: number): number => sheetOf(id).hp_max!;
const conditionsOf = (id: number): string[] => sheetOf(id).conditions as string[];

const potions = (id: number, name = 'Potion of Healing'): number =>
  combatSheet(db, id)
    .inventory.filter((item) => item.name === name)
    .reduce((sum, item) => sum + item.qty, 0);

const give = (id: number, name: string, qty = 1): void => {
  addItem(db, { campaign_id: campaignId, character_id: id, name, qty });
};

const rollsFor = (purpose: string): Array<{ total: number }> =>
  db.prepare('SELECT total FROM roll WHERE campaign_id = ? AND purpose = ? ORDER BY id').all(campaignId, purpose) as Array<{
    total: number;
  }>;

const poolLeft = (id: number, handler: string): number => resourceState(combatSheet(db, id), FEATURES[handler]!)!.left;

// --- the fight -----------------------------------------------------------------

async function ambush(): Promise<void> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: 1 }],
  });
  const state = getBattleState(db, campaignId)!;
  const map: BattleMap = { w: 60, h: 14, rows: Array.from({ length: 14 }, () => '.'.repeat(60)), features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
  let x = 3;
  // Side by side by row id, so the PC and the companion stand 5 ft apart.
  for (const c of [...listCombatants(db, state.encounter.id)].sort((a, b) => a.id - b.id)) {
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, 5, c.id);
    x += 1;
  }
}

const combatants = (): Combatant[] => listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
const byCharacter = (id: number): Combatant => combatants().find((c) => c.character_id === id)!;
const byId = (id: number): Combatant => combatants().find((c) => c.id === id)!;
const logCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM combat_log').get() as { n: number }).n;
const undoCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM combat_undo').get() as { n: number }).n;

const startTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?').run(id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === id),
    state.encounter.id,
  );
};

type Drunk = { healed: number; roll: string; potions_left: number; targets: Array<{ target_id: number; healed: number }> };

const drink = async (actor: number, name: string, extra: Record<string, unknown> = {}): Promise<Drunk> =>
  (await useAction(db, { campaign_id: campaignId, actor_id: actor, action_name: name, ...extra })) as unknown as Drunk;

// --- the MCP tool, for the calls with no fight running ----------------------------

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name: 'use_action', arguments: { campaign_id: campaignId, ...args } });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return replyData<T>(result);
}

type Healed = { action: string; healed: number; hp_current: number; roll?: string; uses_left?: number; potions_left?: number; target?: string };

// --- the tests -------------------------------------------------------------------

describe('the healing potion tiers', () => {
  it('carry the SRD dice of every tier, Supreme Healing included', () => {
    expect(Object.values(HEALING_TIERS).map((tier) => [tier.name, tier.dice, tier.rarity])).toEqual([
      ['Potion of Healing', '2d4+2', 'common'],
      ['Potion of Greater Healing', '4d4+4', 'uncommon'],
      ['Potion of Superior Healing', '8d4+8', 'rare'],
      ['Potion of Supreme Healing', '10d4+20', 'very_rare'],
    ]);
    expect(findMagicItem('Potion of Supreme Healing')).toMatchObject({ name: 'Potion of Supreme Healing', rarity: 'very_rare' });
  });
});

describe('a healing potion in a fight', () => {
  it('spends the Bonus Action, not the Action, and heals with the tier dice rolled by dice.ts', async () => {
    const id = make('fighter', 'Borg');
    give(id, 'Potion of Healing', 2);
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: hpMax(id) - 1 });
    await ambush();
    const pc = byCharacter(id);
    startTurn(pc.id);
    Math.random = LOWEST;
    const drunk = await drink(pc.id, 'Potion of Healing');
    // 2d4+2 with every die on 1: no heal_expr was passed, so the engine read the dice off the tier.
    expect(drunk.healed).toBe(4);
    expect(drunk.roll).toContain('2d4+2');
    expect(byId(pc.id).hp_current).toBe(5);
    expect(hp(id)).toBe(5);
    expect(byId(pc.id).bonus_used).toBe(true);
    expect(byId(pc.id).action_used).toBe(false);
  });

  it('takes one potion off the drinker', async () => {
    const id = make('fighter', 'Borg');
    give(id, 'Potion of Healing', 2);
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: 3 });
    await ambush();
    startTurn(byCharacter(id).id);
    const drunk = await drink(byCharacter(id).id, 'potion of healing');
    expect(potions(id)).toBe(1);
    expect(drunk.potions_left).toBe(1);
  });

  it('is given to a creature within 5 ft from the giver pack, and refused further off', async () => {
    const id = make('fighter', 'Borg');
    const ally = squire();
    give(id, 'Potion of Greater Healing');
    applyDamage(db, { campaign_id: campaignId, character_id: ally, amount: hpMax(ally) - 1 });
    await ambush();
    const pc = byCharacter(id);
    const friend = byCharacter(ally);
    startTurn(pc.id);
    db.prepare('UPDATE combatant SET x = ? WHERE id = ?').run(pc.x + 3, friend.id);
    await expect(drink(pc.id, 'Potion of Greater Healing', { target_id: friend.id })).rejects.toThrow(/15 ft away/);
    expect(potions(id, 'Potion of Greater Healing')).toBe(1);
    db.prepare('UPDATE combatant SET x = ? WHERE id = ?').run(pc.x + 1, friend.id);
    Math.random = LOWEST;
    const given = await drink(pc.id, 'Potion of Greater Healing', { target_id: friend.id });
    expect(given.targets).toEqual([expect.objectContaining({ target_id: friend.id, healed: 8 })]);
    expect(hp(ally)).toBe(Math.min(hpMax(ally), 9));
    expect(potions(id, 'Potion of Greater Healing')).toBe(0);
  });

  it('undo gives back the hit points and the Bonus Action', async () => {
    const id = make('fighter', 'Borg');
    give(id, 'Potion of Healing', 2);
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: hpMax(id) - 1 });
    await ambush();
    const pc = byCharacter(id);
    startTurn(pc.id);
    await drink(pc.id, 'Potion of Healing');
    expect(hp(id)).toBeGreaterThan(1);
    undoLastCombatAction(db, campaignId);
    expect(hp(id)).toBe(1);
    expect(byId(pc.id).hp_current).toBe(1);
    expect(byId(pc.id).bonus_used).toBe(false);
  });

  // undo.ts restores the sheet columns it lists, and inventory_json is not one of them yet.
  it.fails('undo gives the potion back as well', async () => {
    const id = make('fighter', 'Borg');
    give(id, 'Potion of Healing', 2);
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: 3 });
    await ambush();
    startTurn(byCharacter(id).id);
    await drink(byCharacter(id).id, 'Potion of Healing');
    undoLastCombatAction(db, campaignId);
    expect(potions(id)).toBe(2);
  });

  it('refuses, at no cost, a drinker with no such potion or no Bonus Action left', async () => {
    const id = make('fighter', 'Borg');
    give(id, 'Potion of Healing');
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: 3 });
    await ambush();
    const pc = byCharacter(id);
    startTurn(pc.id);
    const [life, logs, undos] = [hp(id), logCount(), undoCount()];
    await expect(drink(pc.id, 'Potion of Superior Healing')).rejects.toThrow(/not carrying a Potion of Superior Healing/);
    db.prepare('UPDATE combatant SET bonus_used = 1 WHERE id = ?').run(pc.id);
    await expect(drink(pc.id, 'Potion of Healing')).rejects.toThrow(/already used their bonus action/);
    expect([hp(id), logCount(), undoCount()]).toEqual([life, logs, undos]);
    expect(potions(id)).toBe(1);
    expect(byId(pc.id).action_used).toBe(false);
  });
});

describe('a healing potion with no fight running', () => {
  it('is drunk off the sheet: rolled once into the dice log, one potion gone', async () => {
    const client = await connect();
    const id = make('fighter', 'Borg');
    give(id, 'Potion of Healing', 2);
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: hpMax(id) - 1 });
    const drunk = await call<Healed>(client, { actor_id: id, action_name: 'Potion of Healing' });
    expect(rollsFor('Potion of Healing')).toEqual([{ total: drunk.healed }]);
    expect(drunk.healed).toBeGreaterThanOrEqual(4);
    expect(drunk.healed).toBeLessThanOrEqual(10);
    expect(hp(id)).toBe(Math.min(hpMax(id), 1 + drunk.healed));
    expect(potions(id)).toBe(1);
    expect(drunk.potions_left).toBe(1);
  });

  it('is given to another character by character id', async () => {
    const client = await connect();
    const id = make('fighter', 'Borg');
    const ally = squire();
    give(id, 'Potion of Healing');
    applyDamage(db, { campaign_id: campaignId, character_id: ally, amount: hpMax(ally) });
    Math.random = LOWEST;
    const given = await call<Healed>(client, { actor_id: id, action_name: 'Potion of Healing', target_id: ally });
    expect(given).toMatchObject({ target: 'Squire', healed: 4 });
    // A character at 0 HP wakes on it.
    expect(hp(ally)).toBe(4);
    expect(conditionsOf(ally)).not.toContain('unconscious');
    expect(potions(id)).toBe(0);
  });

  it('heals 10d4+20 from a Potion of Supreme Healing', async () => {
    const client = await connect();
    const id = make('fighter', 'Borg');
    give(id, 'Potion of Supreme Healing');
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: hpMax(id) - 1 });
    Math.random = HIGHEST;
    const drunk = await call<Healed>(client, { actor_id: id, action_name: 'Potion of Supreme Healing' });
    expect(drunk.healed).toBe(60);
    expect(drunk.roll).toContain('10d4+20');
    expect(hp(id)).toBe(hpMax(id));
    expect(potions(id, 'Potion of Supreme Healing')).toBe(0);
  });

  it('refuses, at no cost, a drinker who carries none', async () => {
    const client = await connect();
    const id = make('fighter', 'Borg');
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: 3 });
    await expect(call(client, { actor_id: id, action_name: 'Potion of Healing' })).rejects.toThrow(/not carrying a Potion of Healing/);
    expect(hp(id)).toBe(hpMax(id) - 3);
    expect(rollsFor('Potion of Healing')).toHaveLength(0);
  });
});

describe('Lay On Hands with no fight running', () => {
  it('pours a chosen amount out of the pool into the Paladin or another character', async () => {
    const client = await connect();
    const id = make('paladin', 'Ada');
    const ally = squire();
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: 4 });
    applyDamage(db, { campaign_id: campaignId, character_id: ally, amount: 4 });
    expect(poolLeft(id, 'paladin-lay-on-hands')).toBe(5);
    const self = await call<Healed>(client, { actor_id: id, action_name: 'lay_on_hands', amount: 3 });
    expect(self).toMatchObject({ action: 'lay_on_hands', healed: 3, uses_left: 2 });
    expect(hp(id)).toBe(hpMax(id) - 1);
    const other = await call<Healed>(client, { actor_id: id, action_name: 'lay_on_hands', target_id: ally, amount: 2 });
    expect(other).toMatchObject({ target: 'Squire', healed: 2, uses_left: 0 });
    expect(hp(ally)).toBe(hpMax(ally) - 2);
    expect(poolLeft(id, 'paladin-lay-on-hands')).toBe(0);
    // More than is left in the pool is refused and spends nothing.
    await expect(call(client, { actor_id: id, action_name: 'lay_on_hands', amount: 1 })).rejects.toThrow(/Lay On Hands left/);
    expect(hp(id)).toBe(hpMax(id) - 1);
  });

  it('spends 5 to end the Poisoned condition, and refuses a target who is not poisoned', async () => {
    const client = await connect();
    const id = make('paladin', 'Ada');
    const ally = squire();
    await expect(
      call(client, { actor_id: id, action_name: 'lay_on_hands', option: 'poison', target_id: ally }),
    ).rejects.toThrow(/Squire is not poisoned/);
    expect(poolLeft(id, 'paladin-lay-on-hands')).toBe(5);
    setCondition(db, { campaign_id: campaignId, character_id: ally, condition: 'poisoned', active: true });
    const life = hp(ally);
    const cured = await call<Healed & { conditions_ended: string[] }>(client, {
      actor_id: id,
      action_name: 'lay_on_hands_poison',
      target_id: ally,
    });
    expect(cured).toMatchObject({ conditions_ended: ['poisoned'], healed: 0, uses_left: 0 });
    expect(conditionsOf(ally)).not.toContain('poisoned');
    expect(hp(ally)).toBe(life);
    expect(poolLeft(id, 'paladin-lay-on-hands')).toBe(0);
  });
});

describe('Divine Spark with no fight running', () => {
  it('spends a Channel Divinity and heals another character with 1d8 + WIS rolled by dice.ts', async () => {
    const client = await connect();
    const id = make('cleric', 'Cyra');
    climbTo(id, 2);
    const ally = squire();
    applyDamage(db, { campaign_id: campaignId, character_id: ally, amount: hpMax(ally) - 1 });
    const left = poolLeft(id, 'cleric-channel-divinity');
    Math.random = HIGHEST;
    const spark = await call<Healed>(client, { actor_id: id, action_name: 'divine_spark', target_id: ally });
    // 8 on the d8, +3 for WIS 17.
    expect(spark).toMatchObject({ action: 'divine_spark', target: 'Squire', healed: 11, uses_left: left - 1 });
    expect(rollsFor('Divine Spark')).toEqual([{ total: 11 }]);
    expect(hp(ally)).toBe(Math.min(hpMax(ally), 12));
    expect(poolLeft(id, 'cleric-channel-divinity')).toBe(left - 1);
  });

  it('refuses, at no cost, the Cleric themselves and the damaging options', async () => {
    const client = await connect();
    const id = make('cleric', 'Cyra');
    climbTo(id, 2);
    const ally = squire();
    const left = poolLeft(id, 'cleric-channel-divinity');
    await expect(call(client, { actor_id: id, action_name: 'divine_spark', target_id: id })).rejects.toThrow(/another creature/);
    await expect(call(client, { actor_id: id, action_name: 'divine_spark_radiant', target_id: ally })).rejects.toThrow(
      /only heals/,
    );
    expect(poolLeft(id, 'cleric-channel-divinity')).toBe(left);
    expect(rollsFor('Divine Spark')).toHaveLength(0);
  });

  it('leaves every other feature refused, naming what does work', async () => {
    const client = await connect();
    const id = make('cleric', 'Cyra');
    climbTo(id, 2);
    const left = poolLeft(id, 'cleric-channel-divinity');
    await expect(call(client, { actor_id: id, action_name: 'turn_undead' })).rejects.toThrow(
      /no active encounter, and turn_undead needs one: call start_encounter.*lay_on_hands, divine_spark or a healing potion/,
    );
    expect(poolLeft(id, 'cleric-channel-divinity')).toBe(left);
  });
});
