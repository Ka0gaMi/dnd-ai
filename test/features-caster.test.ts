import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  awardXp,
  checkModifier,
  createCharacter,
  createCompanion,
  grantInspirationDie,
  heldInspirationDie,
  levelUp,
  levelUpOptions,
  rest,
  slotsLeft,
  type CreateCharacterInput,
  type LevelUpChoices,
} from '../src/core/character.js';
import { legalActions } from '../src/combat/actions.js';
import { advanceTurn, attack, startEncounter, undoLastCombatAction, useAction } from '../src/combat/engine.js';
import { FEATURES, classFeatures, pactSlotLevel, resourceState } from '../src/combat/features.js';
import { attacksPerAction, combatSheet, sheetSaveBonus } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, listEffects, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import { classLevelRow, findClass, findSpecies, skillChoiceGroups, spellsForClass } from '../src/srd/lookup.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import * as srd from '../src/srd/data.js';

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const hit = { total: 30, natural: 12 };
const miss = { total: 2, natural: 2 };
const failSave = { total: 1, natural: 1 };

const CASTERS = ['bard', 'cleric', 'druid', 'sorcerer', 'warlock', 'wizard'];

// --- building a caster --------------------------------------------------------

interface Options {
  subclass_choice?: unknown;
  ability_score_improvement?: unknown;
  feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
  spellcasting?: {
    cantrips_to_add: number;
    spells_to_add: number;
    cantrip_options: string[];
    spell_options: Record<string, string[]>;
    spellbook?: { to_add: number; options: Record<string, string[]> };
  };
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
      // The picks are a wish list: what is still on offer comes first, and the rest is filled from the top.
      choices.feature_options = Object.fromEntries(
        options.feature_choices.map((spec) => {
          const wanted = (picks[spec.feature] ?? []).filter((option) => spec.from.includes(option));
          const filled = [...wanted, ...spec.from.filter((option) => !wanted.includes(option))];
          return [spec.feature, filled.slice(0, spec.choose)];
        }),
      );
    }
    if (options.spellcasting) {
      const spells = character.spells as { cantrips: string[]; known: string[]; spellbook?: string[] };
      const pool = Object.values(options.spellcasting.spell_options).flat();
      choices.cantrips = options.spellcasting.cantrip_options
        .filter((name) => !spells.cantrips.includes(name))
        .slice(0, options.spellcasting.cantrips_to_add);
      // A Wizard copies into the spellbook first, and prepares out of what is in it.
      const book = options.spellcasting.spellbook;
      if (book) {
        const held = spells.spellbook ?? [];
        choices.spellbook = Object.values(book.options)
          .flat()
          .filter((name) => !held.includes(name))
          .slice(0, book.to_add);
        choices.spells = [...held, ...choices.spellbook]
          .filter((name) => !spells.known.includes(name))
          .slice(0, options.spellcasting.spells_to_add);
      } else {
        choices.spells = pool.filter((name) => !spells.known.includes(name)).slice(0, options.spellcasting.spells_to_add);
      }
    }
    levelUp(db, { campaign_id: campaignId, character_id: characterId, choices });
  }
}

const ABILITIES = { str: 10, dex: 14, con: 13, int: 15, wis: 15, cha: 15 };

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
    background: 'Acolyte',
    ability_method: 'manual',
    abilities: ABILITIES,
    ability_bonuses: { wis: 2, cha: 1 },
    skill_choices: skillPicks(input.class),
    cantrips: spellsForClass(data.index, 0).slice(0, casting?.cantrips_known ?? 0),
    spells: spellsForClass(data.index, 1).slice(0, casting?.prepared_spells ?? 0),
    ...input,
  } as CreateCharacterInput).character!.id;
}

/** A caster at the level and subclass named, with whatever gear and picks the test wants. */
function caster(
  cls: string,
  level: number,
  options: {
    subclass?: string;
    abilities?: Partial<typeof ABILITIES>;
    gear?: string[];
    picks?: Record<string, string[]>;
    cantrips?: string[];
    spells?: string[];
  } = {},
): number {
  const id = make({
    class: cls,
    name: cls,
    abilities: { ...ABILITIES, ...options.abilities },
    ...(options.picks ? { feature_options: options.picks } : {}),
    ...(options.cantrips ? { cantrips: options.cantrips } : {}),
    ...(options.spells ? { spells: options.spells } : {}),
  });
  if (level > 1) climbTo(id, level, options.subclass ?? '', options.picks ?? {});
  if (options.gear) arm(id, ...options.gear);
  return id;
}

const arm = (id: number, ...items: string[]): void => {
  db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(
    JSON.stringify(items.map((name) => ({ name, qty: 1, equipped: true }))),
    id,
  );
};

const featureRow = (id: number, name: string): { name: string; mechanics?: Record<string, unknown> } | undefined =>
  (JSON.parse(
    (db.prepare('SELECT features_json FROM character WHERE id = ?').get(id) as { features_json: string }).features_json,
  ) as Array<{ name: string; mechanics?: Record<string, unknown> }>).find((f) => f.name === name);

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

const cast = (actor: number, spell: string, extra: Record<string, unknown> = {}) =>
  useAction(db, { campaign_id: campaignId, actor_id: actor, action_name: spell, spell, ...extra });

interface FeatureEffect {
  feature: string;
  damage?: number;
  note?: string;
  save?: { total: number; success: boolean };
  stance?: Record<string, unknown>;
  condition?: string;
}
const featuresIn = (result: unknown): FeatureEffect[] => (result as { features?: FeatureEffect[] }).features ?? [];
const named = (result: unknown, name: string): FeatureEffect | undefined =>
  featuresIn(result).find((f) => f.feature === name);
const texts = (result: unknown): string => (result as { log: Array<{ text: string }> }).log.map((e) => e.text).join('\n');
const actionIds = (id: number): string[] => {
  const combatant = byId(id);
  return legalActions(combatant, combatSheet(db, combatant.character_id!)).map((a) => a.id);
};

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Casters', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

// --- 1. the registry ----------------------------------------------------------

describe('the caster feature registry', () => {
  it('files every handler under an SRD feature index of its own class', () => {
    for (const handler of Object.values(FEATURES)) {
      const entry = srd.features().find((f) => f.index === handler.index);
      expect(entry, handler.index).toBeDefined();
      expect(entry!.class?.index, handler.index).toBe(handler.class);
      expect(entry!.name).toBe(handler.name);
    }
  });

  it('covers every caster class feature the SRD gives, all twenty levels of them', () => {
    const skip = /subclass|ability score improvement|^extra attack$|weapon mastery|spellcasting|pact magic|eldritch invocations/i;
    const missing = srd
      .features()
      .filter((f) => CASTERS.includes(f.class?.index ?? ''))
      .filter((f) => !skip.test(f.name))
      .filter((f) => FEATURES[f.index] === undefined)
      .map((f) => f.index);
    expect(missing).toEqual([]);
  });

  it('keeps Pact Magic and the invocations as handlers of their own', () => {
    expect(FEATURES['warlock-pact-magic']).toBeDefined();
    expect(FEATURES['warlock-eldritch-invocations']).toBeDefined();
  });

  it('refuses a class feature action the character does not have', async () => {
    caster('wizard', 5, { subclass: 'Evoker' });
    await ambush();
    startTurn(pc().id);
    await expect(use(pc().id, 'divine_spark', { target_id: foe().id })).rejects.toThrow(/no class feature action/i);
    expect(actionIds(pc().id)).not.toContain('feature:divine_spark');
  });
});

// --- 2. Bard ------------------------------------------------------------------

