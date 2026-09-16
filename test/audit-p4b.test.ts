// Package P4b: a class feature's sheet note must describe the behaviour the runtime beside it has.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  awardXp,
  createCharacter,
  levelUp,
  levelUpOptions,
  type CreateCharacterInput,
  type LevelUpChoices,
} from '../src/core/character.js';
import { auraFt, checkSources, classFeatures, FEATURES, liveFeatures, RELENTLESS_RAGE_USES } from '../src/combat/features.js';
import { combatSheet } from '../src/combat/sheet.js';
import type { Combatant } from '../src/combat/state.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import { classLevelRow, findClass, findSpecies, skillChoiceGroups, spellsForClass } from '../src/srd/lookup.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

const sheetOf = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;

interface Options {
  subclass_choice?: unknown;
  ability_score_improvement?: unknown;
  epic_boon?: { feat_options: Array<{ name: string }> };
  feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
  spellcasting?: {
    cantrips_to_add: number;
    spells_to_add: number;
    cantrip_options: string[];
    spell_options: Record<string, string[]>;
  };
}

function spreadIncrease(abilities: Record<string, { score: number }>): Partial<Record<Ability, number>> {
  const order = (Object.keys(abilities) as Ability[])
    .filter((a) => abilities[a]!.score < 20)
    .sort((a, b) => abilities[a]!.score - abilities[b]!.score);
  return { [order[0]!]: 1, [order[1]!]: 1 };
}

/** Levels a character to the target level, answering whatever each level asks for. */
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
      choices.feat_choices = { ability: 'str' };
    }
    if (options.feature_choices) {
      choices.feature_options = Object.fromEntries(
        options.feature_choices.map((spec) => [spec.feature, spec.from.slice(0, spec.choose)]),
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

/** A player character of this class at this level, under the subclass the feature under test lives in. */
function hero(cls: string, level: number, subclass: string): number {
  const data = findClass(cls);
  const casting = data.spellcasting ? classLevelRow(data.index, 1).spellcasting : undefined;
  const id = createCharacter(db, {
    campaign_id: campaignId,
    class: cls,
    name: cls,
    species: 'Human',
    background: 'Soldier',
    ability_method: 'manual',
    abilities: ABILITIES,
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: skillPicks(cls),
    cantrips: spellsForClass(data.index, 0).slice(0, casting?.cantrips_known ?? 0),
    spells: spellsForClass(data.index, 1).slice(0, casting?.prepared_spells ?? 0),
  } as CreateCharacterInput).character!.id;
  if (level > 1) climbTo(id, level, subclass);
  return id;
}

/** A stand-in for the combatant a hook is asked about; the notes under test never read it. */
const standIn = (name: string): Combatant => ({ name, flags: {}, conditions: [] }) as unknown as Combatant;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'The P4b Audit', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
    .campaign_id;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('the sheet notes beside the runtime', () => {
  it('reports the Aura of Protection at the auraFt the runtime reaches, not the 10 ft constant', () => {
    const id = hero('paladin', 18, 'Oath of Devotion');
    const sheet = combatSheet(db, id);
    const note = FEATURES['paladin-aura-of-protection']!.passive!(sheet)!.note!;

    // Aura Expansion widens the aura to 30 ft, so the note has to say 30 and not AURA_FT's 10.
    expect(auraFt(sheet)).toBe(30);
    expect(note).toContain(`${auraFt(sheet)} ft`);
    expect(note).not.toMatch(/\b10 ft\b/);
  });

  it('reports the Aura of Protection at 10 ft for a Paladin below Aura Expansion', () => {
    const id = hero('paladin', 6, 'Oath of Devotion');
    const sheet = combatSheet(db, id);
    const note = FEATURES['paladin-aura-of-protection']!.passive!(sheet)!.note!;

    expect(auraFt(sheet)).toBe(10);
    expect(note).toContain(`${auraFt(sheet)} ft`);
  });

  it('tells a Barbarian the Relentless Rage count ends on a rest and a failed save raises the DC', () => {
    const id = hero('barbarian', 11, 'Path of the Berserker');
    const sheet = combatSheet(db, id);
    const note = FEATURES['barbarian-relentless-rage']!.passive!(sheet)!.note!;

    // The tally lives on the sheet and is rest-scoped, not fight-scoped.
    expect(RELENTLESS_RAGE_USES.per).toBe('short');
    expect(note).toMatch(/short or long rest/i);
    expect(note).not.toMatch(/in this fight/i);
    // A failed save is a use like any other, so it lifts the next DC too.
    expect(note).toMatch(/failed save/i);
  });

  it("hands Remarkable Athlete's post-critical move to the DM without dropping the Advantage", () => {
    const id = hero('fighter', 3, 'Champion');
    const sheet = combatSheet(db, id);
    const handler = FEATURES['champion-remarkable-athlete']!;

    // The move is left to the DM, and the sheet says so.
    expect(handler.dm_applied).toBeTruthy();
    expect(handler.dm_applied).toMatch(/Critical Hit/i);
    expect(handler.dm_applied).toMatch(/move/i);
    const view = classFeatures(sheet).find((f) => f.index === 'champion-remarkable-athlete')!;
    expect(view.dm_applied).toBe(handler.dm_applied);

    // The note must not cost the feature the half the engine does apply.
    expect(liveFeatures(sheet).map((held) => held.handler.index)).toContain('champion-remarkable-athlete');
    const athletics = checkSources(sheet, { actor: standIn('Champion'), ability: 'str', skill: 'athletics' });
    expect(athletics.map((source) => source.note)).toContain('Remarkable Athlete');
    const initiative = checkSources(sheet, { actor: standIn('Champion'), ability: 'dex', initiative: true });
    expect(initiative.map((source) => source.note)).toContain('Remarkable Athlete');
  });
});
