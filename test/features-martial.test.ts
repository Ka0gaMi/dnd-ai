import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  awardXp,
  createCharacter,
  createCompanion,
  levelUp,
  levelUpOptions,
  rest,
  sheetExtras,
  type CreateCharacterInput,
  type LevelUpChoices,
} from '../src/core/character.js';
import { legalActions, sheetActions } from '../src/combat/actions.js';
import { advanceTurn, attack, endEncounter, moveToken, startEncounter, useAction } from '../src/combat/engine.js';
import { FEATURES, classFeatures, heldFeatures, resourceState } from '../src/combat/features.js';
import { combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import { classLevelRow, findClass, findSpecies, skillChoiceGroups, spellsForClass } from '../src/srd/lookup.js';
import { openDb, type Db } from '../src/db/connection.js';
import * as srd from '../src/srd/data.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const hit = { total: 30, natural: 12 };
const crit19 = { total: 30, natural: 19 };
const miss = { total: 2, natural: 2 };

const MARTIAL = ['barbarian', 'fighter', 'rogue', 'monk', 'paladin', 'ranger'];

// --- building a character -----------------------------------------------------

interface Options {
  subclass_choice?: unknown;
  ability_score_improvement?: unknown;
  feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
  spellcasting?: { cantrips_to_add: number; spells_to_add: number; cantrip_options: string[]; spell_options: Record<string, string[]> };
}

const sheetOf = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;

function spreadIncrease(abilities: Record<string, { score: number }>): Partial<Record<Ability, number>> {
  const order = (Object.keys(abilities) as Ability[])
    .filter((a) => abilities[a]!.score < 20)
    .sort((a, b) => abilities[a]!.score - abilities[b]!.score);
  return { [order[0]!]: 1, [order[1]!]: 1 };
}

/** Levels a character to the target level, answering whatever each level asks for. */
function climbTo(characterId: number, level: number, subclass: string, picks: Record<string, string[]> = {}): void {
  const owed = XP_THRESHOLDS[level - 1]! - sheetOf(characterId).xp;
  if (owed > 0) awardXp(db, { campaign_id: campaignId, character_id: characterId, amount: owed });
  while (sheetOf(characterId).level < level) {
    const options = levelUpOptions(db, campaignId, characterId) as Options;
    const character = sheetOf(characterId);
    const choices: LevelUpChoices = { hp: 'average' };
    if (options.subclass_choice) choices.subclass = subclass;
    if (options.ability_score_improvement) {
      choices.ability_increases = spreadIncrease(character.abilities as Record<string, { score: number }>);
    }
    if (options.feature_choices) {
      choices.feature_options = Object.fromEntries(
        options.feature_choices.map((spec) => [spec.feature, picks[spec.feature] ?? spec.from.slice(0, spec.choose)]),
      );
    }
    if (options.spellcasting) {
      const spells = character.spells as { cantrips: string[]; known: string[] };
      const pool = Object.values(options.spellcasting.spell_options).flat();
      choices.cantrips = options.spellcasting.cantrip_options
        .filter((name) => !spells.cantrips.includes(name))
        .slice(0, options.spellcasting.cantrips_to_add);
      choices.spells = pool.filter((name) => !spells.known.includes(name)).slice(0, options.spellcasting.spells_to_add);
    }
    levelUp(db, { campaign_id: campaignId, character_id: characterId, choices });
  }
}

const ABILITIES = { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 };

/** The first legal pick of every skill group this class and species ask for, without repeats. */
function skillPicks(cls: string): string[] {
  const picks: string[] = [];
  for (const group of skillChoiceGroups(findClass(cls), findSpecies('Human'))) {
    let taken = 0;
    for (const option of group.from) {
      if (taken >= group.choose) break;
      if (picks.includes(option)) continue;
      picks.push(option);
      taken += 1;
    }
  }
  return picks;
}

function make(input: Partial<CreateCharacterInput> & { class: string; name: string }): number {
  const data = findClass(input.class);
  const casting = data.spellcasting ? classLevelRow(data.index, 1).spellcasting : undefined;
  return createCharacter(db, {
    campaign_id: campaignId,
    species: 'Human',
    background: 'Soldier',
    ability_method: 'manual',
    abilities: ABILITIES,
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: skillPicks(input.class),
    cantrips: spellsForClass(data.index, 0).slice(0, casting?.cantrips_known ?? 0),
    spells: spellsForClass(data.index, 1).slice(0, casting?.prepared_spells ?? 0),
    ...input,
  } as CreateCharacterInput).character!.id;
}

/** A martial player character at the level and subclass named, with the gear it is given. */
function hero(
  cls: string,
  level: number,
  options: {
    subclass?: string;
    abilities?: Partial<typeof ABILITIES>;
    gear?: string[];
    picks?: Record<string, string[]>;
  } = {},
): number {
  const id = make({
    class: cls,
    name: cls,
    abilities: { ...ABILITIES, ...options.abilities },
    ...(options.picks ? { feature_options: options.picks } : {}),
  });
  if (level > 1) climbTo(id, level, options.subclass ?? '', options.picks ?? {});
  arm(id, ...(options.gear ?? ['Longsword']));
  return id;
}

/** A second campaign in the same database, so two builds can be compared side by side. */
function freshCampaign(name: string): void {
  campaignId = createCampaign(db, { name, story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
}

const arm = (id: number, ...items: string[]): void => {
  db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(
    JSON.stringify(items.map((name) => ({ name, qty: 1, equipped: true }))),
    id,
  );
};

// --- the battlefield ----------------------------------------------------------

async function ambush(enemies = 1, creature = 'Goblin Warrior'): Promise<void> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature, count: enemies }],
  });
  const state = getBattleState(db, campaignId)!;
  const rows = Array.from({ length: 14 }, () => '.'.repeat(60));
  const map: BattleMap = { w: 60, h: 14, rows, features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
  // Everyone stands in reach of everyone else, so nothing is refused for distance.
  let x = 3;
  for (const c of listCombatants(db, state.encounter.id)) {
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, 5, c.id);
    x += 1;
  }
  db.prepare("UPDATE combatant SET hp_max = 200, hp_current = 200 WHERE team = 'enemy'").run();
}