describe('the Bard', () => {
  const bard = (level = 1, picks?: Record<string, string[]>) =>
    caster('bard', level, { subclass: 'College of Lore', gear: ['Rapier'], ...(picks ? { picks } : {}) });

  /** A companion beside the bard, so there is somebody to inspire. */
  function squire(): number {
    return createCompanion(db, {
      campaign_id: campaignId,
      name: 'Squire',
      source: { class: 'Fighter', species: 'Human', background: 'Soldier' },
    }).companion!.id;
  }

  it('hands a Bardic Inspiration die to a creature within 60 ft for a Bonus Action and a use', async () => {
    const id = bard(1);
    const help = squire();
    arm(help, 'Longsword');
    await ambush();
    const ally = combatants().find((c) => c.character_id === help)!;
    startTurn(pc().id);
    const given = await use(pc().id, 'bardic_inspiration', { target_id: ally.id });
    expect(given.log.some((e) => /inspires Squire/.test(e.text))).toBe(true);
    expect(pc().bonus_used).toBe(true);
    expect(heldInspirationDie(db, campaignId, help)).toBe(6);
    expect(resourceState(combatSheet(db, id), FEATURES['bard-bardic-inspiration']!)!.left).toBe(2);
  });

  it('refuses to inspire itself or a creature with no sheet', async () => {
    bard(1);
    await ambush();
    startTurn(pc().id);
    await expect(use(pc().id, 'bardic_inspiration', { target_id: pc().id })).rejects.toThrow(/another creature/i);
    await expect(use(pc().id, 'bardic_inspiration', { target_id: foe().id })).rejects.toThrow(/character sheet/i);
  });

  it('adds the die to an attack that would miss, and spends it only when it turns the miss', async () => {
    bard(1);
    const help = squire();
    arm(help, 'Longsword');
    await ambush();
    const ally = combatants().find((c) => c.character_id === help)!;
    startTurn(pc().id);
    await use(pc().id, 'bardic_inspiration', { target_id: ally.id });
    // A swing that misses by more than a d6 can bridge: the die is rolled but not spent.
    startTurn(ally.id);
    const hopeless = await attack(db, {
      campaign_id: campaignId,
      attacker_id: ally.id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: { total: 1, natural: 3 },
      inspiration: true,
    });
    expect(hopeless.hit).toBe(false);
    expect(heldInspirationDie(db, campaignId, help)).toBe(6);
    // One that falls just short: the die turns it and is spent.
    const ac = foe().ac;
    startTurn(ally.id);
    const turned = await attack(db, {
      campaign_id: campaignId,
      attacker_id: ally.id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: { total: ac - 1, natural: 10 },
      inspiration: true,
    });
    expect(turned.hit).toBe(true);
    expect(texts(turned)).toMatch(/Bardic Inspiration/);
    expect(heldInspirationDie(db, campaignId, help)).toBeNull();
  });

  it('refuses the inspiration add-on from somebody holding no die', async () => {
    bard(1);
    await ambush();
    startTurn(pc().id);
    await expect(swing(pc().id, foe().id, 'Rapier', { inspiration: true })).rejects.toThrow(/holding no Bardic Inspiration/i);
  });

  it('adds half the proficiency bonus to a check with no proficiency behind it (Jack of All Trades)', () => {
    const id = bard(2);
    const untrained = checkModifier(db, campaignId, id, { skill: 'survival' });
    expect(untrained.feature_bonus).toBe(1);
    expect(untrained.feature_note).toMatch(/Jack of All Trades/);
    expect(untrained.total_modifier).toBe(untrained.ability_mod + 1);
    // A skill the bard is proficient in already carries the bonus, so it gets nothing from this.
    const proficient = Object.entries(sheetOf(id).skills as Record<string, { proficient: boolean }>).find(
      ([, entry]) => entry.proficient,
    )![0];
    expect(checkModifier(db, campaignId, id, { skill: proficient }).feature_bonus).toBe(0);
  });

  it('carries Jack of All Trades into Initiative, which is a Dexterity check', () => {
    const plain = caster('bard', 1, { subclass: 'College of Lore' });
    const jack = caster('bard', 2, { subclass: 'College of Lore' });
    expect(combatSheet(db, jack).initiative_bonus).toBe(combatSheet(db, plain).initiative_bonus + 1);
  });

  it('buys a use of Bardic Inspiration back with a spell slot (Font of Inspiration)', async () => {
    const id = bard(5);
    const help = squire();
    await ambush();
    const ally = combatants().find((c) => c.character_id === help)!;
    startTurn(pc().id);
    await use(pc().id, 'bardic_inspiration', { target_id: ally.id });
    const spent = resourceState(combatSheet(db, id), FEATURES['bard-bardic-inspiration']!)!.left;
    const back = await use(pc().id, 'font_of_inspiration', { slot_level: 1 });
    expect(texts(back)).toMatch(/level 1 slot/);
    expect(resourceState(combatSheet(db, id), FEATURES['bard-bardic-inspiration']!)!.left).toBe(spent + 1);
    expect(combatSheet(db, id).spell_slots['1']!.used).toBe(1);
  });

  it('cuts an enemy attack roll down with Cutting Words, spending a reaction and a use', async () => {
    const id = bard(3);
    await ambush();
    startTurn(pc().id);
    const declared = await use(pc().id, 'cutting_words', { out_of_turn: true, reason: 'Cutting Words' });
    expect(declared.log.some((e) => /cuts in/.test(e.text))).toBe(true);
    expect(pc().flags.cutting_words_ready).toBeDefined();
    expect(resourceState(combatSheet(db, id), FEATURES['bard-bardic-inspiration']!)!.left).toBe(2);
    const swung = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Scimitar',
      roll: { total: 14, natural: 11 },
      out_of_turn: true,
      reason: 'testing Cutting Words',
    });
    expect(texts(swung)).toMatch(/Cutting Words/);
    expect(swung.roll.total).toBeLessThan(14);
    expect(pc().flags.cutting_words_ready).toBeUndefined();
  });

  it('offers Cutting Words on an attack it watched, and takes three skills and two discoveries', async () => {
    const id = bard(6);
    const lore = featureRow(id, 'Bonus Proficiencies')!;
    expect((lore.mechanics!.options as string[]).length).toBe(3);
    const skills = sheetOf(id).skills as Record<string, { proficient: boolean }>;
    for (const skill of lore.mechanics!.options as string[]) expect(skills[skill]!.proficient).toBe(true);
    const discoveries = featureRow(id, 'Magical Discoveries')!;
    expect((discoveries.mechanics!.options as string[]).length).toBe(2);
    await ambush();
    const watched = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Scimitar',
      roll: hit,
      out_of_turn: true,
      reason: 'testing the offer',
    });
    expect(
      (watched as { reactions_available?: Array<{ action: string }> }).reactions_available?.some(
        (offer) => offer.action === 'cutting_words',
      ),
    ).toBe(true);
  });
});

// --- 3. Cleric ----------------------------------------------------------------

