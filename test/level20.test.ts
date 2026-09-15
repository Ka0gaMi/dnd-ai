import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  awardXp,
  createCharacter,
  createCompanion,
  levelUp,
  levelUpOptions,
  type LevelUpChoices,
} from '../src/core/character.js';
import { legalActions } from '../src/combat/actions.js';
import { combatSheet } from '../src/combat/sheet.js';
import type { Combatant } from '../src/combat/state.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import { classLevelRow, findClass, spellsForClass } from '../src/srd/lookup.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'The Long Climb', story_shape: 'sandbox' }).campaign_id;
});

interface Feature {
  name: string;
  source: string;
  mechanics?: { extra_attacks?: number; resource?: string; max?: number; per?: string };
}
type Spells = { cantrips: string[]; known: string[]; prepared: string[] };
type Slots = Record<string, { max: number; used: number }>;

const sheetOf = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;
const featuresOf = (id: number): Feature[] => sheetOf(id).features as Feature[];

interface Options {
  subclass_choice?: unknown;
  ability_score_improvement?: unknown;
  epic_boon?: { epic: boolean; feat_options: Array<{ name: string }> };
  feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
  spellcasting?: {
    cantrips_to_add: number;
    spells_to_add: number;
    cantrip_options: string[];
    spell_options: Record<string, string[]>;
    spellbook?: { to_add: number; options: Record<string, string[]> };
  };
}

/** The two lowest scores with room to grow, so a long climb never runs into the cap of 20. */
function spreadIncrease(abilities: Record<string, { score: number }>): Partial<Record<Ability, number>> {
  const order = (Object.keys(abilities) as Ability[])
    .filter((a) => abilities[a]!.score < 20)
    .sort((a, b) => abilities[a]!.score - abilities[b]!.score);
  return { [order[0]!]: 1, [order[1]!]: 1 };
}

const take = (pool: string[], count: number, taken: string[]): string[] =>
  pool.filter((name) => !taken.includes(name)).slice(0, count);

/** Levels a character up to the target level, answering every choice the options offer. */
function climbTo(characterId: number, level: number, subclass: string): void {
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
    if (options.epic_boon) {
      choices.feat = options.epic_boon.feat_options[0]!.name;
      // An Epic Boon raises an ability of its own, which the player has to name.
      choices.feat_choices = { ability: 'cha' };
    }
    // Expertise, a Fighting Style, Metamagic, invocations: whatever this level asks for, take the first.
    if (options.feature_choices) {
      choices.feature_options = Object.fromEntries(
        options.feature_choices.map((spec) => [spec.feature, spec.from.slice(0, spec.choose)]),
      );
    }
    if (options.spellcasting) {
      const spells = character.spells as Spells;
      const pool = Object.values(options.spellcasting.spell_options).flat();
      choices.cantrips = take(options.spellcasting.cantrip_options, options.spellcasting.cantrips_to_add, spells.cantrips);
      const book = options.spellcasting.spellbook;
      if (book) {
        choices.spellbook = take(Object.values(book.options).flat(), book.to_add, []);
        // A Wizard prepares out of the book, so the new pages are where the new prepared spell comes from.
        choices.spells = take(choices.spellbook, options.spellcasting.spells_to_add, spells.known);
      } else {
        choices.spells = take(pool, options.spellcasting.spells_to_add, spells.known);
      }
    }
    levelUp(db, { campaign_id: campaignId, character_id: characterId, choices });
  }
}

function fighter(): number {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  }).character!.id;
}

/** A level 1 character of any class, with the first legal cantrips and spells its table asks for. */
function level1(name: string, cls: string, background: string, skills: string[]): number {
  const data = findClass(cls);
  const casting = data.spellcasting ? classLevelRow(data.index, 1).spellcasting : undefined;
  return createCharacter(db, {
    campaign_id: campaignId,
    name,
    species: 'Human',
    class: cls,
    background,
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    ability_bonuses: { int: 2, con: 1 },
    skill_choices: skills,
    cantrips: spellsForClass(data.index, 0).slice(0, casting?.cantrips_known ?? 0),
    spells: spellsForClass(data.index, 1).slice(0, casting?.prepared_spells ?? 0),
  }).character!.id;
}

