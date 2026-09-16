// Audit P4c: Action Surge is once a turn, Heightened Focus pays Patient Defense its temporary hit
// points, and Cunning Strike's Trip holds to the Large-or-smaller limit its prose claims.
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
import { advanceTurn, attack, startEncounter, useAction } from '../src/combat/engine.js';
import { FEATURES, resourceMax, resourceState } from '../src/combat/features.js';
import { combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import { classLevelRow, findClass, findSpecies, skillChoiceGroups, spellsForClass } from '../src/srd/lookup.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const hit = { total: 30, natural: 12 };

const sheetOf = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;

interface Options {
  subclass_choice?: unknown;
  ability_score_improvement?: unknown;
  feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
}

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

/** A character at the level named, with the subclass, gear and abilities the case needs. */
function build(
  cls: string,
  level: number,
  options: { subclass?: string; abilities?: Partial<typeof ABILITIES>; gear?: string[] } = {},
): number {
  const id = make({
    class: cls,
    name: cls,
    abilities: { ...ABILITIES, ...options.abilities },
  });
  if (level > 1) climbTo(id, level, options.subclass ?? '');
  arm(id, ...(options.gear ?? ['Longsword']));
  return id;
}

const arm = (id: number, ...items: string[]): void => {
  db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(
    JSON.stringify(items.map((name) => ({ name, qty: 1, equipped: true }))),
    id,
  );
};

// --- the battlefield ----------------------------------------------------------

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
  for (const c of listCombatants(db, state.encounter.id)) {
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, 5, c.id);
    x += 1;
  }
  db.prepare("UPDATE combatant SET hp_max = 200, hp_current = 200 WHERE team = 'enemy'").run();
}

const combatants = (): Combatant[] => listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
const pc = (): Combatant => combatants().find((c) => c.kind === 'pc')!;
const foe = (): Combatant => combatants().find((c) => c.team === 'enemy')!;

const startTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?').run(id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === id),
    state.encounter.id,
  );
};

/** Rolls the fight forward with the real advance_turn until it is this combatant's turn. */
const turnOf = async (id: number): Promise<void> => {
  for (let step = 0; step < 30; step += 1) {
    const state = getBattleState(db, campaignId)!;
    if (state.combatants[state.encounter.turn_index]?.id === id) return;
    await advanceTurn(db, campaignId);
  }
  throw new Error(`The fight never came round to combatant ${id}.`);
};

const swing = (attacker: number, target: number, action: string, extra: Record<string, unknown> = {}) =>
  attack(db, { campaign_id: campaignId, attacker_id: attacker, target_id: target, action_name: action, roll: hit, ...extra });

const use = (actor: number, action: string, extra: Record<string, unknown> = {}) =>
  useAction(db, { campaign_id: campaignId, actor_id: actor, action_name: action, ...extra });

interface FeatureEffect {
  feature: string;
  damage?: number;
  note?: string;
  temp_hp?: number;
  save?: { total: number; success: boolean };
}
const featuresIn = (result: unknown): FeatureEffect[] => (result as { features?: FeatureEffect[] }).features ?? [];
const named = (result: unknown, name: string): FeatureEffect | undefined =>
  featuresIn(result).find((f) => f.feature === name);

const left = (id: number, index: string): number | null => {
  const state = resourceState(combatSheet(db, id), FEATURES[index]!);
  return state ? state.left : null;
};

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Audit P4c', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

// --- 1. Action Surge is once a turn -------------------------------------------