describe('the Cleric', () => {
  const cleric = (level = 1, picks?: Record<string, string[]>) =>
    caster('cleric', level, { subclass: 'Life Domain', gear: ['Mace'], ...(picks ? { picks } : {}) });

  it('takes a Divine Order, and a Thaumaturge adds Wisdom to Arcana and Religion', () => {
    const id = cleric(1, { 'Divine Order': ['Thaumaturge'] });
    expect((featureRow(id, 'Divine Order')!.mechanics!.options as string[])).toEqual(['Thaumaturge']);
    const arcana = checkModifier(db, campaignId, id, { skill: 'arcana' });
    expect(arcana.feature_bonus).toBe(3);
    expect(arcana.feature_note).toMatch(/Thaumaturge/);
    expect(checkModifier(db, campaignId, id, { skill: 'stealth' }).feature_bonus).toBe(0);
  });

  it('trains a Protector in Martial weapons and Heavy armour', () => {
    const id = cleric(1, { 'Divine Order': ['Protector'] });
    const proficiencies = sheetOf(id).proficiencies as { weapons: string[]; armor: string[] };
    expect(proficiencies.weapons).toContain('Martial Weapons');
    expect(proficiencies.armor).toContain('Heavy Armor');
  });

  it('heals with Divine Spark for a Magic action and a Channel Divinity', async () => {
    const id = cleric(2);
    const help = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Squire',
      source: { class: 'Fighter', species: 'Human', background: 'Soldier' },
    }).companion!.id;
    await ambush();
    const ally = combatants().find((c) => c.character_id === help)!;
    db.prepare('UPDATE character SET hp_current = 1 WHERE id = ?').run(help);
    db.prepare('UPDATE combatant SET hp_current = 1 WHERE id = ?').run(ally.id);
    startTurn(pc().id);
    const healed = await use(pc().id, 'divine_spark_heal', { target_id: ally.id });
    expect(texts(healed)).toMatch(/regains \d+ HP/);
    expect(byId(ally.id).hp_current).toBeGreaterThan(1);
    expect(resourceState(combatSheet(db, id), FEATURES['cleric-channel-divinity']!)!.left).toBe(1);
    expect(pc().action_used).toBe(true);
  });

  it('sears with Divine Spark instead, halving the damage on a save', async () => {
    cleric(2);
    await ambush();
    startTurn(pc().id);
    const seared = await use(pc().id, 'divine_spark_radiant', { target_id: foe().id, rolls: { [String(foe().id)]: failSave } });
    expect(texts(seared)).toMatch(/radiant damage/i);
    const hurt = 200 - foe().hp_current;
    expect(hurt).toBeGreaterThan(0);
  });

  it('turns the Undead within 30 ft, and Sear Undead burns the ones that fail', async () => {
    const id = cleric(5);
    await ambush(1, 'Ghoul');
    startTurn(pc().id);
    const turned = await use(pc().id, 'turn_undead', { rolls: { [String(foe().id)]: failSave } });
    expect(texts(turned)).toMatch(/censures the Undead/);
    expect(byId(foe().id).conditions).toContain('frightened');
    expect(byId(foe().id).conditions).toContain('incapacitated');
    expect(texts(turned)).toMatch(/Sear Undead/);
    expect(foe().hp_current).toBeLessThan(200);
    expect(resourceState(combatSheet(db, id), FEATURES['cleric-channel-divinity']!)!.left).toBe(1);
  });

  it('turns the Undead for a fixed minute with no repeat save, and any damage ends it', async () => {
    cleric(2);
    await ambush(1, 'Ghoul');
    startTurn(pc().id);
    await use(pc().id, 'turn_undead', { rolls: { [String(foe().id)]: failSave } });
    const encounterId = getBattleState(db, campaignId)!.encounter.id;
    const turned = listEffects(db, encounterId).filter((e) => e.target_id === foe().id);
    // 1 minute, and nothing the Ghoul rolls shortens it: the SRD gives Turn Undead no repeat save.
    expect(turned.map((e) => e.name).sort()).toEqual(['frightened', 'incapacitated']);
    expect(turned.every((e) => e.ends === 'rounds' && e.remaining_rounds === 10)).toBe(true);
    startTurn(pc().id);
    const jabbed = await use(pc().id, 'a jab with the haft', { target_id: foe().id, damage_expr: '5' });
    expect(texts(jabbed)).toMatch(/no longer turned/);
    expect(byId(foe().id).conditions).not.toContain('frightened');
    expect(byId(foe().id).conditions).not.toContain('incapacitated');
  });

  it('pours Preserve Life into any Bloodied creature within 30 ft, whichever side it is on', async () => {
    cleric(3);
    await ambush();
    db.prepare('UPDATE combatant SET hp_current = 40, hp_max = 100 WHERE id = ?').run(foe().id);
    startTurn(pc().id);
    const poured = await use(pc().id, 'preserve_life', { target_id: foe().id });
    expect(texts(poured)).toMatch(/Preserve Life/);
    expect(foe().hp_current).toBe(50);
  });

  it('refuses Turn Undead when there is nothing undead to censure', async () => {
    const id = cleric(2);
    await ambush();
    startTurn(pc().id);
    await expect(use(pc().id, 'turn_undead')).rejects.toThrow(/no Undead within/i);
    expect(resourceState(combatSheet(db, id), FEATURES['cleric-channel-divinity']!)!.left).toBe(2);
  });

  it('adds Divine Strike to one weapon hit a turn, and nothing to the second', async () => {
    cleric(7, { 'Blessed Strikes': ['Divine Strike'] });
    await ambush();
    startTurn(pc().id);
    const first = await swing(pc().id, foe().id, 'Mace');
    expect(named(first, 'Divine Strike')!.damage).toBeGreaterThan(0);
    startTurn(pc().id);
    // The once-a-turn flag is cleared at the turn boundary, which this test never crosses.
    const again = await swing(pc().id, foe().id, 'Mace');
    expect(named(again, 'Divine Strike')).toBeUndefined();
  });

  it('adds Potent Spellcasting to a Cleric cantrip instead, when that is the option taken', async () => {
    cleric(7, { 'Blessed Strikes': ['Potent Spellcasting'] });
    await ambush();
    startTurn(pc().id);
    const seared = await cast(pc().id, 'Sacred Flame', { target_id: foe().id, rolls: { [String(foe().id)]: failSave } });
    expect(texts(seared)).toMatch(/Potent Spellcasting/);
  });

  it('heals more with Disciple of Life and pours some back with Blessed Healer', async () => {
    const id = cleric(6);
    const help = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Squire',
      source: { class: 'Fighter', species: 'Human', background: 'Soldier' },
    }).companion!.id;
    await ambush();
    const ally = combatants().find((c) => c.character_id === help)!;
    db.prepare('UPDATE character SET hp_current = 1 WHERE id IN (?, ?)').run(help, pc().character_id!);
    db.prepare('UPDATE combatant SET hp_current = 1 WHERE id IN (?, ?)').run(ally.id, pc().id);
    startTurn(pc().id);
    const healed = await cast(pc().id, 'Cure Wounds', { target_id: ally.id, slot_level: 1 });
    expect(texts(healed)).toMatch(/Disciple of Life: \+3/);
    expect(texts(healed)).toMatch(/Blessed Healer: 3/);
    expect(byId(pc().id).hp_current).toBe(4);
    expect(combatSheet(db, id).spell_slots['1']!.used).toBe(1);
  });

  it('pours Preserve Life into the Bloodied, and never above half their hit points', async () => {
    const id = cleric(3);
    await ambush();
    db.prepare('UPDATE character SET hp_current = 1 WHERE id = ?').run(pc().character_id!);
    db.prepare('UPDATE combatant SET hp_current = 1 WHERE id = ?').run(pc().id);
    startTurn(pc().id);
    const poured = await use(pc().id, 'preserve_life');
    expect(texts(poured)).toMatch(/Preserve Life/);
    const after = byId(pc().id);
    expect(after.hp_current).toBe(Math.floor(after.hp_max / 2));
    expect(resourceState(combatSheet(db, id), FEATURES['cleric-channel-divinity']!)!.left).toBe(1);
  });

  it('casts a Cleric spell with no slot through Divine Intervention, once per long rest', async () => {
    const id = cleric(10);
    await ambush();
    startTurn(pc().id);
    const called = await cast(pc().id, 'Cure Wounds', { target_id: pc().id, free_cast: 'divine_intervention' });
    expect(texts(called)).toMatch(/Divine Intervention/);
    expect(combatSheet(db, id).spell_slots['1']!.used).toBe(0);
    startTurn(pc().id);
    await expect(cast(pc().id, 'Cure Wounds', { target_id: pc().id, free_cast: 'divine_intervention' })).rejects.toThrow(
      /Divine Intervention left/i,
    );
  });
});

// --- 4. Druid -----------------------------------------------------------------