const combatants = (): Combatant[] => listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
const pc = (): Combatant => combatants().find((c) => c.kind === 'pc')!;
const foe = (n = 0): Combatant => combatants().filter((c) => c.team === 'enemy')[n]!;
const byId = (id: number): Combatant => combatants().find((c) => c.id === id)!;

const startTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?').run(id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === id),
    state.encounter.id,
  );
};

const swing = (attacker: number, target: number, action: string, extra: Record<string, unknown> = {}) =>
  attack(db, { campaign_id: campaignId, attacker_id: attacker, target_id: target, action_name: action, roll: hit, ...extra });

const use = (actor: number, action: string, extra: Record<string, unknown> = {}) =>
  useAction(db, { campaign_id: campaignId, actor_id: actor, action_name: action, ...extra });

const actionIds = (id: number): string[] => {
  const combatant = byId(id);
  return legalActions(combatant, combatSheet(db, combatant.character_id!)).map((a) => a.id);
};

interface FeatureEffect {
  feature: string;
  damage?: number;
  note?: string;
  save?: { total: number; success: boolean };
  stance?: Record<string, unknown>;
}
const featuresOf = (result: unknown): FeatureEffect[] => (result as { features?: FeatureEffect[] }).features ?? [];
const named = (result: unknown, name: string): FeatureEffect | undefined =>
  featuresOf(result).find((f) => f.feature === name);

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Martial', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

// --- 1. the registry ----------------------------------------------------------

describe('the martial feature registry', () => {
  it('files every handler under an SRD feature index of its own class', () => {
    for (const handler of Object.values(FEATURES)) {
      const entry = srd.features().find((f) => f.index === handler.index);
      expect(entry, handler.index).toBeDefined();
      expect(entry!.class?.index, handler.index).toBe(handler.class);
      expect(entry!.name).toBe(handler.name);
    }
  });

  it('covers every martial class feature the SRD gives, all twenty levels of them', () => {
    // Extra Attack itself is a number on the sheet rather than a handler; its two upgrades are handlers.
    const skip = /subclass|ability score improvement|^extra attack$|weapon mastery|spellcasting/i;
    const missing = srd
      .features()
      .filter((f) => MARTIAL.includes(f.class?.index ?? ''))
      .filter((f) => !skip.test(f.name))
      .filter((f) => FEATURES[f.index] === undefined)
      .map((f) => f.index);
    expect(missing).toEqual([]);
  });

  it('says why each feature the engine does not apply is left to the DM', () => {
    const handed = Object.values(FEATURES).filter((h) => h.dm_applied);
    expect(handed.length).toBeGreaterThan(0);
    for (const handler of handed) expect(handler.dm_applied!.length, handler.index).toBeGreaterThan(20);
  });

  it('matches a character to the handlers it actually holds', () => {
    const id = hero('barbarian', 2);
    const held = heldFeatures(combatSheet(db, id)).map((h) => h.handler.index);
    expect(held).toContain('barbarian-rage');
    expect(held).toContain('barbarian-danger-sense');
    expect(held).not.toContain('rogue-sneak-attack');
    // The same feature name in another class is a different handler.
    expect(held).toContain('barbarian-unarmored-defense');
    expect(held).not.toContain('monk-unarmored-defense');
  });

  it('shows the class features on the sheet with what is left of each', () => {
    const id = hero('fighter', 3, { subclass: 'Champion' });
    const view = classFeatures(combatSheet(db, id));
    const wind = view.find((f) => f.index === 'fighter-second-wind')!;
    expect(wind.uses_left).toBe(2);
    expect(wind.uses_max).toBe(2);
    expect(view.find((f) => f.index === 'champion-improved-critical')).toBeDefined();
  });
});

// --- 2. Barbarian -------------------------------------------------------------