/** Enough of a combatant for the legal-action list; the rest of the encounter is not the point here. */
const combatantFor = (name: string): Combatant =>
  ({
    kind: 'pc',
    name,
    stat_block: null,
    alive: true,
    hp_current: 20,
    speed: 30,
    movement_left: 30,
    action_used: false,
    bonus_used: false,
    reaction_used: false,
    death_saves: { successes: 0, failures: 0 },
    conditions: [],
    flags: {},
  }) as unknown as Combatant;

describe('levels 6 to 20', () => {
  it('takes a Fighter from 1 to 20', () => {
    const id = fighter();
    const first = sheetOf(id);

    climbTo(id, 17, 'Champion');
    expect(sheetOf(id).proficiency_bonus).toBe(6);

    climbTo(id, 20, 'Champion');
    const twentieth = sheetOf(id);
    expect(twentieth.level).toBe(20);
    expect((twentieth.hit_dice as { max: number }).max).toBe(20);
    expect(twentieth.hp_max!).toBeGreaterThan(first.hp_max!);
    expect(twentieth.proficiency_bonus).toBe(6);

    // An Ability Score Improvement at each of the Fighter's six ASI levels: 4, 6, 8, 12, 14, 16.
    const features = featuresOf(id);
    expect(features.filter((f) => f.name === 'Ability Score Improvement')).toHaveLength(6);

    // Extra Attack at 5, 11 and 20, each carrying the number of swings it grants.
    expect(features.find((f) => f.name === 'Extra Attack')?.mechanics).toEqual({ extra_attacks: 1 });
    expect(features.find((f) => f.name === 'Two Extra Attacks')?.mechanics).toEqual({ extra_attacks: 2 });
    expect(features.find((f) => f.name === 'Three Extra Attacks')?.mechanics).toEqual({ extra_attacks: 3 });

    // The Epic Boon taken at 19 is on the sheet as a feat.
    expect(features.some((f) => f.source === 'feat' && f.name.startsWith('Boon of'))).toBe(true);

    // Champion features at 3, 7, 10, 15 and 18 all arrived.
    const champion = features.filter((f) => f.source === 'subclass').map((f) => f.name);
    expect(champion).toEqual(
      expect.arrayContaining(['Improved Critical', 'Additional Fighting Style', 'Heroic Warrior', 'Superior Critical', 'Survivor']),
    );

    // Second Wind is a class resource: all four back on a long rest, one of them on a short one.
    expect(features.find((f) => f.mechanics?.resource === 'second_wind')?.mechanics).toEqual({
      resource: 'second_wind',
      max: 4,
      per: 'long',
      regain_on_short: 'one',
      used: 0,
    });
  });

  it('offers four attacks in one Attack action at level 20', () => {
    const id = fighter();
    climbTo(id, 20, 'Champion');
    const actions = legalActions(combatantFor('Borg'), combatSheet(db, id));
    const unarmed = actions.find((a) => a.id === 'attack:Unarmed Strike')!;
    expect(unarmed.label).toBe('Attack: Unarmed Strike ×4');
    expect(unarmed.hint).toContain('4 attacks with one Attack action');
  });

  it('gives a Wizard the SRD spell slots at 5, 9 and 17', () => {
    const id = level1('Zel', 'Wizard', 'Sage', ['arcana', 'investigation', 'perception']);

    climbTo(id, 5, 'Evoker');
    expect(sheetOf(id).spell_slots as Slots).toEqual({
      '1': { max: 4, used: 0 },
      '2': { max: 3, used: 0 },
      '3': { max: 2, used: 0 },
    });

    climbTo(id, 9, 'Evoker');
    expect(sheetOf(id).spell_slots as Slots).toEqual({
      '1': { max: 4, used: 0 },
      '2': { max: 3, used: 0 },
      '3': { max: 3, used: 0 },
      '4': { max: 3, used: 0 },
      '5': { max: 1, used: 0 },
    });

    climbTo(id, 17, 'Evoker');
    expect(sheetOf(id).spell_slots as Slots).toEqual({
      '1': { max: 4, used: 0 },
      '2': { max: 3, used: 0 },
      '3': { max: 3, used: 0 },
      '4': { max: 3, used: 0 },
      '5': { max: 2, used: 0 },
      '6': { max: 1, used: 0 },
      '7': { max: 1, used: 0 },
      '8': { max: 1, used: 0 },
      '9': { max: 1, used: 0 },
    });
    expect((sheetOf(id).spells as Spells).prepared).toHaveLength(20); // 19 from the table + Magic Initiate's
  });

  it('adds the Sorcerer subclass features at 6 and 14', () => {
    const id = level1('Ryn', 'Sorcerer', 'Sage', ['arcana', 'persuasion', 'perception']);

    climbTo(id, 6, 'Draconic Sorcery');
    expect(featuresOf(id).map((f) => f.name)).toContain('Elemental Affinity');
    expect(featuresOf(id).map((f) => f.name)).not.toContain('Dragon Wings');

    climbTo(id, 14, 'Draconic Sorcery');
    expect(featuresOf(id).map((f) => f.name)).toContain('Dragon Wings');
    // Sorcery Points follow the table, and the resource entry is replaced rather than repeated.
    const points = featuresOf(id).filter((f) => f.mechanics?.resource === 'sorcery_points');
    expect(points).toHaveLength(1);
    expect(points[0]!.mechanics).toEqual({ resource: 'sorcery_points', max: 14, per: 'long', used: 0 });
  });

  it('raises Rogue Sneak Attack to 6d6 at level 11', () => {
    const id = level1('Sly', 'Rogue', 'Criminal', ['stealth', 'acrobatics', 'perception', 'investigation', 'insight']);
    climbTo(id, 11, 'Thief');
    const sneak = featuresOf(id).filter((f) => f.mechanics?.resource === 'sneak_attack_dice');
    expect(sneak).toHaveLength(1);
    expect(sneak[0]!.mechanics).toEqual({ resource: 'sneak_attack_dice', max: 6 });
    expect(sneak[0]!.name).toBe('Sneak Attack');
  });

  it('levels a class companion and refuses a stat-block one', () => {
    fighter();
    const cleric = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Sella',
      source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
    }).companion!.id;

    climbTo(cleric, 6, 'Life Domain');
    const levelled = sheetOf(cleric);
    expect(levelled.level).toBe(6);
    expect(levelled.subclass).toBe('Life Domain');
    expect((levelled.features as Feature[]).map((f) => f.name)).toContain('Blessed Healer');

    const wolf = createCompanion(db, { campaign_id: campaignId, name: 'Rook', source: { creature: 'Wolf' } })
      .companion!.id;
    expect(() => levelUp(db, { campaign_id: campaignId, character_id: wolf })).toThrow(/creature stat block/);
    expect(awardXp(db, { campaign_id: campaignId, character_id: wolf, amount: 500 }).message).toMatch(
      /creature stat block/,
    );
  });

  it('refuses level 21', () => {
    const id = fighter();
    climbTo(id, 20, 'Champion');
    awardXp(db, { campaign_id: campaignId, character_id: id, amount: 100000 });
    const options = levelUpOptions(db, campaignId, id) as { supported: boolean; message: string };
    expect(options.supported).toBe(false);
    expect(options.message).toMatch(/level 20, the highest/);
    expect(() => levelUp(db, { campaign_id: campaignId, character_id: id })).toThrow(/level 20, the highest/);
  });
});