describe('the Druid', () => {
  const druid = (level = 2, picks?: Record<string, string[]>) =>
    caster('druid', level, { subclass: 'Circle of the Land', gear: ['Quarterstaff'], ...(picks ? { picks } : {}) });

  it('takes a Primal Order, and a Magician adds Wisdom to Arcana and Nature', () => {
    const id = druid(1, { 'Primal Order': ['Magician'] });
    expect(checkModifier(db, campaignId, id, { skill: 'nature' }).feature_bonus).toBe(3);
    const warden = caster('druid', 1, { picks: { 'Primal Order': ['Warden'] } });
    expect((sheetOf(warden).proficiencies as { armor: string[] }).armor).toContain('Medium Armor');
  });

  it('takes a Beast form, with its statistics, its attacks and temporary hit points', async () => {
    const id = druid(2);
    await ambush();
    startTurn(pc().id);
    const before = { ac: pc().ac, speed: pc().speed };
    const shifted = await use(pc().id, 'wild_shape', { option: 'Wolf' });
    expect(texts(shifted)).toMatch(/shifts into the shape of a Wolf/);
    const wolf = pc();
    expect(wolf.ac).toBe(12);
    expect(wolf.speed).toBe(40);
    expect(wolf.temp_hp).toBe(2);
    expect(wolf.flags.wild_shape!.form).toBe('Wolf');
    expect(actionIds(wolf.id).some((a) => /Bite/i.test(a))).toBe(true);
    expect(pc().bonus_used).toBe(true);
    expect(resourceState(combatSheet(db, id), FEATURES['druid-wild-shape']!)!.left).toBe(1);
    // The battle state shows the Beast it is running on, and the sheet says the feature is active.
    const view = getBattleState(db, campaignId)!.combatants.find((c) => c.id === wolf.id)!;
    expect(view.known).toMatchObject({ cr: 0.25, type: expect.stringMatching(/beast/i) });
    expect(view.class_features.find((f) => f.index === 'druid-wild-shape')!.active).toBe(true);
    expect((shifted as { wild_shape?: { form: string } }).wild_shape).toMatchObject({ form: 'Wolf' });
    // And back out of it, for a Bonus Action and no use at all.
    startTurn(pc().id);
    const back = await use(pc().id, 'wild_shape_revert');
    expect(texts(back)).toMatch(/drops the Wolf form/);
    expect(pc().ac).toBe(before.ac);
    expect(pc().speed).toBe(before.speed);
    expect(pc().flags.wild_shape).toBeUndefined();
  });

  it("refuses a Beast above the level challenge rating, a flier, and anything that is not a Beast", async () => {
    const id = druid(2);
    await ambush();
    startTurn(pc().id);
    await expect(use(pc().id, 'wild_shape', { option: 'Dire Wolf' })).rejects.toThrow(/CR 1/);
    await expect(use(pc().id, 'wild_shape', { option: 'Hawk' })).rejects.toThrow(/Fly Speed/);
    await expect(use(pc().id, 'wild_shape', { option: 'Goblin Warrior' })).rejects.toThrow(/form of a Beast/);
    expect(resourceState(combatSheet(db, id), FEATURES['druid-wild-shape']!)!.left).toBe(2);
  });

  it('drops the Beast form when the Druid is Incapacitated', async () => {
    druid(2);
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'wild_shape', { option: 'Wolf' });
    const druidId = pc().id;
    db.prepare('UPDATE combatant SET conditions_json = ? WHERE id = ?').run(JSON.stringify(['stunned']), druidId);
    while (getBattleState(db, campaignId)!.active!.id !== druidId) await advanceTurn(db, campaignId);
    const ended = await advanceTurn(db, campaignId);
    expect(ended.log.some((e) => /drops the Wolf form/.test(e.text))).toBe(true);
    expect(byId(druidId).flags.wild_shape).toBeUndefined();
  });

  it('casts no spells while shape-shifted', async () => {
    druid(2);
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'wild_shape', { option: 'Wolf' });
    await expect(cast(pc().id, 'Thunderwave', { target_id: foe().id, slot_level: 1 })).rejects.toThrow(/cannot cast spells/i);
  });

  it('trades a spell slot for a use of Wild Shape and back again (Wild Resurgence)', async () => {
    const id = druid(5);
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'wild_shape', { option: 'Wolf' });
    startTurn(pc().id);
    await use(pc().id, 'wild_shape_revert');
    startTurn(pc().id);
    await use(pc().id, 'wild_shape', { option: 'Wolf' });
    expect(resourceState(combatSheet(db, id), FEATURES['druid-wild-shape']!)!.left).toBe(0);
    startTurn(pc().id);
    const bought = await use(pc().id, 'wild_resurgence_shape', { slot_level: 1 });
    expect(texts(bought)).toMatch(/one use of Wild Shape/);
    expect(resourceState(combatSheet(db, id), FEATURES['druid-wild-shape']!)!.left).toBe(1);
    // The other half: a use of Wild Shape for a level 1 slot, once per long rest.
    const slot = await use(pc().id, 'wild_resurgence_slot');
    expect(texts(slot)).toMatch(/level 1 spell slot/);
    // The created slot is a bonus one beside the table's: the burnt one stays spent and there is one more casting.
    const level1 = combatSheet(db, id).spell_slots['1']!;
    expect(level1.used).toBe(1);
    expect(slotsLeft(level1)).toBe(level1.max);
  });

  it("blooms Land's Aid at a point, hurting enemies and healing one ally", async () => {
    const id = druid(3);
    await ambush();
    startTurn(pc().id);
    db.prepare('UPDATE character SET hp_current = 1 WHERE id = ?').run(pc().character_id!);
    db.prepare('UPDATE combatant SET hp_current = 1 WHERE id = ?').run(pc().id);
    const bloom = await use(pc().id, 'lands_aid', { point: { x: foe().x, y: foe().y } });
    expect(texts(bloom)).toMatch(/Land's Aid/);
    expect(texts(bloom)).toMatch(/necrotic damage/i);
    expect(foe().hp_current).toBeLessThan(200);
    expect(byId(pc().id).hp_current).toBeGreaterThan(1);
    expect(resourceState(combatSheet(db, id), FEATURES['druid-wild-shape']!)!.left).toBe(1);
  });

  it('adds Primal Strike or Potent Spellcasting, whichever Elemental Fury took', async () => {
    caster('druid', 7, { subclass: 'Circle of the Land', gear: ['Quarterstaff'], picks: { 'Elemental Fury': ['Primal Strike'] } });
    await ambush();
    startTurn(pc().id);
    const struck = await swing(pc().id, foe().id, 'Quarterstaff');
    expect(named(struck, 'Primal Strike')!.damage).toBeGreaterThan(0);
  });

  it('recovers spell slots on a short rest with Natural Recovery, once per long rest', async () => {
    const id = druid(6);
    db.prepare("UPDATE character SET spell_slots_json = ? WHERE id = ?").run(
      JSON.stringify({ ...combatSheet(db, id).spell_slots, '1': { max: 4, used: 3 } }),
      id,
    );
    const rested = rest(db, { campaign_id: campaignId, character_id: id, kind: 'short', natural_recovery: true });
    expect(rested.spell_slots!['1']!.used).toBeLessThan(3);
    expect(() => rest(db, { campaign_id: campaignId, character_id: id, kind: 'short', natural_recovery: true })).toThrow(
      /already used Natural Recovery/i,
    );
  });

  it("keeps the Poisoned condition off a Druid with Nature's Ward", async () => {
    const id = druid(10);
    expect(classFeatures(combatSheet(db, id)).some((f) => f.index === 'land-natures-ward')).toBe(true);
    await ambush();
    const poisoned = await useAction(db, {
      campaign_id: campaignId,
      actor_id: foe().id,
      action_name: 'Venom',
      target_id: pc().id,
      effect: { name: 'poisoned', kind: 'condition', tick: 'end', ends: 'manual' },
      out_of_turn: true,
      reason: 'testing the ward',
    });
    expect(texts(poisoned)).toMatch(/immune to the poisoned condition/i);
    expect(pc().conditions).not.toContain('poisoned');
  });

  it("keeps Nature's Ward inside a Beast form: the class features come along", async () => {
    druid(10);
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'wild_shape', { option: 'Wolf' });
    const poisoned = await useAction(db, {
      campaign_id: campaignId,
      actor_id: foe().id,
      action_name: 'Venom',
      target_id: pc().id,
      effect: { name: 'poisoned', kind: 'condition', tick: 'end', ends: 'manual' },
      out_of_turn: true,
      reason: 'testing the ward through a Beast form',
    });
    expect(texts(poisoned)).toMatch(/immune to the poisoned condition/i);
    expect(pc().conditions).not.toContain('poisoned');
  });

  it("keeps the Druid's own mental saves inside a Beast form", async () => {
    const id = caster('druid', 2, { subclass: 'Circle of the Land', gear: ['Quarterstaff'], abilities: { wis: 17 } });
    const sheet = combatSheet(db, id);
    expect(sheet.abilities.wis!.score).toBe(19);
    expect(sheetSaveBonus(sheet, 'wis')).toBe(6);
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'wild_shape', { option: 'Wolf' });
    // A Wolf has Wisdom 12; the Druid keeps their own score and their saving throw proficiency.
    const howled = await useAction(db, {
      campaign_id: campaignId,
      actor_id: foe().id,
      action_name: 'A terrible howl',
      target_id: pc().id,
      save_ability: 'wis',
      save_dc: 12,
      out_of_turn: true,
      reason: 'testing the saves a Beast form keeps',
    });
    expect((howled.targets[0] as { save: { bonus: number } }).save.bonus).toBe(6);
  });

  it('casts Find Familiar as a Magic action through Wild Companion, and the familiar joins the fight', async () => {
    const id = druid(2);
    await ambush();
    startTurn(pc().id);
    const called = await cast(pc().id, 'Find Familiar', { free_cast: 'wild_companion', option: 'Owl' });
    expect(texts(called)).toMatch(/Wild Companion/);
    expect(texts(called)).toMatch(/joins the fight/);
    const familiar = combatants().find((c) => /Owl/.test(c.name))!;
    expect(familiar.kind).toBe('companion');
    expect(familiar.team).toBe('party');
    expect(resourceState(combatSheet(db, id), FEATURES['druid-wild-shape']!)!.left).toBe(1);
    expect(pc().action_used).toBe(true);
  });

  it('takes the familiar\'s own sheet back when the casting is undone', async () => {
    const id = druid(2);
    await ambush();
    startTurn(pc().id);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM character WHERE campaign_id = ?').get(campaignId) as { n: number }).n;
    await cast(pc().id, 'Find Familiar', { free_cast: 'wild_companion', option: 'Owl' });
    expect(combatants().some((c) => /Owl/.test(c.name))).toBe(true);
    undoLastCombatAction(db, campaignId);
    expect(combatants().some((c) => /Owl/.test(c.name))).toBe(false);
    // The familiar's character row goes with its token, rather than staying behind in the party.
    expect((db.prepare('SELECT COUNT(*) AS n FROM character WHERE campaign_id = ?').get(campaignId) as { n: number }).n).toBe(
      before,
    );
    expect(resourceState(combatSheet(db, id), FEATURES['druid-wild-shape']!)!.left).toBe(2);
  });

  it('leaves a companion that was already in the fight where it stands when the casting is undone', async () => {
    const id = druid(2);
    const wolfhound = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Wolfhound',
      source: { class: 'Fighter', species: 'Human', background: 'Soldier' },
    }).companion!.id;
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }],
      extra_party: [wolfhound],
    });
    startTurn(pc().id);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM character WHERE campaign_id = ?').get(campaignId) as { n: number }).n;
    await cast(pc().id, 'Find Familiar', { free_cast: 'wild_companion', option: 'Owl' });
    expect(combatants().some((c) => /Owl/.test(c.name))).toBe(true);
    undoLastCombatAction(db, campaignId);
    // Only the conjured one goes back: the companion that was there before it keeps its token and its sheet.
    expect(combatants().some((c) => /Owl/.test(c.name))).toBe(false);
    expect(combatants().some((c) => c.character_id === wolfhound)).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM character WHERE campaign_id = ?').get(campaignId) as { n: number }).n).toBe(
      before,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM character WHERE id = ?').get(wolfhound)).toEqual({ n: 1 });
    expect(resourceState(combatSheet(db, id), FEATURES['druid-wild-shape']!)!.left).toBe(2);
  });

  it('refuses an animal Find Familiar does not offer, and names the ones it does', async () => {
    const id = druid(2);
    await ambush();
    startTurn(pc().id);
    await expect(cast(pc().id, 'Find Familiar', { free_cast: 'wild_companion', option: 'Badger' })).rejects.toThrow(
      /Bat, Cat, Frog/,
    );
    expect(resourceState(combatSheet(db, id), FEATURES['druid-wild-shape']!)!.left).toBe(2);
  });
});

// --- 5. Sorcerer --------------------------------------------------------------

