import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import {
  awardXp,
  createCharacter,
  levelUp,
  levelUpOptions,
  listCharacterOptions,
  rest,
  type CreateCharacterInput,
} from '../src/core/character.js';
import { readGuide } from '../src/mcp/tools/guide.js';
import { openDb, type Db } from '../src/db/connection.js';
import { advanceTurn, attack, startEncounter, useAction } from '../src/combat/engine.js';
import { combatSheet } from '../src/combat/sheet.js';
import { masteryWeaponOptions, weaponMastery, weaponProperty } from '../src/srd/lookup.js';
import { getBattleState, listCombatants, type BattleState, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const MID_D20 = 0.5;
const hit = { total: 25, natural: 12 };
const miss = { total: 3, natural: 3 };

function fighter(overrides: Partial<CreateCharacterInput> = {}): void {
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
    ...overrides,
  });
}

const arm = (...items: string[]): void => {
  db.prepare('UPDATE character SET inventory_json = ? WHERE campaign_id = ? AND is_pc = 1').run(
    JSON.stringify(items.map((name) => ({ name, qty: 1, equipped: true }))),
    campaignId,
  );
};

/** Puts these weapons under the character's Weapon Mastery, the way a long rest's weapon drills do. */
const master = (...weapons: string[]): void => {
  const row = db.prepare('SELECT id, features_json FROM character WHERE campaign_id = ? AND is_pc = 1').get(campaignId) as {
    id: number;
    features_json: string;
  };
  const features = JSON.parse(row.features_json) as Array<{ name: string; mechanics?: Record<string, unknown> }>;
  const feature = features.find((f) => f.name === 'Weapon Mastery')!;
  feature.mechanics = { ...feature.mechanics, mastery_weapons: weapons };
  db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(features), row.id);
};

async function ambush(enemies = 1): Promise<BattleState> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: enemies }],
  });
  const state = getBattleState(db, campaignId)!;
  const rows = Array.from({ length: 14 }, () => '.'.repeat(60));
  const map: BattleMap = { w: 60, h: 14, rows, features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
  return getBattleState(db, campaignId)!;
}

/** Enemies tough enough to stay standing, so what a hit leaves behind can be read off them. */
const toughen = (): void => {
  db.prepare("UPDATE combatant SET hp_max = 60, hp_current = 60 WHERE team = 'enemy'").run();
};

const combatants = (): Combatant[] => listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
const pcId = (): number => combatants().find((c) => c.kind === 'pc')!.id;
const enemyIds = (): number[] => combatants().filter((c) => c.team === 'enemy').map((c) => c.id);
const combatantById = (id: number): Combatant => combatants().find((c) => c.id === id)!;

/** Plants flags on a combatant the way a mastery hit leaves them, for the ones no monster can grant. */
const setFlags = (id: number, flags: Record<string, unknown>): void => {
  db.prepare('UPDATE combatant SET flags_json = ? WHERE id = ?').run(JSON.stringify(flags), id);
};

/** The damage types this creature shrugs off entirely, as its stat block carries them. */
const immuneTo = (id: number, types: string): void => {
  db.prepare("UPDATE combatant SET stat_block_json = json_set(stat_block_json, '$.damage_immunities', ?) WHERE id = ?").run(
    types,
    id,
  );
};

const place = (id: number, x: number, y: number): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
};

const giveTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  const index = state.combatants.findIndex((c) => c.id === id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, state.encounter.id);
};

const startTurn = (id: number): void => {
  db.prepare(
    'UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?',
  ).run(id);
  giveTurn(id);
};

/** A swing that lands, with the attacker standing right next to its target. */
async function swing(attacker: number, target: number, action: string, extra: Record<string, unknown> = {}) {
  return attack(db, { campaign_id: campaignId, attacker_id: attacker, target_id: target, action_name: action, roll: hit, ...extra });
}

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Mastery', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  Math.random = () => MID_D20;
});

afterEach(() => {
  Math.random = realRandom;
});

// --- 1. the SRD data ----------------------------------------------------------