describe('the Barbarian', () => {
  it('rages as a bonus action, spending a use and resisting weapon damage', async () => {
    const id = hero('barbarian', 1, { gear: ['Greataxe'] });
    await ambush();
    startTurn(pc().id);
    const raged = await use(pc().id, 'rage');
    expect(raged.log.some((e) => /rages/i.test(e.text))).toBe(true);
    expect(pc().flags.raging).toBeDefined();
    expect(pc().bonus_used).toBe(true);
    expect(resourceState(combatSheet(db, id), FEATURES['barbarian-rage']!)!.left).toBe(1);
    // Resistance to bludgeoning, piercing and slashing while it runs.
    const hurt = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Scimitar',
      roll: hit,
      out_of_turn: true,
      reason: 'testing the resistance',
    });
    expect(hurt.damage[0]!.resistance).toBe('resistant');
  });

  it('adds its Rage Damage to a Strength attack and nothing else', async () => {
    const id = hero('barbarian', 1, { gear: ['Greataxe'] });
    await ambush();
    startTurn(pc().id);
    const before = await swing(pc().id, foe().id, 'Greataxe');
    expect(named(before, 'Rage')).toBeUndefined();
    startTurn(pc().id);
    await use(pc().id, 'rage');
    const after = await swing(pc().id, foe().id, 'Greataxe');
    expect(named(after, 'Rage')!.damage).toBe(resourceState(combatSheet(db, id), FEATURES['barbarian-rage']!) && 2);
  });

  it('refuses to cast while raging', async () => {
    hero('barbarian', 1, { gear: ['Greataxe'] });
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'rage');
    await expect(use(pc().id, 'Fire Bolt', { spell: 'Fire Bolt', target_id: foe().id })).rejects.toThrow(/raging/i);
  });

  it('drops Concentration when the Rage starts, and holds none while it runs', async () => {
    hero('barbarian', 1, { gear: ['Greataxe'] });
    await ambush();
    startTurn(pc().id);
    // Something hand-written with its own dice, concentrated on: the engine owns the flag either way.
    await use(pc().id, 'Ancestral Chant', {
      target_id: foe().id,
      concentration: true,
      effect: { name: 'shaken', kind: 'buff', tick: 'end' },
    });
    expect(pc().concentration).toEqual({ name: 'Ancestral Chant' });
    startTurn(pc().id);
    const raged = await use(pc().id, 'rage');
    expect(raged.log.some((e) => /cannot concentrate/.test(e.text))).toBe(true);
    expect(pc().concentration).toBeNull();
    // And nothing starts a new one while it runs, spell or not.
    startTurn(pc().id);
    await expect(
      use(pc().id, 'Ancestral Chant', { target_id: foe().id, concentration: true }),
    ).rejects.toThrow(/raging/i);
  });

  it('ends the Rage on a turn that neither attacks nor forces a save', async () => {
    hero('barbarian', 1, { gear: ['Greataxe'] });
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'rage');
    // Round one keeps it: the Rage was entered this round.
    await advanceTurn(db, campaignId);
    expect(pc().flags.raging).toBeDefined();
    // A whole round of the Barbarian doing nothing lets it lapse.
    while (getBattleState(db, campaignId)!.active!.id !== pc().id) await advanceTurn(db, campaignId);
    await advanceTurn(db, campaignId);
    expect(pc().flags.raging).toBeUndefined();
  });

  it('wears Unarmored Defense as 10 plus DEX plus CON', () => {
    const id = hero('barbarian', 1, { gear: ['Greataxe'] });
    const sheet = combatSheet(db, id);
    expect(sheet.ac).toBe(10 + sheet.abilities.dex!.mod + sheet.abilities.con!.mod);
  });

  it('rolls Dexterity saves with Advantage from Danger Sense', async () => {
    hero('barbarian', 2, { gear: ['Greataxe'] });
    await ambush();
    const saved = await use(foe().id, 'Acid Splash', {
      target_id: pc().id,
      damage_expr: '2d6',
      damage_type: 'acid',
      save_ability: 'dex',
      save_dc: 13,
      out_of_turn: true,
      reason: 'testing Danger Sense',
    });
    const save = (saved.targets[0] as { save: { notes: string[] } }).save;
    expect(save.notes.join(' ')).toMatch(/Danger Sense/);
  });

  it('attacks recklessly for Advantage, and is easier to hit for it', async () => {
    hero('barbarian', 2, { gear: ['Greataxe'] });
    await ambush();
    startTurn(pc().id);
    const wild = await swing(pc().id, foe().id, 'Greataxe', { reckless: true });
    expect(wild.advantage).toBe('advantage');
    expect(wild.notes.join(' ')).toMatch(/Reckless Attack/);
    const back = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Scimitar',
      roll: hit,
      out_of_turn: true,
      reason: 'testing Reckless Attack',
    });
    expect(back.notes.join(' ')).toMatch(/recklessly/);
  });

  it('moves 10 ft faster out of heavy armour at level 5', () => {
    const slow = combatSheet(db, hero('barbarian', 1, { gear: ['Greataxe'] })).speed;
    freshCampaign('Faster');
    const quick = combatSheet(db, hero('barbarian', 5, { subclass: 'Path of the Berserker', gear: ['Greataxe'] }));
    expect(quick.speed).toBe(slow + 10);
    expect(quick.speed_reason).toMatch(/Fast Movement/);
  });

  it('roars into a Frenzy on a reckless hit while raging', async () => {
    hero('barbarian', 3, { subclass: 'Path of the Berserker', gear: ['Greataxe'] });
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'rage');
    const first = await swing(pc().id, foe().id, 'Greataxe', { reckless: true });
    expect(named(first, 'Frenzy')!.damage).toBeGreaterThan(0);
    // Once on a turn, and no more.
    db.prepare('UPDATE combatant SET action_used = 0 WHERE id = ?').run(pc().id);
    const second = await swing(pc().id, foe().id, 'Greataxe');
    expect(named(second, 'Frenzy')).toBeUndefined();
  });
});

// --- 3. Fighter ---------------------------------------------------------------