describe('the Sorcerer', () => {
  const sorcerer = (level = 2, metamagic: string[] = ['Quickened Spell', 'Twinned Spell'], picks: Record<string, string[]> = {}) =>
    caster('sorcerer', level, {
      subclass: 'Draconic Sorcery',
      gear: ['Dagger'],
      picks: { Metamagic: metamagic, ...picks },
    });

  it('unleashes Innate Sorcery for a Bonus Action: +1 to the DC and Advantage on its attacks', async () => {
    const id = sorcerer(2);
    await ambush();
    startTurn(pc().id);
    const dc = combatSheet(db, id).spells.save_dc!;
    const unleashed = await use(pc().id, 'innate_sorcery');
    expect(texts(unleashed)).toMatch(/innate sorcery/i);
    expect(pc().flags.innate_sorcery).toBeDefined();
    expect(resourceState(combatSheet(db, id), FEATURES['sorcerer-innate-sorcery']!)!.left).toBe(1);
    const burned = await cast(pc().id, 'Burning Hands', {
      point: { x: foe().x, y: foe().y },
      slot_level: 1,
      rolls: { [String(foe().id)]: failSave },
    });
    expect(texts(burned)).toMatch(new RegExp(`vs DC ${dc + 1}`));
    // And Advantage on a Sorcerer spell attack roll while it runs.
    startTurn(pc().id);
    const bolt = await cast(pc().id, 'Fire Bolt', { target_id: foe().id });
    expect(texts(bolt)).toMatch(/Innate Sorcery/);
  });

  it('lets Innate Sorcery run out after its minute', async () => {
    sorcerer(2);
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'innate_sorcery');
    expect(pc().flags.innate_sorcery!.rounds_left).toBe(10);
    const id = pc().id;
    db.prepare('UPDATE combatant SET flags_json = ? WHERE id = ?').run(
      JSON.stringify({ ...pc().flags, innate_sorcery: { rounds_left: 1 } }),
      id,
    );
    while (getBattleState(db, campaignId)!.active!.id !== id) await advanceTurn(db, campaignId);
    const ended = await advanceTurn(db, campaignId);
    expect(ended.log.some((e) => /Innate Sorcery ends/.test(e.text))).toBe(true);
    expect(byId(id).flags.innate_sorcery).toBeUndefined();
  });

  it('turns a spell slot into Sorcery Points and Sorcery Points back into a slot', async () => {
    const id = sorcerer(5);
    await ambush();
    startTurn(pc().id);
    db.prepare('UPDATE character SET spell_slots_json = ? WHERE id = ?').run(
      JSON.stringify({ ...combatSheet(db, id).spell_slots, '1': { max: 4, used: 0 } }),
      id,
    );
    const points = await use(pc().id, 'font_of_magic_to_points', { slot_level: 1 });
    expect(texts(points)).toMatch(/1 Sorcery Point/);
    expect(combatSheet(db, id).spell_slots['1']!.used).toBe(1);
    const back = await use(pc().id, 'font_of_magic_to_slot', { slot_level: 1 });
    expect(texts(back)).toMatch(/level 1 spell slot/);
    // A created slot is a bonus one: the burnt slot stays spent, and there is one more casting to be had.
    const level1 = combatSheet(db, id).spell_slots['1']!;
    expect(level1.used).toBe(1);
    expect(slotsLeft(level1)).toBe(level1.max);
    // A slot above the level the table allows is refused before anything is spent.
    await expect(use(pc().id, 'font_of_magic_to_slot', { slot_level: 4 })).rejects.toThrow(/level 7 Sorcerer/);
  });

  it('weaves points into a slot with every slot still open, and spends it before the table’s own', async () => {
    const id = sorcerer(5);
    await ambush();
    startTurn(pc().id);
    const before = combatSheet(db, id).spell_slots['1']!;
    expect(before.used).toBe(0);
    // "Transform unexpended Sorcery Points into one spell slot": no expended slot is needed for one.
    const made = await use(pc().id, 'font_of_magic_to_slot', { slot_level: 1 });
    expect(texts(made)).toMatch(/level 1 spell slot/);
    const created = combatSheet(db, id).spell_slots['1']!;
    expect(created.used).toBe(0);
    expect(slotsLeft(created)).toBe(before.max + 1);

    // The created slot goes first, so the table's own are untouched until it is gone.
    startTurn(pc().id);
    await cast(pc().id, 'Burning Hands', {
      point: { x: foe().x, y: foe().y },
      slot_level: 1,
      rolls: { [String(foe().id)]: failSave },
    });
    const spent = combatSheet(db, id).spell_slots['1']!;
    expect(spent.used).toBe(0);
    expect(slotsLeft(spent)).toBe(before.max);

    // And a refused creation costs no Sorcery Points at all.
    const used = () => (featureRow(id, 'Sorcery Points')!.mechanics!.used as number | undefined) ?? 0;
    const points = used();
    startTurn(pc().id);
    await expect(use(pc().id, 'font_of_magic_to_slot', { slot_level: 4 })).rejects.toThrow(/level 7 Sorcerer/);
    expect(used()).toBe(points);
  });

  it('offers the levelled spells when the only slot left is a created one', async () => {
    const id = sorcerer(5);
    await ambush();
    startTurn(pc().id);
    // Every slot the table gave is spent, and one is woven out of Sorcery Points in their place.
    const slots = Object.fromEntries(
      Object.entries(combatSheet(db, id).spell_slots).map(([level, slot]) => [level, { ...slot, used: slot.max }]),
    );
    db.prepare('UPDATE character SET spell_slots_json = ? WHERE id = ?').run(JSON.stringify(slots), id);
    expect(actionIds(pc().id).some((action) => action.startsWith('cast:Burning Hands'))).toBe(false);
    await use(pc().id, 'font_of_magic_to_slot', { slot_level: 1 });
    expect(actionIds(pc().id).some((action) => action.startsWith('cast:Burning Hands'))).toBe(true);
  });

  it('loses a created slot on a long rest, which is what keeps it a bonus one', async () => {
    const id = sorcerer(5);
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'font_of_magic_to_slot', { slot_level: 1 });
    const rested = rest(db, { campaign_id: campaignId, character_id: id, kind: 'long' });
    const level1 = rested.spell_slots!['1']!;
    expect(level1.used).toBe(0);
    expect(slotsLeft(level1)).toBe(level1.max);
  });

  it('refuses a Quickened casting with no slot behind it, and the Sorcery Points stay unspent', async () => {
    const id = sorcerer(5, ['Quickened Spell', 'Careful Spell']);
    await ambush();
    startTurn(pc().id);
    db.prepare('UPDATE character SET spell_slots_json = ? WHERE id = ?').run(
      JSON.stringify({ ...combatSheet(db, id).spell_slots, '1': { max: 4, used: 4 } }),
      id,
    );
    const used = () => (featureRow(id, 'Sorcery Points')!.mechanics!.used as number | undefined) ?? 0;
    const points = used();
    await expect(
      cast(pc().id, 'Burning Hands', {
        point: { x: foe().x, y: foe().y },
        slot_level: 1,
        metamagic: ['Quickened Spell'],
        rolls: { [String(foe().id)]: failSave },
      }),
    ).rejects.toThrow(/no level 1 spell slot/i);
    expect(used()).toBe(points);
    expect(pc().bonus_used).toBe(false);
  });

  it('refuses Careful Spell with nobody named to protect, and spends nothing on it', async () => {
    const id = sorcerer(5, ['Careful Spell', 'Twinned Spell']);
    await ambush();
    startTurn(pc().id);
    await expect(
      cast(pc().id, 'Burning Hands', {
        point: { x: foe().x, y: foe().y },
        slot_level: 1,
        metamagic: ['Careful Spell'],
        rolls: { [String(foe().id)]: failSave },
      }),
    ).rejects.toThrow(/careful_targets/);
    expect((featureRow(id, 'Sorcery Points')!.mechanics!.used as number | undefined) ?? 0).toBe(0);
    expect(combatSheet(db, id).spell_slots['1']!.used).toBe(0);
  });

  it('twins only a spell a higher slot would reach another creature with', async () => {
    const id = sorcerer(5, ['Twinned Spell', 'Careful Spell']);
    await ambush(2);
    startTurn(pc().id);
    // Fireball's higher-level line adds damage, not a target, so Twinned Spell has nothing to ride on.
    await expect(
      cast(pc().id, 'Fireball', {
        point: { x: foe().x, y: foe().y },
        slot_level: 3,
        metamagic: ['Twinned Spell'],
        twin_target: foe(1).id,
        rolls: { [String(foe(0).id)]: failSave, [String(foe(1).id)]: failSave },
      }),
    ).rejects.toThrow(/additional creature/);
    expect((featureRow(id, 'Sorcery Points')!.mechanics!.used as number | undefined) ?? 0).toBe(0);
    // Hold Person's does add one, so it may be twinned.
    const held = await cast(pc().id, 'Hold Person', {
      target_id: foe(0).id,
      slot_level: 2,
      metamagic: ['Twinned Spell'],
      twin_target: foe(1).id,
      rolls: { [String(foe(0).id)]: failSave, [String(foe(1).id)]: failSave },
    });
    expect(held.targets.length).toBe(2);
    expect(texts(held)).toMatch(/Twinned Spell/);
  });

  it('holds Concentration with Advantage after an Extended Spell', async () => {
    sorcerer(5, ['Extended Spell', 'Careful Spell']);
    await ambush();
    startTurn(pc().id);
    const held = await cast(pc().id, 'Hold Person', {
      target_id: foe().id,
      slot_level: 2,
      metamagic: ['Extended Spell'],
      rolls: { [String(foe().id)]: failSave },
    });
    expect(texts(held)).toMatch(/Extended Spell/);
    expect(pc().concentration).toMatchObject({ name: 'Hold Person', advantage: true });
    const hurt = await useAction(db, {
      campaign_id: campaignId,
      actor_id: foe().id,
      action_name: 'a heavy blow',
      target_id: pc().id,
      damage_expr: '10',
      out_of_turn: true,
      reason: 'testing the Concentration save',
    });
    const entry = hurt.log.find((e) => e.kind === 'concentration')!;
    expect((entry.payload as { save: { advantage: string } }).save.advantage).toBe('advantage');
  });

  it('quickens a spell into a Bonus Action, and refuses a level 1+ spell after it', async () => {
    sorcerer(5, ['Quickened Spell', 'Careful Spell']);
    await ambush();
    startTurn(pc().id);
    const quick = await cast(pc().id, 'Fire Bolt', { target_id: foe().id, metamagic: ['Quickened Spell'] });
    expect(quick.log.some((e) => /Quickened Spell/.test(e.text))).toBe(true);
    expect(pc().bonus_used).toBe(true);
    expect(pc().action_used).toBe(false);
    await expect(cast(pc().id, 'Burning Hands', { point: { x: foe().x, y: foe().y }, slot_level: 1 })).rejects.toThrow(
      /quickened a spell this turn/i,
    );
  });

  it('carves allies out of the blast with Careful Spell', async () => {
    const id = sorcerer(5, ['Careful Spell', 'Twinned Spell']);
    const help = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Squire',
      source: { class: 'Fighter', species: 'Human', background: 'Soldier' },
    }).companion!.id;
    await ambush();
    const ally = combatants().find((c) => c.character_id === help)!;
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(foe().x, foe().y, ally.id);
    startTurn(pc().id);
    const before = byId(ally.id).hp_current;
    const careful = await cast(pc().id, 'Burning Hands', {
      point: { x: foe().x, y: foe().y },
      slot_level: 1,
      metamagic: ['Careful Spell'],
      careful_targets: [ally.id],
      rolls: { [String(foe().id)]: failSave, [String(ally.id)]: failSave },
    });
    expect(texts(careful)).toMatch(/carved out/);
    expect(byId(ally.id).hp_current).toBe(before);
    expect(foe().hp_current).toBeLessThan(200);
    expect(resourceState(combatSheet(db, id), FEATURES['sorcerer-font-of-magic']!)).toBeNull();
  });

  it('twins a spell onto a second creature, casting it a level higher', async () => {
    sorcerer(5, ['Twinned Spell', 'Careful Spell']);
    await ambush(2);
    startTurn(pc().id);
    const twinned = await cast(pc().id, 'Charm Person', {
      target_id: foe(0).id,
      slot_level: 1,
      metamagic: ['Twinned Spell'],
      twin_target: foe(1).id,
      rolls: { [String(foe(0).id)]: failSave, [String(foe(1).id)]: failSave },
    });
    expect(twinned.targets.length).toBe(2);
    expect(texts(twinned)).toMatch(/Twinned Spell/);
  });

  it('refuses Metamagic the Sorcerer does not know, two options on one casting, and points it cannot pay', async () => {
    sorcerer(2, ['Quickened Spell', 'Careful Spell']);
    await ambush();
    startTurn(pc().id);
    await expect(cast(pc().id, 'Fire Bolt', { target_id: foe().id, metamagic: ['Subtle Spell'] })).rejects.toThrow(
      /does not know Subtle Spell/,
    );
    await expect(
      cast(pc().id, 'Fire Bolt', { target_id: foe().id, metamagic: ['Quickened Spell', 'Careful Spell'] }),
    ).rejects.toThrow(/Only 1 Metamagic option/);
    // Two sorcery points at level 2, and Quickened Spell costs both: a second casting cannot pay.
    await cast(pc().id, 'Fire Bolt', { target_id: foe().id, metamagic: ['Quickened Spell'] });
    startTurn(pc().id);
    await expect(cast(pc().id, 'Fire Bolt', { target_id: foe().id, metamagic: ['Quickened Spell'] })).rejects.toThrow(
      /Sorcery Points left/,
    );
  });

  it('gives Sorcery Points back on a short rest, once per long rest', () => {
    const id = caster('sorcerer', 5, { subclass: 'Draconic Sorcery', picks: { Metamagic: ['Quickened Spell', 'Careful Spell'] } });
    const row = featureRow(id, 'Sorcery Points')!;
    db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(
      JSON.stringify(
        (JSON.parse(
          (db.prepare('SELECT features_json FROM character WHERE id = ?').get(id) as { features_json: string }).features_json,
        ) as Array<{ name: string; mechanics?: Record<string, unknown> }>).map((f) =>
          f.name === row.name ? { ...f, mechanics: { ...f.mechanics, used: 4 } } : f,
        ),
      ),
      id,
    );
    const rested = rest(db, { campaign_id: campaignId, character_id: id, kind: 'short', sorcerous_restoration: true });
    expect(rested.sorcery_points_restored).toBe(2);
    expect(() => rest(db, { campaign_id: campaignId, character_id: id, kind: 'short', sorcerous_restoration: true })).toThrow(
      /already used Sorcerous Restoration/i,
    );
  });

  it('wears dragon scales: hit points per level and an unarmoured Armor Class of 10 + DEX + CHA', () => {
    // The scales only show with nothing worn, and the Armor Class is worked out as the level is gained.
    const plain = make({ class: 'sorcerer', name: 'sorcerer' });
    arm(plain);
    const before = combatSheet(db, plain).hp_max;
    climbTo(plain, 3, 'Draconic Sorcery', { Metamagic: ['Quickened Spell', 'Careful Spell'] });
    const sheet = combatSheet(db, plain);
    expect(sheet.ac).toBe(10 + sheet.abilities.dex!.mod + sheet.abilities.cha!.mod);
    expect(featureRow(plain, 'Draconic Resilience')!.mechanics!.hp_per_level).toBe(1);
    // Three hit points at the level it arrives, one of them from the per-level rule itself.
    const perLevel = Math.floor(findClass('sorcerer').hit_die / 2) + 1 + sheet.abilities.con!.mod;
    expect(sheet.hp_max).toBe(before + perLevel * 2 + 3);
  });

  it('resists its ancestry damage type and adds Charisma to one damage roll of it', async () => {
    const id = caster('sorcerer', 6, {
      subclass: 'Draconic Sorcery',
      gear: [],
      picks: { Metamagic: ['Quickened Spell', 'Careful Spell'], 'Elemental Affinity': ['Fire'] },
    });
    expect(combatSheet(db, id).resistances.concat(classFeatures(combatSheet(db, id)).map((f) => f.index)).length).toBeGreaterThan(0);
    await ambush();
    startTurn(pc().id);
    const bolt = await cast(pc().id, 'Fire Bolt', { target_id: foe().id, roll: hit });
    expect(texts(bolt)).toMatch(/Elemental Affinity/);
    // And the resistance shows on the damage the sorcerer takes from it.
    const burned = await useAction(db, {
      campaign_id: campaignId,
      actor_id: foe().id,
      action_name: 'Dragon Breath',
      target_id: pc().id,
      damage_expr: '10',
      damage_type: 'fire',
      out_of_turn: true,
      reason: 'testing the resistance',
    });
    expect((burned.targets[0] as { damage: { resistance: string | null } }).damage.resistance).toBe('resistant');
  });

  it('bends a spell the other ways Metamagic offers: distant, heightened, transmuted and subtle', async () => {
    caster('sorcerer', 10, {
      subclass: 'Draconic Sorcery',
      gear: [],
      picks: {
        Metamagic: ['Distant Spell', 'Heightened Spell', 'Transmuted Spell', 'Subtle Spell'],
        'Elemental Affinity': ['Fire'],
      },
    });
    await ambush();
    startTurn(pc().id);
    const far = await cast(pc().id, 'Fire Bolt', { target_id: foe().id, metamagic: ['Distant Spell'], roll: hit });
    expect(texts(far)).toMatch(/Distant Spell/);
    expect((far as { spell: { range_ft: number } }).spell.range_ft).toBe(120);
    startTurn(pc().id);
    const cold = await cast(pc().id, 'Burning Hands', {
      point: { x: foe().x, y: foe().y },
      slot_level: 1,
      metamagic: ['Transmuted Spell'],
      transmute_to: 'cold',
      rolls: { [String(foe().id)]: failSave },
    });
    expect(texts(cold)).toMatch(/cold damage/i);
    startTurn(pc().id);
    const heightened = await cast(pc().id, 'Burning Hands', {
      point: { x: foe().x, y: foe().y },
      slot_level: 1,
      metamagic: ['Heightened Spell'],
      heighten_target: foe().id,
      rolls: { [String(foe().id)]: failSave },
    });
    expect(texts(heightened)).toMatch(/Heightened Spell/);
    startTurn(pc().id);
    const quiet = await cast(pc().id, 'Fire Bolt', { target_id: foe().id, metamagic: ['Subtle Spell'], roll: hit });
    expect(texts(quiet)).toMatch(/Subtle Spell/);
  });
});