describe('the weapon mastery data', () => {
  it('reads the mastery property off a weapon, with its rules text', () => {
    expect(weaponMastery('Longsword')).toMatchObject({ index: 'sap', name: 'Sap' });
    expect(weaponMastery('Greataxe')!.name).toBe('Cleave');
    expect(weaponMastery('Dagger')!.name).toBe('Nick');
    expect(weaponMastery('Longbow')!.name).toBe('Slow');
    expect(weaponMastery('Longsword')!.description).toMatch(/Disadvantage on its next attack roll/i);
    // Not every weapon has one, and neither does anything that is not a weapon.
    expect(weaponMastery('Net')).toBeNull();
    expect(weaponMastery('Chain Mail')).toBeNull();
  });

  it('reads a plain weapon property by its index', () => {
    expect(weaponProperty('finesse')).toMatchObject({ index: 'finesse', name: 'Finesse' });
    expect(weaponProperty('Versatile')!.description).toMatch(/two hands/i);
    expect(weaponProperty('sap')).toBeNull(); // a mastery property is not one of these
  });

  it('offers only the weapons with a mastery property the proficiencies cover', () => {
    const rogue = masteryWeaponOptions(['Simple Weapons', 'Longswords', 'Rapiers', 'Shortswords', 'Hand crossbows']);
    expect(rogue).toContain('Longsword');
    expect(rogue).toContain('Dagger');
    expect(rogue).not.toContain('Greataxe');
    expect(masteryWeaponOptions(['Martial Weapons', 'Simple Weapons'])).toContain('Greataxe');
  });
});

// --- 2. choosing the weapons --------------------------------------------------