describe('the Fighter', () => {
  it('catches its Second Wind as a bonus action and runs out of them', async () => {
    const id = hero('fighter', 1);
    await ambush();
    db.prepare('UPDATE character SET hp_current = 1 WHERE id = ?').run(id);
    startTurn(pc().id);
    const wind = await use(pc().id, 'second_wind');
    expect((wind as { healed?: number }).healed).toBeGreaterThan(0);
    expect(resourceState(combatSheet(db, id), FEATURES['fighter-second-wind']!)!.left).toBe(1);
    startTurn(pc().id);
    await use(pc().id, 'second_wind');
    startTurn(pc().id);
    await expect(use(pc().id, 'second_wind')).rejects.toThrow(/Second Wind left/i);
  });

  it('surges for a second action in the same turn', async () => {
    hero('fighter', 2);
    await ambush();
    startTurn(pc().id);
    await swing(pc().id, foe().id, 'Longsword');
    await expect(swing(pc().id, foe().id, 'Longsword')).rejects.toThrow(/already taken their Action/i);
    await use(pc().id, 'action_surge');
    const again = await swing(pc().id, foe().id, 'Longsword');
    expect(again.hit).toBe(true);
  });

  it('will not spend the surged action on a spell', async () => {
    hero('fighter', 2);
    await ambush();
    startTurn(pc().id);
    await swing(pc().id, foe().id, 'Longsword');
    await use(pc().id, 'action_surge');
    expect(pc().flags.surge_action_pending).toBe(true);
    await expect(use(pc().id, 'Fire Bolt', { spell: 'Fire Bolt', target_id: foe().id })).rejects.toThrow(
      /Action Surge/i,
    );
    // Any other action is what the surge was for, and taking it clears the bar.
    const again = await swing(pc().id, foe().id, 'Longsword');
    expect(again.hit).toBe(true);
    expect(pc().flags.surge_action_pending).toBeUndefined();
  });

  it('crits on a 19 with Improved Critical, and nobody else does', async () => {
    hero('fighter', 3, { subclass: 'Champion' });
    await ambush();
    startTurn(pc().id);
    const champion = await swing(pc().id, foe().id, 'Longsword', { roll: crit19 });
    expect(champion.critical).toBe(true);
    freshCampaign('No Champion');
    hero('fighter', 1);
    await ambush();
    startTurn(pc().id);
    const plain = await swing(pc().id, foe().id, 'Longsword', { roll: crit19 });
    expect(plain.critical).toBe(false);
  });

  it('adds the Archery Fighting Style to ranged attack rolls', () => {
    const without = combatSheet(db, hero('fighter', 1, { picks: { 'Fighting Style': ['Defense'] }, gear: ['Shortbow'] }));
    freshCampaign('Archers');
    const withArchery = combatSheet(db, hero('fighter', 1, { picks: { 'Fighting Style': ['Archery'] }, gear: ['Shortbow'] }));
    const toHit = (sheet: ReturnType<typeof combatSheet>): number =>
      Number(/([+-]\d+) to hit/.exec(sheetActions(sheet).find((a) => a.name === 'Shortbow')!.text)![1]);
    expect(toHit(withArchery) - toHit(without)).toBe(2);
  });

  it('lifts every 1 and 2 on a two-handed damage die to a 3 with Great Weapon Fighting', async () => {
    // A die that always rolls its lowest face, so the floor is the whole of the difference.
    Math.random = () => 0;
    hero('fighter', 1, { picks: { 'Fighting Style': ['Defense'] }, gear: ['Greatsword'] });
    await ambush();
    startTurn(pc().id);
    const plain = await swing(pc().id, foe().id, 'Greatsword');
    freshCampaign('Great Weapons');
    hero('fighter', 1, { picks: { 'Fighting Style': ['Great Weapon Fighting'] }, gear: ['Greatsword'] });
    await ambush();
    startTurn(pc().id);
    const heavy = await swing(pc().id, foe().id, 'Greatsword');
    // 2d6 of ones become two threes: four more damage.
    expect(heavy.damage[0]!.applied - plain.damage[0]!.applied).toBe(4);
  });

  it('offers only the four Fighting Style feats the SRD carries', () => {
    const styles = srd.feats().filter((f) => f.type === 'fighting-style').map((f) => f.name);
    expect(styles.sort()).toEqual(['Archery', 'Defense', 'Great Weapon Fighting', 'Two Weapon Fighting']);
  });
});

// --- 4. Rogue -----------------------------------------------------------------