// --- 6. Warlock ---------------------------------------------------------------

describe('the Warlock', () => {
  /** The invocations a Warlock picks are level-gated, so the wish list is answered as they level. */
  function warlock(level: number, invocations: string[] = []): number {
    const id = make({
      class: 'warlock',
      name: 'warlock',
      abilities: ABILITIES,
      cantrips: ['Eldritch Blast', 'Prestidigitation'],
      feature_options: {},
    } as never);
    arm(id, 'Dagger');
    if (level > 1) climbTo(id, level, 'Fiend Patron', { 'Eldritch Invocations': invocations });
    return id;
  }

  it('offers each invocation at the level the bundled SRD text gives it', () => {
    // The hand table had nine of these at level 1; "Eldritch Invocation Options" says Level 2+ Warlock.
    expect(srd.invocations().filter((o) => o.level === 1).map((o) => o.name)).toEqual([
      'Armor of Shadows',
      'Eldritch Mind',
      'Pact of the Blade',
      'Pact of the Chain',
      'Pact of the Tome',
    ]);
    expect(srd.findInvocation('Agonizing Blast')).toMatchObject({ level: 2 });
    // And the Pact an invocation asks for first is read off the same line.
    expect(srd.findInvocation('Eldritch Smite')).toMatchObject({ level: 5, requires: 'Pact of the Blade' });

    const id = warlock(1);
    expect(featureRow(id, 'Eldritch Invocations')!.mechanics!.options).not.toContain('Agonizing Blast');
    awardXp(db, { campaign_id: campaignId, character_id: id, amount: XP_THRESHOLDS[1]! });
    const offered = (levelUpOptions(db, campaignId, id) as Options).feature_choices!.find(
      (c) => c.feature === 'Eldritch Invocations',
    )!;
    expect(offered.from).toContain('Agonizing Blast');
  });

  it('casts Find Familiar for nothing through Pact of the Chain, as a Magic action', async () => {
    const id = warlock(2, ['Pact of the Chain']);
    const before = combatSheet(db, id).spell_slots;
    await ambush();
    startTurn(pc().id);
    const called = await cast(pc().id, 'Find Familiar', { free_cast: 'pact_of_the_chain', option: 'Raven' });
    expect(texts(called)).toMatch(/Pact of the Chain/);
    expect(combatants().find((c) => /Raven/.test(c.name))!.kind).toBe('companion');
    expect(combatSheet(db, id).spell_slots).toEqual(before);
    expect(pc().action_used).toBe(true);
  });

  it('casts Water Breathing free once per long rest with Gift of the Depths', async () => {
    const id = warlock(5, ['Gift of the Depths']);
    const level = pactSlotLevel(combatSheet(db, id));
    await ambush();
    startTurn(pc().id);
    const first = await cast(pc().id, 'Water Breathing', { target_id: pc().id });
    expect(texts(first)).toMatch(/Gift of the Depths/);
    expect(combatSheet(db, id).spell_slots[String(level)]!.used).toBe(0);
    // The second casting in the same long rest comes out of a Pact Magic slot like any other.
    startTurn(pc().id);
    const again = await cast(pc().id, 'Water Breathing', { target_id: pc().id });
    expect(texts(again)).not.toMatch(/Gift of the Depths/);
    expect(combatSheet(db, id).spell_slots[String(level)]!.used).toBe(1);
  });

  it('adds Charisma to an Eldritch Blast with Agonizing Blast', async () => {
    warlock(2, ['Agonizing Blast']);
    await ambush();
    startTurn(pc().id);
    const blasted = await cast(pc().id, 'Eldritch Blast', { target_id: foe().id, roll: hit });
    expect(texts(blasted)).toMatch(/Agonizing Blast/);
    expect(named(blasted, 'Agonizing Blast')!.damage).toBe(3);
  });

  it('drives a creature back with Repelling Blast', async () => {
    warlock(2, ['Repelling Blast']);
    await ambush();
    startTurn(pc().id);
    const where = foe().x;
    const pushed = await cast(pc().id, 'Eldritch Blast', { target_id: foe().id, roll: hit });
    expect(texts(pushed)).toMatch(/Repelling Blast/);
    expect(Math.abs(foe().x - where)).toBe(2);
  });

  it('swings a pact weapon with Charisma and smites with a Pact Magic slot', async () => {
    const id = warlock(5, ['Pact of the Blade', 'Eldritch Smite']);
    await ambush();
    startTurn(pc().id);
    const conjured = await use(pc().id, 'pact_weapon', { option: 'Dagger' });
    expect(texts(conjured)).toMatch(/pact weapon/);
    const sheet = combatSheet(db, id);
    const dagger = legalActions(pc(), sheet).find((a) => a.id === 'attack:Dagger')!;
    expect(dagger.hint).toMatch(new RegExp(`\\+${sheet.proficiency_bonus + sheet.abilities.cha!.mod} to hit`));
    const smitten = await swing(pc().id, foe().id, 'Dagger', { eldritch_smite: true });
    expect(named(smitten, 'Eldritch Smite')!.damage).toBeGreaterThan(0);
    expect(texts(smitten)).toMatch(/Pact Magic slot/);
    expect(byId(foe().id).conditions).toContain('prone');
    // Once per turn, and no second slot goes with it.
    await expect(swing(pc().id, foe().id, 'Dagger', { eldritch_smite: true })).rejects.toThrow(/once per turn/i);
  });

  it('attacks twice with Thirsting Blade', () => {
    const plain = warlock(5, ['Pact of the Blade', 'Eldritch Smite']);
    const blade = warlock(5, ['Pact of the Blade', 'Thirsting Blade']);
    expect(attacksPerAction(combatSheet(db, plain))).toBe(1);
    expect(attacksPerAction(combatSheet(db, blade))).toBe(2);
  });

  it('casts an invocation spell without a slot (Armor of Shadows)', async () => {
    const id = warlock(2, ['Armor of Shadows']);
    await ambush();
    startTurn(pc().id);
    const warded = await cast(pc().id, 'Mage Armor', { target_id: pc().id });
    expect(texts(warded)).toMatch(/Armor of Shadows: this casting costs no spell slot/);
    expect(Object.values(combatSheet(db, id).spell_slots).every((slot) => slot.used === 0)).toBe(true);
  });

  it('holds Concentration with Advantage through Eldritch Mind', async () => {
    warlock(2, ['Eldritch Mind']);
    await ambush();
    startTurn(pc().id);
    await cast(pc().id, 'Hex', { target_id: foe().id, slot_level: 1, roll: hit });
    expect(pc().concentration).toEqual({ name: 'Hex' });
    const hurt = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Scimitar',
      roll: hit,
      out_of_turn: true,
      reason: 'testing the concentration save',
    });
    const save = hurt.log.find((e) => /Concentration|CON save/i.test(e.text));
    expect(save).toBeDefined();
    expect(JSON.stringify(hurt.log)).toMatch(/Eldritch Mind/);
  });

  it("takes temporary hit points when an enemy drops (Dark One's Blessing)", async () => {
    warlock(3);
    await ambush();
    db.prepare('UPDATE combatant SET hp_current = 1, hp_max = 1 WHERE id = ?').run(foe().id);
    startTurn(pc().id);
    const killed = await swing(pc().id, foe().id, 'Dagger');
    expect(texts(killed)).toMatch(/Dark One's Blessing/);
    expect(byId(pc().id).temp_hp).toBeGreaterThan(0);
  });

  it("adds a d10 to a saving throw with Dark One's Own Luck", async () => {
    const id = warlock(6);
    await ambush();
    startTurn(pc().id);
    const called = await use(pc().id, 'dark_ones_own_luck');
    expect(pc().flags.dark_ones_luck_ready).toBe(true);
    expect(resourceState(combatSheet(db, id), FEATURES['fiend-patron-dark-ones-own-luck']!)!.left).toBe(
      Math.max(1, combatSheet(db, id).abilities.cha!.mod) - 1,
    );
    expect(texts(called)).toMatch(/patron/);
    const forced = await useAction(db, {
      campaign_id: campaignId,
      actor_id: foe().id,
      action_name: 'Web of Shadows',
      target_id: pc().id,
      save_ability: 'dex',
      save_dc: 25,
      damage_expr: '4',
      damage_type: 'necrotic',
      out_of_turn: true,
      reason: 'testing the luck',
    });
    expect(JSON.stringify(forced.targets)).toMatch(/Dark One's Own Luck/);
    expect(byId(pc().id).flags.dark_ones_luck_ready).toBeUndefined();
  });

  it('resists the damage type Fiendish Resilience named on the last rest', async () => {
    const id = warlock(10);
    const rested = rest(db, { campaign_id: campaignId, character_id: id, kind: 'short', fiendish_resilience: 'fire' });
    expect(rested.fiendish_resilience).toBe('fire');
    expect(() => rest(db, { campaign_id: campaignId, character_id: id, kind: 'short', fiendish_resilience: 'force' })).toThrow(
      /other than Force/,
    );
    await ambush();
    const burned = await useAction(db, {
      campaign_id: campaignId,
      actor_id: foe().id,
      action_name: 'Flame',
      target_id: pc().id,
      damage_expr: '10',
      damage_type: 'fire',
      out_of_turn: true,
      reason: 'testing the resistance',
    });
    expect((burned.targets[0] as { damage: { resistance: string | null } }).damage.resistance).toBe('resistant');
  });

  it('leaves Magical Cunning and Contact Patron to the DM, with the reason', () => {
    expect(FEATURES['warlock-magical-cunning']!.dm_applied).toMatch(/1-minute rite/);
    expect(FEATURES['warlock-contact-patron']!.dm_applied).toMatch(/1 minute to cast/);
  });
});