describe('P4c Action Surge is once a turn', () => {
  it('refuses a second surge in the same turn at level 17, and spends nothing on the refusal', async () => {
    const id = build('fighter', 17, { subclass: 'Champion' });
    await ambush();
    await turnOf(pc().id);
    await use(pc().id, 'action_surge');
    expect(pc().flags.action_surged).toBe(true);
    expect(left(id, 'fighter-action-surge')).toBe(1);
    // A level 17 Fighter has the second use, but the SRD allows only one of them on a turn.
    await expect(use(pc().id, 'action_surge')).rejects.toThrow(/once on a turn/i);
    expect(left(id, 'fighter-action-surge')).toBe(1);
  });

  it('allows the second Action Surge on a later turn of the same fight', async () => {
    const id = build('fighter', 17, { subclass: 'Champion' });
    await ambush();
    await turnOf(pc().id);
    await use(pc().id, 'action_surge');
    // The turn boundary clears the once-a-turn mark, so the second use is there for the asking.
    await advanceTurn(db, campaignId);
    await turnOf(pc().id);
    expect(pc().flags.action_surged).toBeUndefined();
    await use(pc().id, 'action_surge');
    expect(left(id, 'fighter-action-surge')).toBe(0);
  });
});

// --- 2. Heightened Focus pays Patient Defense ---------------------------------

describe('P4c Heightened Focus pays Patient Defense', () => {
  const monk = (): number => build('monk', 10, { subclass: 'Warrior of the Open Hand', gear: [] });

  it('grants two rolls of the Martial Arts die when the Focus Point is spent', async () => {
    const id = monk();
    expect(resourceMax(combatSheet(db, id), 'martial_arts_die')).toBe(8);
    await ambush();
    await turnOf(pc().id);
    // A d8 that shows its lowest face twice is two temporary hit points, never one.
    Math.random = () => 0;
    const paid = await use(pc().id, 'patient_defense', { option: 'focus' });
    expect((paid as { temp_hp?: number }).temp_hp).toBe(2);
    expect(pc().temp_hp).toBe(2);
    expect(pc().flags.dodging).toBe(true);
    expect(left(id, 'monk-monks-focus')).toBe(9);
  });

  it('rolls the Martial Arts die twice, so a d8 that peaks twice gives sixteen', async () => {
    monk();
    await ambush();
    await turnOf(pc().id);
    Math.random = () => 0.9999;
    const paid = await use(pc().id, 'patient_defense', { option: 'focus' });
    expect((paid as { temp_hp?: number }).temp_hp).toBe(16);
  });

  it('leaves the free Patient Defense with no temporary hit points', async () => {
    const id = monk();
    await ambush();
    await turnOf(pc().id);
    const free = await use(pc().id, 'patient_defense');
    expect((free as { temp_hp?: number }).temp_hp).toBeUndefined();
    expect(pc().temp_hp).toBe(0);
    expect(pc().flags.disengaged).toBe(true);
    expect(left(id, 'monk-monks-focus')).toBe(10);
  });
});

// --- 3. Cunning Strike's Trip is Large or smaller -----------------------------

describe("P4c Cunning Strike's Trip is Large or smaller", () => {
  const rogue = (): number => build('rogue', 5, { subclass: 'Thief', gear: ['Rapier'], abilities: { str: 10, dex: 15 } });

  it('refuses Trip against a Huge target and keeps the 1d6 it would have cost', async () => {
    rogue();
    await ambush();
    db.prepare("UPDATE combatant SET size = 'H' WHERE id = ?").run(foe().id);
    await turnOf(pc().id);
    const huge = await swing(pc().id, foe().id, 'Rapier', { advantage: 'advantage', cunning_strike: ['trip'] });
    expect(named(huge, 'Cunning Strike')).toBeUndefined();
    expect(named(huge, 'Sneak Attack')!.note).not.toMatch(/traded for/);
    expect(named(huge, 'Sneak Attack')!.note).toMatch(/3d6 extra/);
  });

  it('lands Trip on a Large target and pays the die for it', async () => {
    rogue();
    await ambush();
    db.prepare("UPDATE combatant SET size = 'L' WHERE id = ?").run(foe().id);
    await turnOf(pc().id);
    const large = await swing(pc().id, foe().id, 'Rapier', { advantage: 'advantage', cunning_strike: ['trip'] });
    expect(named(large, 'Cunning Strike')).toMatchObject({ condition: 'prone' });
    expect(named(large, 'Sneak Attack')!.note).toMatch(/1d6 traded for trip/);
    expect(named(large, 'Sneak Attack')!.note).toMatch(/2d6 extra/);
  });
});