describe('the Rogue', () => {
  const rogue = (level = 1, subclass = 'Thief') =>
    hero('rogue', level, {
      subclass,
      gear: ['Rapier'],
      abilities: { str: 10, dex: 15 },
    });

  it('sneaks its attack in when the roll had Advantage, once a turn', async () => {
    rogue();
    await ambush();
    startTurn(pc().id);
    const first = await swing(pc().id, foe().id, 'Rapier', { advantage: 'advantage' });
    const sneak = named(first, 'Sneak Attack')!;
    expect(sneak.damage).toBeGreaterThan(0);
    // The same turn, with the Action given back: the once-a-turn flag is what refuses the second one.
    db.prepare('UPDATE combatant SET action_used = 0 WHERE id = ?').run(pc().id);
    const second = await swing(pc().id, foe().id, 'Rapier', { advantage: 'advantage' });
    expect(named(second, 'Sneak Attack')).toBeUndefined();
  });

  it('sneaks again on an opportunity attack during somebody else`s turn', async () => {
    rogue();
    await ambush();
    startTurn(pc().id);
    const own = await swing(pc().id, foe().id, 'Rapier', { advantage: 'advantage' });
    expect(named(own, 'Sneak Attack')!.damage).toBeGreaterThan(0);
    expect(pc().flags.sneak_attack_used).toBe(true);
    // The turn boundary gives every once-a-turn feature back, on every combatant.
    await advanceTurn(db, campaignId);
    expect(pc().flags.sneak_attack_used).toBeUndefined();
    const opportunity = await swing(pc().id, foe().id, 'Rapier', {
      advantage: 'advantage',
      out_of_turn: true,
      reason: 'opportunity attack as the goblin flees',
    });
    expect(named(opportunity, 'Sneak Attack')!.damage).toBeGreaterThan(0);
  });

  it('leaves Sneak Attack alone without Advantage and without an ally crowding the target', async () => {
    rogue();
    await ambush();
    startTurn(pc().id);
    const plain = await swing(pc().id, foe().id, 'Rapier');
    expect(named(plain, 'Sneak Attack')).toBeUndefined();
  });

  it('keeps the die back when the player says so', async () => {
    rogue();
    await ambush();
    startTurn(pc().id);
    const held = await swing(pc().id, foe().id, 'Rapier', { advantage: 'advantage', sneak_attack: false });
    expect(named(held, 'Sneak Attack')).toBeUndefined();
    expect(pc().flags.sneak_attack_used).toBeUndefined();
  });

  it('will not sneak with a weapon that is neither Finesse nor ranged', async () => {
    hero('rogue', 1, { subclass: 'Thief', gear: ['Mace'], abilities: { str: 10, dex: 15 } });
    await ambush();
    startTurn(pc().id);
    const clubbed = await swing(pc().id, foe().id, 'Mace', { advantage: 'advantage' });
    expect(named(clubbed, 'Sneak Attack')).toBeUndefined();
  });

  it('dashes as a bonus action with Cunning Action', async () => {
    rogue(2);
    await ambush();
    startTurn(pc().id);
    const before = pc().movement_left;
    const dashed = await use(pc().id, 'cunning_action_dash');
    expect((dashed as { movement_left?: number }).movement_left).toBe(before + pc().speed);
    expect(pc().bonus_used).toBe(true);
    expect(pc().action_used).toBe(false);
  });

  it('steadies its aim for Advantage, at the cost of the turn`s movement', async () => {
    rogue(3);
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'steady_aim');
    expect(pc().movement_left).toBe(0);
    const aimed = await swing(pc().id, foe().id, 'Rapier');
    expect(aimed.advantage).toBe('advantage');
    expect(aimed.notes.join(' ')).toMatch(/Steady Aim/);
  });

  it('refuses Steady Aim to a Rogue who has already moved', async () => {
    rogue(3);
    await ambush();
    startTurn(pc().id);
    moveToken(db, { campaign_id: campaignId, combatant_id: pc().id, to: { x: pc().x, y: 8 } });
    expect(pc().flags.moved_this_turn).toBe(true);
    await expect(use(pc().id, 'steady_aim')).rejects.toThrow(/already moved this turn/i);
    // The next turn of their own gives it back.
    await advanceTurn(db, campaignId);
    while (getBattleState(db, campaignId)!.active!.id !== pc().id) await advanceTurn(db, campaignId);
    expect(pc().flags.moved_this_turn).toBeUndefined();
    await use(pc().id, 'steady_aim');
    expect(pc().flags.steady_aim).toBe(true);
  });

  it('halves a blow with Uncanny Dodge once it has braced for it', async () => {
    rogue(5);
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'uncanny_dodge');
    expect(pc().flags.uncanny_dodge_ready).toBe(true);
    const before = pc().hp_current;
    const hurt = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Scimitar',
      roll: hit,
      out_of_turn: true,
      reason: 'testing Uncanny Dodge',
    });
    expect(hurt.log.some((e) => /Uncanny Dodge halves/.test(e.text))).toBe(true);
    expect(before - byId(pc().id).hp_current).toBe(hurt.damage[0]!.applied);
    expect(pc().flags.uncanny_dodge_ready).toBeUndefined();
  });

  it('halves the Sneak Attack with the rest when it braces with Uncanny Dodge', async () => {
    // Two Rogues: the player character braces, a companion sneak-attacks it.
    rogue(5);
    const sly = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Sly',
      source: { class: 'Rogue', species: 'Human', background: 'Soldier' },
    }).companion!.id;
    arm(sly, 'Rapier');
    await ambush();
    const striker = combatants().find((c) => c.character_id === sly)!;
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(pc().x, pc().y + 1, striker.id);
    // The Rogue can take the damage twice over, so nothing is lost to a floor at 0 HP.
    db.prepare('UPDATE character SET hp_max = 200, hp_current = 200 WHERE id = ?').run(pc().character_id!);
    const sneakAt = async (): Promise<number> => {
      startTurn(striker.id);
      const hurt = await attack(db, {
        campaign_id: campaignId,
        attacker_id: striker.id,
        target_id: pc().id,
        action_name: 'Rapier',
        roll: hit,
        advantage: 'advantage',
      });
      expect(named(hurt, 'Sneak Attack')!.damage).toBeGreaterThan(0);
      return hurt.damage.reduce((sum, d) => sum + d.applied, 0) + named(hurt, 'Sneak Attack')!.damage!;
    };
    const open = await sneakAt();
    // The same swing again, this time against a Rogue who saw it coming.
    while (getBattleState(db, campaignId)!.active!.id !== pc().id) await advanceTurn(db, campaignId);
    await use(pc().id, 'uncanny_dodge');
    const braced = await sneakAt();
    expect(braced).toBe(Math.floor(open / 2));
  });

  it('trades a Sneak Attack die for a Cunning Strike trip', async () => {
    rogue(5);
    await ambush();
    startTurn(pc().id);
    const tripped = await swing(pc().id, foe().id, 'Rapier', { advantage: 'advantage', cunning_strike: ['trip'] });
    expect(named(tripped, 'Sneak Attack')!.note).toMatch(/traded for trip/);
    expect(named(tripped, 'Cunning Strike')).toBeDefined();
  });
});

// --- 5. Monk ------------------------------------------------------------------