// --- 7. Wizard ----------------------------------------------------------------

describe('the Wizard', () => {
  const wizard = (level: number, picks: Record<string, string[]> = {}) =>
    caster('wizard', level, { subclass: 'Evoker', gear: ['Quarterstaff'], picks });

  it('doubles one field of study with Scholar', () => {
    const id = wizard(2, { Scholar: ['arcana'] });
    const skills = sheetOf(id).skills as Record<string, { expertise: boolean }>;
    const scholar = featureRow(id, 'Scholar')!.mechanics!.options as string[];
    expect(skills[scholar[0]!]!.expertise).toBe(true);
  });

  it('still deals half a cantrip on a save and on a miss (Potent Cantrip)', async () => {
    wizard(3);
    await ambush();
    startTurn(pc().id);
    const saved = await cast(pc().id, 'Acid Splash', {
      target_id: foe().id,
      rolls: { [String(foe().id)]: { total: 30, natural: 20 } },
    });
    expect(texts(saved)).toMatch(/Potent Cantrip/);
    expect(foe().hp_current).toBeLessThan(200);
    const after = foe().hp_current;
    startTurn(pc().id);
    const missed = await cast(pc().id, 'Fire Bolt', { target_id: foe().id, roll: miss });
    expect(texts(missed)).toMatch(/Potent Cantrip/);
    expect(foe().hp_current).toBeLessThan(after);
  });

  it('carves allies out of an evocation with Sculpt Spells', async () => {
    wizard(6);
    const help = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Squire',
      source: { class: 'Fighter', species: 'Human', background: 'Soldier' },
    }).companion!.id;
    await ambush();
    const ally = combatants().find((c) => c.character_id === help)!;
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(foe().x, foe().y, ally.id);
    startTurn(pc().id);
    const before = byId(ally.id).hp_current;
    const sculpted = await cast(pc().id, 'Burning Hands', {
      point: { x: foe().x, y: foe().y },
      slot_level: 1,
      sculpt: [ally.id],
      rolls: { [String(foe().id)]: failSave, [String(ally.id)]: failSave },
    });
    expect(texts(sculpted)).toMatch(/Sculpt Spells/);
    expect(byId(ally.id).hp_current).toBe(before);
    // And never more creatures than the spell's level allows.
    startTurn(pc().id);
    await expect(
      cast(pc().id, 'Burning Hands', {
        point: { x: foe().x, y: foe().y },
        slot_level: 1,
        sculpt: [ally.id, pc().id, foe().id],
      }),
    ).rejects.toThrow(/1 \+ the spell/);
  });

  it('adds Intelligence to one damage roll of an evocation (Empowered Evocation)', async () => {
    wizard(10);
    await ambush(2);
    startTurn(pc().id);
    const blast = await cast(pc().id, 'Burning Hands', {
      point: { x: foe(0).x, y: foe(0).y },
      slot_level: 1,
      rolls: { [String(foe(0).id)]: failSave, [String(foe(1).id)]: failSave },
    });
    // One damage roll of the spell, however many creatures it caught.
    expect(featuresIn(blast).filter((f) => f.feature === 'Empowered Evocation').length).toBe(1);
  });

  it('swaps a prepared spell on a short rest with Memorize Spell', () => {
    const id = wizard(5);
    const sheet = combatSheet(db, id);
    const book = (sheet.spells as { spellbook?: string[] }).spellbook ?? [];
    const spare = book.find((name: string) => !sheet.spells.prepared.includes(name))!;
    const swapped = rest(db, {
      campaign_id: campaignId,
      character_id: id,
      kind: 'short',
      memorize_spell: { replace: sheet.spells.prepared[0]!, with: spare },
    });
    expect(swapped.memorized_spell).toMatch(new RegExp(spare));
    expect(combatSheet(db, id).spells.prepared).toContain(spare);
  });

  it('leaves Ritual Adept to the DM until ritual casting arrives', () => {
    expect(FEATURES['wizard-ritual-adept']!.dm_applied).toMatch(/Ritual/);
  });
});