describe('the Weapon Mastery choice', () => {
  it('lets a level 1 Fighter pick three weapons and carries them onto the sheet', () => {
    const group = (listCharacterOptions({ class: 'Fighter' }).class_detail as { feature_choices: Array<{ feature: string; choose: number; from: string[] }> })
      .feature_choices.find((c) => c.feature === 'Weapon Mastery')!;
    expect(group.choose).toBe(3);
    expect(group.from).toContain('Greataxe');

    fighter({ feature_options: { 'Weapon Mastery': ['Longsword', 'Greataxe', 'Longbow'] } });
    expect(getCharacterSheet(db, campaignId)!.mastery_weapons).toEqual(['Longsword', 'Greataxe', 'Longbow']);
    expect(combatSheet(db, getCharacterSheet(db, campaignId)!.id).mastery_weapons).toEqual([
      'Longsword',
      'Greataxe',
      'Longbow',
    ]);
  });

  it('gives a Wizard no group at all', () => {
    const detail = listCharacterOptions({ class: 'Wizard' }).class_detail as { feature_choices: Array<{ feature: string }> };
    expect(detail.feature_choices.some((c) => c.feature === 'Weapon Mastery')).toBe(false);

    createCharacter(db, {
      campaign_id: campaignId,
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
      spellbook: ['Magic Missile', 'Shield', 'Sleep', 'Detect Magic', 'Alarm', 'Feather Fall'],
    });
    expect(getCharacterSheet(db, campaignId)!.mastery_weapons).toEqual([]);
  });

  it('refuses a weapon the character is not proficient with', () => {
    expect(() =>
      createCharacter(db, {
        campaign_id: campaignId,
        name: 'Nix',
        species: 'Halfling',
        class: 'Rogue',
        background: 'Criminal',
        ability_method: 'standard_array',
        abilities: { str: 8, dex: 15, con: 14, int: 12, wis: 10, cha: 13 },
        ability_bonuses: { dex: 2, con: 1 },
        skill_choices: ['stealth', 'acrobatics', 'perception', 'sleight_of_hand'],
        feature_options: { 'Weapon Mastery': ['Greataxe', 'Dagger'] },
      }),
    ).toThrow(/"Greataxe" is not an option for Weapon Mastery/);
  });

  it('asks a Fighter for one more weapon at the level the table gives a fourth', () => {
    fighter({ feature_options: { 'Weapon Mastery': ['Longsword', 'Greataxe', 'Longbow'] } });
    db.prepare('UPDATE character SET level = 3 WHERE campaign_id = ? AND is_pc = 1').run(campaignId);
    const options = levelUpOptions(db, campaignId) as {
      feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
    };
    const group = options.feature_choices!.find((c) => c.feature === 'Weapon Mastery')!;
    expect(group.choose).toBe(1);
    // The three already held are not on offer again.
    expect(group.from).not.toContain('Longsword');
  });

  it('keeps the picks through a level-up and takes the extra one the table gives at 4', () => {
    fighter({ feature_options: { 'Weapon Mastery': ['Longsword', 'Greataxe', 'Longbow'] } });
    awardXp(db, { campaign_id: campaignId, amount: 6500 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', subclass: 'Champion' } });
    expect(getCharacterSheet(db, campaignId)!.mastery_weapons).toEqual(['Longsword', 'Greataxe', 'Longbow']);

    levelUp(db, {
      campaign_id: campaignId,
      choices: { hp: 'average', ability_increases: { str: 2 }, feature_options: { 'Weapon Mastery': ['Rapier'] } },
    });
    expect(getCharacterSheet(db, campaignId)!.mastery_weapons).toEqual(['Longsword', 'Greataxe', 'Longbow', 'Rapier']);

    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    const levelled = getCharacterSheet(db, campaignId)!;
    expect(levelled.level).toBe(5);
    expect(levelled.mastery_weapons).toEqual(['Longsword', 'Greataxe', 'Longbow', 'Rapier']);
  });

  it('swaps the weapons on a long rest, for as many as the feature covers', () => {
    fighter({ feature_options: { 'Weapon Mastery': ['Longsword', 'Greataxe', 'Longbow'] } });
    expect(() => rest(db, { campaign_id: campaignId, kind: 'short', mastery_weapons: ['Rapier'] })).toThrow(
      /swapped by practising through a long rest/,
    );
    expect(() => rest(db, { campaign_id: campaignId, kind: 'long', mastery_weapons: ['Rapier', 'Club'] })).toThrow(
      /covers 3 different weapons; got 2/,
    );
    expect(() =>
      rest(db, { campaign_id: campaignId, kind: 'long', mastery_weapons: ['Rapier', 'Club', 'Chain Mail'] }),
    ).toThrow(/"Chain Mail" is not a weapon Borg is proficient with/);
    // A refused swap leaves the picks alone, and the rest it was part of never happened.
    expect(getCharacterSheet(db, campaignId)!.mastery_weapons).toEqual(['Longsword', 'Greataxe', 'Longbow']);

    const swapped = rest(db, { campaign_id: campaignId, kind: 'long', mastery_weapons: ['Rapier', 'Club', 'Quarterstaff'] });
    expect(swapped.mastery_weapons).toEqual(['Rapier', 'Club', 'Quarterstaff']);
    expect(getCharacterSheet(db, campaignId)!.mastery_weapons).toEqual(['Rapier', 'Club', 'Quarterstaff']);
  });
});

// --- 3. the properties in the engine ------------------------------------------

describe('mastery in a fight', () => {
  beforeEach(() => {
    fighter();
  });

  it('grazes for the ability modifier on a miss, and only for a weapon under mastery', async () => {
    arm('Greatsword');
    master('Greatsword');
    await ambush();
    toughen();
    const [pc, goblin] = [pcId(), enemyIds()[0]!];
    place(pc, 5, 5);
    place(goblin, 6, 5);
    giveTurn(pc);
    const grazed = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: goblin,
      action_name: 'Greatsword',
      roll: miss,
    });
    expect(grazed.hit).toBe(false);
    // STR 17: the miss still deals 3 slashing damage, with no roll.
    expect(grazed.mastery).toMatchObject({ property: 'Graze', damage: { applied: 3, type: 'slashing' } });
    expect(grazed.log.some((e) => e.text.includes('grazes'))).toBe(true);

    // The same weapon without the mastery does nothing on a miss.
    master('Longsword');
    startTurn(pc);
    const plain = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: goblin,
      action_name: 'Greatsword',
      roll: miss,
    });
    expect(plain.mastery).toBeUndefined();
  });

  it('pushes the target 10 ft on a hit, and leaves it standing with no_push', async () => {
    arm('Warhammer');
    master('Warhammer');
    await ambush();
    toughen();
    const [pc, goblin] = [pcId(), enemyIds()[0]!];
    place(pc, 5, 5);
    place(goblin, 6, 5);
    giveTurn(pc);
    const shoved = await swing(pc, goblin, 'Warhammer');
    expect(shoved.mastery).toMatchObject({ property: 'Push', pushed_ft: 10 });
    expect(combatantById(goblin).x).toBe(8);

    place(goblin, 6, 5);
    startTurn(pc);
    const held = await swing(pc, goblin, 'Warhammer', { no_push: true });
    expect(held.mastery).toEqual({ property: 'Push' });
    expect(combatantById(goblin).x).toBe(6);
  });

  it('saps the target: disadvantage on its next attack, spent there and gone by the attacker’s turn', async () => {
    arm('Longsword');
    master('Longsword');
    await ambush();
    toughen();
    const [pc, goblin] = [pcId(), enemyIds()[0]!];
    place(pc, 5, 5);
    place(goblin, 6, 5);
    giveTurn(pc);
    const sapped = await swing(pc, goblin, 'Longsword');
    expect(sapped.mastery).toMatchObject({ property: 'Sap', sapped: true });
    expect(combatantById(goblin).flags.sapped_by).toEqual({ attacker_id: pc });

    giveTurn(goblin);
    const back = await attack(db, {
      campaign_id: campaignId,
      attacker_id: goblin,
      target_id: pc,
      action_name: 'Scimitar',
      roll: miss,
    });
    expect(back.advantage).toBe('disadvantage');
    expect(back.notes.join()).toMatch(/sapped/);
    // Spent on that one roll.
    expect(combatantById(goblin).flags.sapped_by).toBeUndefined();
  });

  it('clears Sap at the start of the attacker’s next turn when nobody spent it', async () => {
    arm('Longsword');
    master('Longsword');
    await ambush();
    toughen();
    const [pc, goblin] = [pcId(), enemyIds()[0]!];
    place(pc, 5, 5);
    place(goblin, 6, 5);
    giveTurn(pc);
    await swing(pc, goblin, 'Longsword');
    expect(combatantById(goblin).flags.sapped_by).toBeDefined();

    await advanceTurn(db, campaignId);
    expect(combatantById(goblin).flags.sapped_by).toBeDefined();
    const round = await advanceTurn(db, campaignId);
    expect(combatantById(goblin).flags.sapped_by).toBeUndefined();
    expect(round.log.some((e) => e.text.includes('shakes off the Sap'))).toBe(true);
  });

  it('slows the target by 10 ft until the attacker’s next turn', async () => {
    arm('Club');
    master('Club');
    await ambush();
    toughen();
    const [pc, goblin] = [pcId(), enemyIds()[0]!];
    place(pc, 5, 5);
    place(goblin, 6, 5);
    giveTurn(pc);
    const slowed = await swing(pc, goblin, 'Club');
    expect(slowed.mastery).toMatchObject({ property: 'Slow', slowed_ft: 10 });
    const speed = combatantById(goblin).speed;

    await advanceTurn(db, campaignId);
    expect(combatantById(goblin).movement_left).toBe(speed - 10);
    const back = await advanceTurn(db, campaignId);
    expect(combatantById(goblin).flags.slowed_by).toBeUndefined();
    expect(back.log.some((e) => e.text.includes('full speed back'))).toBe(true);
  });

  it('topples the target onto its back when it fails the CON save', async () => {
    arm('Quarterstaff');
    master('Quarterstaff');
    await ambush();
    toughen();
    const [pc, goblin] = [pcId(), enemyIds()[0]!];
    place(pc, 5, 5);
    place(goblin, 6, 5);
    giveTurn(pc);
    /** The save bonus off the goblin's own stat block, so the outcome is the test's to decide. */
    const conSave = (bonus: number): void => {
      db.prepare("UPDATE combatant SET stat_block_json = json_set(stat_block_json, '$.saves.con', ?) WHERE id = ?").run(
        bonus,
        goblin,
      );
    };

    conSave(-30);
    const toppled = await swing(pc, goblin, 'Quarterstaff');
    // DC 8 + STR 3 + proficiency 2.
    expect(toppled.mastery).toMatchObject({ property: 'Topple', prone: true, save: { ability: 'con', dc: 13 } });
    expect(combatantById(goblin).conditions).toContain('prone');

    conSave(30);
    startTurn(pc);
    const steady = await swing(pc, goblin, 'Quarterstaff');
    expect(steady.mastery).toMatchObject({ property: 'Topple', save: { success: true } });
    expect(steady.mastery!.prone).toBeUndefined();
  });

  it('vexes the target: advantage on the next attack against it, and gone by the end of the next turn', async () => {
    arm('Rapier');
    master('Rapier');
    await ambush();
    toughen();
    const [pc, goblin] = [pcId(), enemyIds()[0]!];
    place(pc, 5, 5);
    place(goblin, 6, 5);
    giveTurn(pc);
    const vexed = await swing(pc, goblin, 'Rapier');
    expect(vexed.mastery).toMatchObject({ property: 'Vex', vex: true });
    expect(combatantById(pc).flags.vex_against).toMatchObject({ target_id: goblin });

    startTurn(pc);
    const again = await swing(pc, goblin, 'Rapier');
    expect(again.advantage).toBe('advantage');
    expect(again.notes.join()).toMatch(/vexed/);

    // Granted again by that hit, it runs out at the end of the attacker's next turn.
    await advanceTurn(db, campaignId);
    await advanceTurn(db, campaignId);
    expect(combatantById(pc).flags.vex_against).toBeDefined();
    const done = await advanceTurn(db, campaignId);
    expect(combatantById(pc).flags.vex_against).toBeUndefined();
    expect(done.log.some((e) => e.text.includes('loses the Advantage Vex gave it'))).toBe(true);
  });

  it('cleaves into a second creature once a turn, without the ability modifier or another attack', async () => {
    arm('Greataxe');
    master('Greataxe');
    await ambush(2);
    toughen();
    const pc = pcId();
    const [first, second] = enemyIds() as [number, number];
    place(pc, 5, 5);
    place(first, 6, 5);
    place(second, 6, 6);
    giveTurn(pc);

    const opening = await swing(pc, first, 'Greataxe');
    expect(opening.mastery).toMatchObject({ property: 'Cleave' });
    expect(opening.cleave_available).toEqual({ targets: [second] });
    expect(opening.attacks_used).toBe(1);

    const cleave = await swing(pc, second, 'Greataxe', { cleave_from: first });
    // 1d12+3 for the first swing, 1d12 for the one that carries on into the second creature.
    expect(opening.damage[0]!.expr).toBe('1d12+3');
    expect(cleave.damage[0]!.expr).toBe('1d12');
    expect(cleave.attacks_used).toBe(1);
    expect(combatantById(pc).flags.cleaved).toBe(true);

    await expect(swing(pc, second, 'Greataxe', { cleave_from: first })).rejects.toThrow(/already cleaved this turn/);
    // And the Attack action is still spent: no third swing.
    await expect(swing(pc, second, 'Greataxe')).rejects.toThrow(/already taken their Action/);
  });

  it('refuses a cleave into a creature that is not beside the first target', async () => {
    // A Halberd cleaves too, and reaches 10 ft: both goblins are in reach, but not beside each other.
    arm('Halberd');
    master('Halberd');
    await ambush(2);
    toughen();
    const pc = pcId();
    const [first, second] = enemyIds() as [number, number];
    place(pc, 5, 5);
    place(first, 6, 5);
    place(second, 7, 3);
    giveTurn(pc);
    const opening = await swing(pc, first, 'Halberd');
    expect(opening.cleave_available).toBeUndefined();
    await expect(swing(pc, second, 'Halberd', { cleave_from: first })).rejects.toThrow(
      /only carries into a creature within 5 ft/,
    );
  });

  it('grants neither Slow nor Vex to a hit that deals no damage, and saps all the same', async () => {
    arm('Club', 'Rapier', 'Longsword');
    master('Club', 'Rapier', 'Longsword');
    await ambush();
    toughen();
    const [pc, goblin] = [pcId(), enemyIds()[0]!];
    place(pc, 5, 5);
    place(goblin, 6, 5);
    // "If you hit a creature and deal damage to it": this one takes none of it.
    immuneTo(goblin, 'bludgeoning, piercing, slashing');
    giveTurn(pc);

    const clubbed = await swing(pc, goblin, 'Club');
    expect(clubbed.total_damage).toBe(0);
    expect(clubbed.mastery).toEqual({ property: 'Slow' });
    expect(combatantById(goblin).flags.slowed_by).toBeUndefined();

    startTurn(pc);
    const stabbed = await swing(pc, goblin, 'Rapier');
    expect(stabbed.mastery).toEqual({ property: 'Vex' });
    expect(combatantById(pc).flags.vex_against).toBeUndefined();

    // Sap asks only for the hit, so it lands on a creature the blade cannot hurt.
    startTurn(pc);
    const cut = await swing(pc, goblin, 'Longsword');
    expect(cut.mastery).toMatchObject({ property: 'Sap', sapped: true });
    expect(combatantById(goblin).flags.sapped_by).toEqual({ attacker_id: pc });
  });

  it('spends the Sap on a spell attack, which rolls at Disadvantage', async () => {
    await ambush();
    toughen();
    const [pc, goblin] = [pcId(), enemyIds()[0]!];
    place(pc, 5, 5);
    place(goblin, 10, 5);
    giveTurn(pc);
    // No monster has mastery to sap with, so the flag is planted the way a Longsword hit leaves it.
    setFlags(pc, { sapped_by: { attacker_id: goblin } });

    const bolt = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: goblin,
      roll: hit,
    });
    const shot = (bolt.targets[0] as { attack: { advantage: string } }).attack;
    expect(shot.advantage).toBe('disadvantage');
    expect(bolt.log.map((e) => e.text).join(' ')).toMatch(/sapped/);
    expect(combatantById(pc).flags.sapped_by).toBeUndefined();
  });

  it('spends the Vex on a spell attack against the creature it was earned on', async () => {
    arm('Rapier');
    master('Rapier');
    await ambush();
    toughen();
    const [pc, goblin] = [pcId(), enemyIds()[0]!];
    place(pc, 5, 5);
    place(goblin, 6, 5);
    giveTurn(pc);
    await swing(pc, goblin, 'Rapier');
    expect(combatantById(pc).flags.vex_against).toMatchObject({ target_id: goblin });

    startTurn(pc);
    place(goblin, 10, 5); // clear of the caster, so only the Vex moves the roll
    const bolt = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: goblin,
      roll: hit,
    });
    const shot = (bolt.targets[0] as { attack: { advantage: string } }).attack;
    expect(shot.advantage).toBe('advantage');
    expect(combatantById(pc).flags.vex_against).toBeUndefined();
  });

  it('gives the slowed creature its speed back when the dead attacker’s slot comes round', async () => {
    arm('Longbow');
    master('Longbow');
    await ambush();
    toughen();
    const [pc, goblin] = [pcId(), enemyIds()[0]!];
    place(pc, 5, 5);
    place(goblin, 20, 5);
    giveTurn(pc);
    const shot = await swing(pc, goblin, 'Longbow');
    expect(shot.mastery).toMatchObject({ property: 'Slow', slowed_ft: 10 });
    const speed = combatantById(goblin).speed;

    db.prepare('UPDATE combatant SET hp_current = 0, alive = 0 WHERE id = ?').run(pc);
    await advanceTurn(db, campaignId);
    expect(combatantById(goblin).movement_left).toBe(speed - 10);

    // The archer's turn never comes again, but its slot does, and the window closes with it.
    const back = await advanceTurn(db, campaignId);
    expect(combatantById(goblin).flags.slowed_by).toBeUndefined();
    expect(combatantById(goblin).movement_left).toBe(speed);
    expect(back.log.some((e) => e.text.includes('full speed back'))).toBe(true);
  });

  it('keeps a Vex earned on the attacker’s own turn through the end of that turn', async () => {
    arm('Rapier');
    master('Rapier');
    await ambush();
    toughen();
    const [pc, goblin] = [pcId(), enemyIds()[0]!];
    place(pc, 5, 5);
    place(goblin, 6, 5);
    giveTurn(pc);
    await swing(pc, goblin, 'Rapier');
    expect(combatantById(pc).flags.vex_against).toMatchObject({ target_id: goblin, granted_in_own_turn: true });

    await advanceTurn(db, campaignId);
    expect(combatantById(pc).flags.vex_against).toBeDefined();
  });

  it('runs a Vex earned out of turn out at the end of the attacker’s own turn', async () => {
    arm('Rapier');
    master('Rapier');
    await ambush();
    toughen();
    const [pc, goblin] = [pcId(), enemyIds()[0]!];
    place(pc, 5, 5);
    place(goblin, 6, 5);
    giveTurn(goblin);
    await swing(pc, goblin, 'Rapier', { out_of_turn: true, reason: 'opportunity attack' });
    const vex = combatantById(pc).flags.vex_against;
    expect(vex).toMatchObject({ target_id: goblin });
    expect(vex!.granted_in_own_turn).toBeUndefined();

    // The attacker's own turn in the same round ends it: the Advantage never reaches the next one.
    giveTurn(pc);
    const done = await advanceTurn(db, campaignId);
    expect(combatantById(pc).flags.vex_against).toBeUndefined();
    expect(done.log.some((e) => e.text.includes('loses the Advantage Vex gave it'))).toBe(true);
  });

  it('refuses a cleave that follows no hit of its own, and only inside the turn that hit landed', async () => {
    arm('Greataxe');
    master('Greataxe');
    await ambush(2);
    toughen();
    const pc = pcId();
    const [first, second] = enemyIds() as [number, number];
    place(pc, 5, 5);
    place(first, 6, 5);
    place(second, 6, 6);
    giveTurn(pc);

    // The first call of the turn: nothing has been hit, so there is nothing to carry on from.
    await expect(swing(pc, second, 'Greataxe', { cleave_from: first })).rejects.toThrow(
      /no Cleave to follow up: hit .* with Greataxe first this turn/,
    );

    await swing(pc, first, 'Greataxe');
    const cleave = await swing(pc, second, 'Greataxe', { cleave_from: first });
    expect(cleave.cleave_from).toBe(first);

    // Round the initiative back to the attacker: the opening closed with the turn it was made in.
    for (let i = 0; i < combatants().length; i += 1) await advanceTurn(db, campaignId);
    expect(combatantById(pc).flags.cleave_ready).toBeUndefined();
    await expect(swing(pc, second, 'Greataxe', { cleave_from: first })).rejects.toThrow(/no Cleave to follow up/);
  });

  it('offers no further cleave off the swing that already cleaved', async () => {
    arm('Greataxe');
    master('Greataxe');
    await ambush(3);
    toughen();
    const pc = pcId();
    const [first, second, third] = enemyIds() as [number, number, number];
    place(pc, 5, 5);
    place(first, 6, 5);
    place(second, 6, 6);
    place(third, 5, 6);
    giveTurn(pc);

    const opening = await swing(pc, first, 'Greataxe');
    expect(opening.cleave_available!.targets).toContain(second);
    const cleave = await swing(pc, second, 'Greataxe', { cleave_from: first });
    // The third goblin stands beside the second and in reach, and still gets no offer.
    expect(cleave.cleave_available).toBeUndefined();
    expect(cleave.mastery!.cleave_targets).toBeUndefined();
  });

  it('gives a monster no mastery at all', async () => {
    arm('Longsword');
    master('Longsword');
    await ambush();
    toughen();
    const [pc, goblin] = [pcId(), enemyIds()[0]!];
    place(pc, 5, 5);
    place(goblin, 6, 5);
    giveTurn(goblin);
    const bite = await attack(db, {
      campaign_id: campaignId,
      attacker_id: goblin,
      target_id: pc,
      action_name: 'Scimitar',
      roll: hit,
    });
    expect(bite.mastery).toBeUndefined();
    expect(combatantById(pc).flags.sapped_by).toBeUndefined();
  });
});

// --- 4. the guide -------------------------------------------------------------

describe('the fight guide', () => {
  it('covers the mastery properties and says which one the engine leaves alone', () => {
    const guide = readGuide('combat');
    expect(guide.text).toMatch(/Weapon mastery/);
    expect(guide.text).toMatch(/cleave_from/);
    expect(guide.text).toMatch(/\*\*Nick\*\* is the one the engine does not run/);
  });
});
