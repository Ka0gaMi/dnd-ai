// Audit P4a: a feature that adds an ability modifier must keep its sign, and Tireless floors its total.
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
import { attack, startEncounter, useAction } from '../src/combat/engine.js';
import { combatSheet, sheetAbilityMod } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import { classLevelRow, findClass, findSpecies, skillChoiceGroups, spellsForClass } from '../src/srd/lookup.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const hit = { total: 30, natural: 12 };
const failSave = { total: 1, natural: 1 };

const sheetOf = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;

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

/** A character at the level named, with the low ability scores and picks the case needs. */
function build(
  cls: string,
  level: number,
  options: { subclass?: string; abilities?: Partial<typeof ABILITIES>; gear?: string[]; picks?: Record<string, string[]>; cantrips?: string[] } = {},
): number {
  const id = make({
    class: cls,
    name: cls,
    abilities: { ...ABILITIES, ...options.abilities },
    ...(options.picks ? { feature_options: options.picks } : {}),
    ...(options.cantrips ? { cantrips: options.cantrips } : {}),
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

const swing = (attacker: number, target: number, action: string) =>
  attack(db, { campaign_id: campaignId, attacker_id: attacker, target_id: target, action_name: action, roll: hit });

const use = (actor: number, action: string, extra: Record<string, unknown> = {}) =>
  useAction(db, { campaign_id: campaignId, actor_id: actor, action_name: action, ...extra });

const cast = (actor: number, spell: string, extra: Record<string, unknown> = {}) =>
  useAction(db, { campaign_id: campaignId, actor_id: actor, action_name: spell, spell, ...extra });

interface FeatureEffect {
  feature: string;
  damage?: number;
  expr?: string;
  note?: string;
  temp_hp?: number;
}
const featuresIn = (result: unknown): FeatureEffect[] => (result as { features?: FeatureEffect[] }).features ?? [];
const named = (result: unknown, name: string): FeatureEffect | undefined =>
  featuresIn(result).find((f) => f.feature === name);

/** Rewrites the number a named class resource stands at on the stored sheet. */
function forceResource(id: number, key: string, value: number): void {
  const row = db.prepare('SELECT features_json FROM character WHERE id = ?').get(id) as { features_json: string };
  const features = JSON.parse(row.features_json) as Array<{ mechanics?: { resource?: string; max?: number } }>;
  for (const feature of features) {
    if (feature.mechanics?.resource === key) feature.mechanics.max = value;
  }
  db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(features), id);
}

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Audit P4a', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

// --- Ranger Tireless ----------------------------------------------------------

describe('P4a Ranger Tireless floors the total', () => {
  it('floors 1d8 plus a negative Wisdom at 1 temporary hit point', async () => {
    const id = build('ranger', 10, { subclass: 'Hunter', abilities: { wis: 3 } });
    const wis = sheetAbilityMod(combatSheet(db, id), 'wis');
    expect(wis).toBeLessThan(0);
    await ambush();
    startTurn(pc().id);
    // A d8 of 1: 1 + a negative Wisdom would be 0 or less, and the SRD floors the total at 1.
    Math.random = () => 0;
    await use(pc().id, 'tireless');
    expect(pc().temp_hp).toBe(1);
  });
});