// --- 8. the rest of Metamagic, and the roll tool ------------------------------

describe('Metamagic beyond one option, and Magical Secrets', () => {
  it('rerolls damage with Empowered Spell and a missed attack with Seeking Spell, both beside another option', async () => {
    caster('sorcerer', 10, {
      subclass: 'Draconic Sorcery',
      gear: [],
      picks: {
        Metamagic: ['Empowered Spell', 'Seeking Spell', 'Quickened Spell', 'Distant Spell'],
        'Elemental Affinity': ['Fire'],
      },
    });
    await ambush();
    startTurn(pc().id);
    const empowered = await cast(pc().id, 'Burning Hands', {
      point: { x: foe().x, y: foe().y },
      slot_level: 1,
      metamagic: ['Empowered Spell', 'Quickened Spell'],
      rolls: { [String(foe().id)]: failSave },
    });
    expect(texts(empowered)).toMatch(/Empowered Spell/);
    expect(pc().bonus_used).toBe(true);
    startTurn(pc().id);
    // Seeking Spell rerolls the miss; the new roll stands whatever it is.
    const seeking = await cast(pc().id, 'Fire Bolt', { target_id: foe().id, metamagic: ['Seeking Spell'], roll: miss });
    expect(texts(seeking)).toMatch(/Seeking Spell/);
  });

  it('rides two Metamagic options on one spell while Innate Sorcery runs (Sorcery Incarnate)', async () => {
    caster('sorcerer', 7, {
      subclass: 'Draconic Sorcery',
      gear: [],
      picks: { Metamagic: ['Distant Spell', 'Careful Spell'], 'Elemental Affinity': ['Fire'] },
    });
    await ambush();
    startTurn(pc().id);
    await expect(
      cast(pc().id, 'Fire Bolt', { target_id: foe().id, metamagic: ['Distant Spell', 'Careful Spell'], roll: hit }),
    ).rejects.toThrow(/Only 1 Metamagic option/);
    await use(pc().id, 'innate_sorcery');
    const both = await cast(pc().id, 'Fire Bolt', {
      target_id: foe().id,
      metamagic: ['Distant Spell', 'Careful Spell'],
      careful_targets: [foe().id],
      roll: hit,
    });
    expect(texts(both)).toMatch(/Distant Spell/);
  });

  it('spends a held Bardic Inspiration die on an out-of-combat check that would fail', async () => {
    const bard = caster('bard', 1, { subclass: 'College of Lore' });
    grantInspirationDie(db, { campaign_id: campaignId, character_id: bard, die: 6, from: 'Lyric' });
    const client = await connect();
    const easy = await client.callTool({
      name: 'roll',
      arguments: { campaign_id: campaignId, character_id: bard, skill: 'arcana', dc: 1, purpose: 'Arcana', bardic_inspiration: true },
    });
    expect(JSON.stringify(easy.structuredContent)).toMatch(/was not needed/);
    expect(heldInspirationDie(db, campaignId, bard)).toBe(6);
    const hard = await client.callTool({
      name: 'roll',
      arguments: { campaign_id: campaignId, character_id: bard, skill: 'arcana', dc: 40, purpose: 'Arcana', bardic_inspiration: true },
    });
    expect(JSON.stringify(hard.structuredContent)).toMatch(/not spent/);
    expect(heldInspirationDie(db, campaignId, bard)).toBe(6);
    await client.close();
  });

  it("adds a d10 to an out-of-combat save with Dark One's Own Luck", async () => {
    const id = caster('warlock', 6, { subclass: 'Fiend Patron' });
    const client = await connect();
    const saved = await client.callTool({
      name: 'roll',
      arguments: { campaign_id: campaignId, character_id: id, save: 'wis', dc: 30, purpose: 'Wisdom save', dark_ones_luck: true },
    });
    expect(JSON.stringify(saved.structuredContent)).toMatch(/Dark One's Own Luck/);
    const cha = Math.max(1, combatSheet(db, id).abilities.cha!.mod);
    const left = resourceState(combatSheet(db, id), FEATURES['fiend-patron-dark-ones-own-luck']!)!.left;
    expect(left).toBeLessThanOrEqual(cha);
    await client.close();
  });

  it("refuses the roll add-on when nobody has handed the character a die", async () => {
    const bard = caster('bard', 1, { subclass: 'College of Lore' });
    const client = await connect();
    const refused = await client.callTool({
      name: 'roll',
      arguments: { campaign_id: campaignId, character_id: bard, skill: 'arcana', dc: 10, purpose: 'Arcana', bardic_inspiration: true },
    });
    expect(JSON.stringify(refused)).toMatch(/Bardic Inspiration die/);
    await client.close();
  });

  it('offers the Cleric, Druid and Wizard lists to a Bard with Magical Secrets', () => {
    const id = caster('bard', 10, { subclass: 'College of Lore' });
    const options = levelUpOptions(db, campaignId, id) as Options;
    const pool = Object.values(options.spellcasting!.spell_options).flat();
    // Cure Wounds is on the Bard list already; Divine Favor is Cleric and Paladin only.
    expect(pool.some((name) => srd.spells().find((s) => s.fields.name === name)?.fields.classes.includes('srd-2024_wizard'))).toBe(
      true,
    );
  });
});