describe('the Monk', () => {
  const monk = (level = 1) =>
    hero('monk', level, {
      subclass: 'Warrior of the Open Hand',
      gear: [],
      abilities: { str: 10, dex: 15, wis: 14 },
    });

  it('wears Unarmored Defense as 10 plus DEX plus WIS and strikes with its own die', () => {
    const id = monk();
    const sheet = combatSheet(db, id);
    expect(sheet.ac).toBe(10 + sheet.abilities.dex!.mod + sheet.abilities.wis!.mod);
    const strike = legalActions(
      { ...({} as Combatant), alive: true, hp_current: 1, conditions: [], flags: {}, movement_left: 30, speed: 30, kind: 'pc' } as Combatant,
      sheet,
    );
    expect(strike.some((a) => a.id === 'attack:Unarmed Strike' && /1d6/.test(a.hint))).toBe(true);
    expect(strike.some((a) => a.id === 'bonus:Unarmed Strike (Bonus Action)')).toBe(true);
  });

  it('moves faster out of armour as Unarmored Movement grows', () => {
    const slow = combatSheet(db, monk()).speed;
    freshCampaign('Quicker');
    const quick = combatSheet(db, monk(2));
    expect(quick.speed).toBe(slow + 10);
    expect(quick.speed_reason).toMatch(/Unarmored Movement/);
  });

  it('spends a Focus Point on a Flurry of Blows and throws two free strikes', async () => {
    const id = monk(2);
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'flurry_of_blows');
    expect(pc().flags.flurry_strikes).toBe(2);
    expect(resourceState(combatSheet(db, id), FEATURES['monk-monks-focus']!)!.left).toBe(1);
    const one = await swing(pc().id, foe().id, 'Unarmed Strike', { flurry: true });
    expect(one.hit).toBe(true);
    expect(pc().action_used).toBe(false);
    await swing(pc().id, foe().id, 'Unarmed Strike', { flurry: true });
    await expect(swing(pc().id, foe().id, 'Unarmed Strike', { flurry: true })).rejects.toThrow(/no Flurry of Blows strikes/i);
  });

  it('stuns on a failed save, once a turn, for a Focus Point', async () => {
    const id = monk(5);
    await ambush();
    startTurn(pc().id);
    const stunned = await swing(pc().id, foe().id, 'Unarmed Strike', { stunning_strike: true });
    const strike = named(stunned, 'Stunning Strike')!;
    expect(strike.save).toBeDefined();
    expect(resourceState(combatSheet(db, id), FEATURES['monk-monks-focus']!)!.left).toBe(4);
    await expect(swing(pc().id, foe().id, 'Unarmed Strike', { stunning_strike: true })).rejects.toThrow(/once per turn/i);
  });

  it('takes Patient Defense and Step of the Wind as the bonus actions they are', async () => {
    const id = monk(2);
    const focusLeft = (): number => resourceState(combatSheet(db, id), FEATURES['monk-monks-focus']!)!.left;
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'patient_defense');
    expect(pc().flags.disengaged).toBe(true);
    expect(pc().flags.dodging).toBeUndefined();
    expect(pc().bonus_used).toBe(true);
    expect(pc().action_used).toBe(false);
    expect(focusLeft()).toBe(2);
    // The Focus Point half buys the Dodge as well.
    startTurn(pc().id);
    await use(pc().id, 'patient_defense', { option: 'focus' });
    expect(pc().flags.dodging).toBe(true);
    expect(focusLeft()).toBe(1);
    // Step of the Wind dashes for nothing.
    startTurn(pc().id);
    const before = pc().movement_left;
    const stepped = await use(pc().id, 'step_of_the_wind');
    expect((stepped as { movement_left?: number }).movement_left).toBe(before + pc().speed);
    expect(pc().bonus_used).toBe(true);
    expect(focusLeft()).toBe(1);
    // And for a point it disengages on the way, jump distance doubled.
    startTurn(pc().id);
    const paid = await use(pc().id, 'step_of_the_wind_focus');
    expect(focusLeft()).toBe(0);
    expect((paid as { notes?: string[] }).notes!.join(' ')).toMatch(/jump distance is doubled/);
  });

  it('throws a deflected blow back for a Focus Point, once', async () => {
    const id = monk(3);
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'deflect_attacks');
    const hurt = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Scimitar',
      roll: hit,
      out_of_turn: true,
      reason: 'testing the redirect',
    });
    // 1d10 + DEX + level takes the scimitar to nothing, and that is what opens the redirect.
    expect(hurt.damage.reduce((sum, d) => sum + d.applied, 0)).toBe(0);
    const offer = (hurt as { deflect_redirect_available?: { attacker_id: number; within_ft: number } })
      .deflect_redirect_available;
    expect(offer).toMatchObject({ attacker_id: foe().id, within_ft: 5 });
    const before = byId(foe().id).hp_current;
    await use(pc().id, 'deflect_redirect', {
      target_id: foe().id,
      roll: miss,
      out_of_turn: true,
      reason: 'Deflect Attacks',
    });
    expect(before - byId(foe().id).hp_current).toBeGreaterThan(0);
    expect(resourceState(combatSheet(db, id), FEATURES['monk-monks-focus']!)!.left).toBe(2);
    // The window is spent with it.
    await expect(
      use(pc().id, 'deflect_redirect', { target_id: foe().id, out_of_turn: true, reason: 'again' }),
    ).rejects.toThrow(/no deflected attack/i);
  });

  it('refuses to throw a deflected blow at somebody behind total cover', async () => {
    monk(3);
    await ambush();
    // A shot from across the road: its redirect reaches 60 ft, so only cover can stop it.
    db.prepare('UPDATE combatant SET x = ? WHERE id = ?').run(pc().x + 4, foe().id);
    startTurn(pc().id);
    await use(pc().id, 'deflect_attacks');
    const shot = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Shortbow',
      roll: hit,
      out_of_turn: true,
      reason: 'testing the redirect',
    });
    expect(shot.damage.reduce((sum, d) => sum + d.applied, 0)).toBe(0);
    // A wall between the two: the redirect needs a creature the Monk can see.
    const state = getBattleState(db, campaignId)!;
    const wall = pc().x + 2;
    const rows = state.map.rows.map((row) => `${row.slice(0, wall)}#${row.slice(wall + 1)}`);
    db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(
      JSON.stringify({ ...state.map, rows }),
      state.encounter.id,
    );
    await expect(
      use(pc().id, 'deflect_redirect', { target_id: foe().id, out_of_turn: true, reason: 'Deflect Attacks' }),
    ).rejects.toThrow(/total cover/i);
  });

  it('gives Unarmored Defense to the Monk that holds the feature, not to the class name', () => {
    const id = monk();
    const sheet = combatSheet(db, id);
    const dex = sheet.abilities.dex!.mod;
    const wis = sheet.abilities.wis!.mod;
    expect(sheetExtras(db, campaignId, id).ac_breakdown.total).toBe(10 + dex + wis);
    // A sheet with the feature row stripped out is 10 + DEX, Monk on the class line or not.
    const row = db.prepare('SELECT features_json FROM character WHERE id = ?').get(id) as { features_json: string };
    const kept = (JSON.parse(row.features_json) as Array<{ name: string }>).filter(
      (f) => f.name !== 'Unarmored Defense',
    );
    db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(kept), id);
    expect(sheetExtras(db, campaignId, id).ac_breakdown.total).toBe(10 + dex);
  });

  it('offers Deflect Attacks to the one who was hit', async () => {
    monk(3);
    await ambush();
    const hurt = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Scimitar',
      roll: hit,
      out_of_turn: true,
      reason: 'testing the offer',
    });
    const offers = (hurt as { reactions_available?: Array<{ action: string }> }).reactions_available ?? [];
    expect(offers.map((o) => o.action)).toContain('deflect_attacks');
  });
});

// --- 6. Paladin ---------------------------------------------------------------

describe('the Paladin', () => {
  const paladin = (level = 1) =>
    hero('paladin', level, { subclass: 'Oath of Devotion', gear: ['Longsword'], abilities: { str: 15, cha: 14 } });

  it('lays on hands out of a pool of five times its level', async () => {
    const id = paladin(2);
    await ambush();
    db.prepare('UPDATE character SET hp_current = 1 WHERE id = ?').run(id);
    startTurn(pc().id);
    const healed = await use(pc().id, 'lay_on_hands', { target_id: pc().id, amount: 6 });
    expect((healed as { healed?: number }).healed).toBe(6);
    expect(byId(pc().id).hp_current).toBe(7);
    startTurn(pc().id);
    await expect(use(pc().id, 'lay_on_hands', { target_id: pc().id, amount: 99 })).rejects.toThrow(/Lay On Hands left/i);
  });

  it('readies a smite on a melee hit and burns the free casting on it', async () => {
    const id = paladin(2);
    await ambush();
    startTurn(pc().id);
    const struck = await swing(pc().id, foe().id, 'Longsword');
    expect((struck as { smite_ready?: { target_id: number } }).smite_ready!.target_id).toBe(foe().id);
    const before = byId(foe().id).hp_current;
    // The smite is a Bonus Action in 2024, so the Attack action the hit came from is no obstacle.
    expect(pc().action_used).toBe(true);
    const smite = await use(pc().id, 'Divine Smite', { spell: 'Divine Smite' });
    expect(before - byId(foe().id).hp_current).toBeGreaterThan(0);
    expect(smite.log.some((e) => /costs no spell slot/.test(e.text))).toBe(true);
    expect(resourceState(combatSheet(db, id), FEATURES['paladin-paladins-smite']!)!.left).toBe(0);
    expect(pc().flags.smite_ready).toBeUndefined();
    // It spent the bonus action, and there is only one of those.
    expect(pc().bonus_used).toBe(true);
    await swing(pc().id, foe().id, 'Longsword', { out_of_turn: true, reason: 'setting a second smite up' });
    await expect(use(pc().id, 'Divine Smite', { spell: 'Divine Smite', slot_level: 1 })).rejects.toThrow(
      /already used their bonus action/i,
    );
  });

  it('casts Sacred Weapon on the Attack action rather than spending one', async () => {
    const id = paladin(3);
    await ambush();
    startTurn(pc().id);
    const struck = await swing(pc().id, foe().id, 'Longsword', { sacred_weapon: true });
    expect(struck.hit).toBe(true);
    // The Channel Divinity went on the blessing, and the swing itself still happened.
    expect(resourceState(combatSheet(db, id), FEATURES['paladin-channel-divinity']!)!.left).toBe(1);
    expect(pc().flags.sacred_weapon).toMatchObject({ weapon: 'Longsword', bonus: 2 });
    // Item 11: the fight log and the roll notes both name it on the attack it helps.
    expect(struck.notes.join(' ')).toMatch(/Sacred Weapon/);
    expect(struck.log.some((e) => /sanctifies Longsword/.test(e.text))).toBe(true);
    // It is not an action of its own any more.
    expect(actionIds(pc().id)).not.toContain('feature:sacred_weapon');
    await expect(use(pc().id, 'sacred_weapon')).rejects.toThrow(/no class feature action called/i);
  });

  it('lets the Sacred Weapon blessing run out after its ten minutes', async () => {
    paladin(3);
    await ambush();
    startTurn(pc().id);
    await swing(pc().id, foe().id, 'Longsword', { sacred_weapon: true });
    expect(pc().flags.sacred_weapon!.rounds_left).toBe(100);
    // One round off at the end of the paladin's turn, and gone when the clock runs out.
    await advanceTurn(db, campaignId);
    expect(pc().flags.sacred_weapon!.rounds_left).toBe(99);
    const blessed = pc();
    db.prepare('UPDATE combatant SET flags_json = ? WHERE id = ?').run(
      JSON.stringify({ ...blessed.flags, sacred_weapon: { ...blessed.flags.sacred_weapon!, rounds_left: 1 } }),
      blessed.id,
    );
    while (getBattleState(db, campaignId)!.active!.id !== blessed.id) await advanceTurn(db, campaignId);
    const ended = await advanceTurn(db, campaignId);
    expect(ended.log.some((e) => /ten minutes of Sacred Weapon are up/.test(e.text))).toBe(true);
    expect(pc().flags.sacred_weapon).toBeUndefined();
  });

  it('refuses Sacred Weapon on anything but an attack of the Attack action', async () => {
    paladin(3);
    await ambush();
    startTurn(pc().id);
    await expect(
      swing(pc().id, foe().id, 'Longsword', { sacred_weapon: true, out_of_turn: true, reason: 'an opportunity attack' }),
    ).rejects.toThrow(/when you take the Attack action/i);
  });

  it('refuses a smite that follows no melee hit', async () => {
    paladin(2);
    await ambush();
    startTurn(pc().id);
    await expect(use(pc().id, 'Divine Smite', { spell: 'Divine Smite', target_id: foe().id })).rejects.toThrow(
      /after hitting with a melee weapon/i,
    );
  });

  it('lends its Aura of Protection to an ally standing inside it', async () => {
    paladin(6);
    await ambush();
    const saved = await use(foe().id, 'Acid Splash', {
      target_id: pc().id,
      damage_expr: '2d6',
      damage_type: 'acid',
      save_ability: 'dex',
      save_dc: 30,
      out_of_turn: true,
      reason: 'testing the aura',
    });
    const save = (saved.targets[0] as { save: { notes: string[] } }).save;
    expect(save.notes.join(' ')).toMatch(/Aura of Protection/);
  });
});

// --- 7. Ranger ----------------------------------------------------------------

describe('the Ranger', () => {
  const ranger = (level = 1, picks: Record<string, string[]> = {}) =>
    hero('ranger', level, { subclass: 'Hunter', gear: ['Longsword'], picks });

  it("marks its quarry without a slot and hits it for an extra 1d6 force", async () => {
    const id = ranger(1);
    await ambush();
    startTurn(pc().id);
    const marked = await use(pc().id, "Hunter's Mark", { spell: "Hunter's Mark", target_id: foe().id });
    expect(marked.log.some((e) => /costs no spell slot/.test(e.text))).toBe(true);
    expect(resourceState(combatSheet(db, id), FEATURES['ranger-favored-enemy']!)!.left).toBe(1);
    startTurn(pc().id);
    const struck = await swing(pc().id, foe().id, 'Longsword');
    expect(named(struck, "Hunter's Mark")!.damage).toBeGreaterThan(0);
  });

  it('slays a wounded colossus once a turn', async () => {
    ranger(3, { "Hunter's Prey": ['Colossus Slayer'] });
    await ambush();
    db.prepare('UPDATE combatant SET hp_current = 100 WHERE id = ?').run(foe().id);
    startTurn(pc().id);
    const first = await swing(pc().id, foe().id, 'Longsword');
    expect(named(first, 'Colossus Slayer')!.damage).toBeGreaterThan(0);
    db.prepare('UPDATE combatant SET action_used = 0 WHERE id = ?').run(pc().id);
    const second = await swing(pc().id, foe().id, 'Longsword');
    expect(named(second, 'Colossus Slayer')).toBeUndefined();
  });

  it('leaves an unwounded target alone', async () => {
    ranger(3, { "Hunter's Prey": ['Colossus Slayer'] });
    await ambush();
    startTurn(pc().id);
    const first = await swing(pc().id, foe().id, 'Longsword');
    expect(named(first, 'Colossus Slayer')).toBeUndefined();
  });
});

// --- 8. a character without the feature ---------------------------------------

describe('a character who has none of it', () => {
  it('never sees another class`s feature action, and is told what it may take', async () => {
    hero('fighter', 3, { subclass: 'Champion' });
    await ambush();
    startTurn(pc().id);
    const ids = actionIds(pc().id);
    expect(ids).toContain('feature:second_wind');
    expect(ids).not.toContain('feature:rage');
    expect(ids).not.toContain('feature:flurry_of_blows');
    expect(ids).not.toContain('feature:lay_on_hands');
    await expect(use(pc().id, 'rage')).rejects.toThrow();
  });

  it('refuses the attack options its class never had', async () => {
    hero('fighter', 3, { subclass: 'Champion' });
    await ambush();
    startTurn(pc().id);
    await expect(swing(pc().id, foe().id, 'Longsword', { reckless: true })).rejects.toThrow(/no Reckless Attack/i);
    await expect(swing(pc().id, foe().id, 'Longsword', { stunning_strike: true })).rejects.toThrow(/no Stunning Strike/i);
    await expect(swing(pc().id, foe().id, 'Longsword', { cunning_strike: ['trip'] })).rejects.toThrow(/no Cunning Strike/i);
  });

  it('refuses an id-shaped action name it does not know, rather than spending the Action', async () => {
    hero('fighter', 3, { subclass: 'Champion' });
    await ambush();
    startTurn(pc().id);
    await expect(use(pc().id, 'shield_bash', { target_id: foe().id, damage_expr: '1d4' })).rejects.toThrow(
      /no class feature action called/i,
    );
    expect(pc().action_used).toBe(false);
    // Named in words it is the DM's own improvised action, and that still resolves.
    await use(pc().id, 'Shield Bash', { target_id: foe().id, damage_expr: '1d4', damage_type: 'bludgeoning' });
    expect(pc().action_used).toBe(true);
  });

  it('never adds a rider a monster could not have', async () => {
    hero('fighter', 1);
    await ambush();
    const hurt = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Scimitar',
      roll: miss,
      out_of_turn: true,
      reason: 'a plain miss',
    });
    expect(featuresOf(hurt)).toEqual([]);
  });
});

// --- 9. resources across a rest -----------------------------------------------

describe('the rest that puts a feature back', () => {
  it('gives a Rage back on a short rest and all of them on a long one', () => {
    const id = hero('barbarian', 5, { subclass: 'Path of the Berserker', gear: ['Greataxe'] });
    const spend = (n: number): void => {
      const row = db.prepare('SELECT features_json FROM character WHERE id = ?').get(id) as { features_json: string };
      const features = JSON.parse(row.features_json) as Array<{ mechanics?: { resource?: string; used?: number } }>;
      features.find((f) => f.mechanics?.resource === 'rage')!.mechanics!.used = n;
      db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(features), id);
    };
    spend(3);
    rest(db, { campaign_id: campaignId, character_id: id, kind: 'short' });
    expect(resourceState(combatSheet(db, id), FEATURES['barbarian-rage']!)!.used).toBe(2);
    rest(db, { campaign_id: campaignId, character_id: id, kind: 'long' });
    expect(resourceState(combatSheet(db, id), FEATURES['barbarian-rage']!)!.used).toBe(0);
  });

  it('refills a Lay On Hands pool that the registry derives on a long rest', async () => {
    const id = hero('paladin', 3, { subclass: 'Oath of Devotion', gear: ['Longsword'], abilities: { str: 15, cha: 14 } });
    await ambush();
    db.prepare('UPDATE character SET hp_current = 1 WHERE id = ?').run(id);
    startTurn(pc().id);
    await use(pc().id, 'lay_on_hands', { target_id: pc().id, amount: 10 });
    expect(resourceState(combatSheet(db, id), FEATURES['paladin-lay-on-hands']!)!.left).toBe(5);
    // A long rest cannot be taken mid-fight, so the fight ends before the pool is refilled.
    endEncounter(db, { campaign_id: campaignId, outcome: 'retreat' });
    rest(db, { campaign_id: campaignId, character_id: id, kind: 'long' });
    expect(resourceState(combatSheet(db, id), FEATURES['paladin-lay-on-hands']!)!.left).toBe(15);
  });
});
