import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  applyDamage,
  awardXp,
  createCharacter,
  createCompanion,
  heal,
  levelUp,
  levelUpOptions,
  rest,
  spendFeatureResource,
  type CreateCharacterInput,
  type LevelUpChoices,
} from '../src/core/character.js';
import { legalActions } from '../src/combat/actions.js';
import { advanceTurn, attack, endEncounter, startEncounter, useAction } from '../src/combat/engine.js';
import { classFeatures, critRangeOf, FEATURES, relentlessRageDc, resourceState } from '../src/combat/features.js';
import { attacksPerAction, combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import { classLevelRow, findClass, findSpecies, skillChoiceGroups, spellsForClass } from '../src/srd/lookup.js';
import { openDb, type Db } from '../src/db/connection.js';
import { updateSettings } from '../src/core/settings.js';
import * as srd from '../src/srd/data.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const hit = { total: 40, natural: 12 };
const miss = { total: 2, natural: 2 };

// --- building a character of the highest levels --------------------------------

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
function climbTo(
  characterId: number,
  level: number,
  subclass: string,
  picks: Record<string, string[]> = {},
  boon = 'Boon of Combat Prowess',
): void {
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
      choices.feat = options.epic_boon.feat_options.some((f) => f.name === boon)
        ? boon
        : options.epic_boon.feat_options[0]!.name;
      choices.feat_choices = { ability: 'str' };
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

const ABILITIES = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };

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

const SUBCLASS: Record<string, string> = {
  barbarian: 'Path of the Berserker',
  bard: 'College of Lore',
  cleric: 'Life Domain',
  druid: 'Circle of the Land',
  fighter: 'Champion',
  monk: 'Warrior of the Open Hand',
  paladin: 'Oath of Devotion',
  ranger: 'Hunter',
  rogue: 'Thief',
  sorcerer: 'Draconic Sorcery',
  warlock: 'Fiend Patron',
  wizard: 'Evoker',
};

/** A character of this class at this level, with the gear, the picks and the Epic Boon the test wants. */
function hero(
  cls: string,
  level: number,
  options: {
    abilities?: Partial<typeof ABILITIES>;
    gear?: string[];
    picks?: Record<string, string[]>;
    boon?: string;
    name?: string;
  } = {},
): number {
  const id = make({
    class: cls,
    name: options.name ?? cls,
    abilities: { ...ABILITIES, ...options.abilities },
    ...(options.picks ? { feature_options: options.picks } : {}),
  });
  if (level > 1) climbTo(id, level, SUBCLASS[cls]!, options.picks ?? {}, options.boon ?? 'Boon of Combat Prowess');
  arm(id, ...(options.gear ?? ['Longsword']));
  return id;
}

const arm = (id: number, ...items: string[]): void => {
  db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(
    JSON.stringify(items.map((name) => ({ name, qty: 1, equipped: true }))),
    id,
  );
};

const featureRow = (id: number, name: string): { name: string; mechanics?: Record<string, unknown> } | undefined =>
  (
    JSON.parse(
      (db.prepare('SELECT features_json FROM character WHERE id = ?').get(id) as { features_json: string }).features_json,
    ) as Array<{ name: string; mechanics?: Record<string, unknown> }>
  ).find((f) => f.name === name);

// --- the battlefield ----------------------------------------------------------

interface Opened {
  persistent_rage_available?: Array<{ combatant_id: number; name: string; rages: number }>;
}

async function ambush(enemies = 1, creature = 'Goblin Warrior'): Promise<Opened> {
  const opened = (await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature, count: enemies }],
  })) as unknown as Opened;
  const state = getBattleState(db, campaignId)!;
  const rows = Array.from({ length: 14 }, () => '.'.repeat(60));
  const map: BattleMap = { w: 60, h: 14, rows, features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
  let x = 3;
  for (const c of listCombatants(db, state.encounter.id)) {
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, 5, c.id);
    x += 1;
  }
  db.prepare("UPDATE combatant SET hp_max = 400, hp_current = 400 WHERE team = 'enemy'").run();
  return opened;
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

const cast = (actor: number, spell: string, extra: Record<string, unknown> = {}) =>
  useAction(db, { campaign_id: campaignId, actor_id: actor, action_name: spell, spell, ...extra });

interface FeatureEffect {
  feature: string;
  damage?: number;
  note?: string;
  temp_hp?: number;
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

/** Spends a class resource on the sheet, so a feature that gives one back has something to give. */
const spend = (id: number, resource: string, amount = 1): void => {
  spendFeatureResource(db, { campaign_id: campaignId, character_id: id, resource, amount });
};

const left = (id: number, index: string): number | null => {
  const state = resourceState(combatSheet(db, id), FEATURES[index]!);
  return state ? state.left : null;
};

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'The High Levels', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
    .campaign_id;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

// --- 1. the registry ----------------------------------------------------------

describe('the feature registry at levels 11 to 20', () => {
  it('covers every class and subclass feature the SRD gives from level 11 up', () => {
    const skip = /subclass|ability score improvement|weapon mastery|spellcasting/i;
    const missing = srd
      .features()
      .filter((f) => Number(String(f.level?.index ?? '').split('-').pop()) >= 11)
      .filter((f) => !skip.test(f.name))
      .filter((f) => FEATURES[f.index] === undefined)
      .map((f) => f.index);
    expect(missing).toEqual([]);
  });

  it('says why each of the high-level features it does not apply is left to the DM', () => {
    const handed = Object.values(FEATURES).filter((h) => h.level >= 11 && h.dm_applied);
    expect(handed.map((h) => h.index).sort()).toEqual([
      'draconic-sorcery-dragon-companion',
      'draconic-sorcery-dragon-wings',
      'ranger-feral-senses',
      'thief-thiefs-reflexes',
      'warlock-eldritch-master',
    ]);
    for (const handler of handed) expect(handler.dm_applied!.length, handler.index).toBeGreaterThan(20);
  });

  it('keeps a level 20 action away from a character who has not earned it', async () => {
    hero('rogue', 10, { gear: ['Shortsword'] });
    await ambush();
    startTurn(pc().id);
    expect(actionIds(pc().id)).not.toContain('feature:stroke_of_luck');
    await expect(use(pc().id, 'stroke_of_luck')).rejects.toThrow(/no class feature action/i);
  });
});

// --- 2. Barbarian -------------------------------------------------------------

describe('the Barbarian above level 10', () => {
  it('stands back up on twice its level when a Rage would drop it (Relentless Rage)', async () => {
    const id = hero('barbarian', 11, { gear: ['Greataxe'] });
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'rage');
    db.prepare('UPDATE combatant SET hp_current = 5 WHERE id = ?').run(pc().id);
    db.prepare('UPDATE character SET hp_current = 5 WHERE id = ?').run(id);
    startTurn(foe().id);
    const felled = await use(foe().id, 'a crushing blow', {
      target_id: pc().id,
      damage_expr: '50',
      damage_type: 'force',
    });
    expect(texts(felled)).toMatch(/refuses to fall/);
    expect(pc().hp_current).toBe(22);
    expect(texts(felled)).toMatch(/The next one is DC 15/);
  });

  it('counts every Relentless Rage attempt towards the DC, and a rest puts it back to 10', async () => {
    const id = hero('barbarian', 11, { gear: ['Greataxe'] });
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'rage');
    const drop = async (): Promise<unknown> => {
      db.prepare("UPDATE combatant SET hp_current = 5, conditions_json = '[]' WHERE id = ?").run(pc().id);
      db.prepare("UPDATE character SET hp_current = 5, status = 'active', conditions_json = '[]' WHERE id = ?").run(id);
      startTurn(foe().id);
      return use(foe().id, 'a crushing blow', { target_id: pc().id, damage_expr: '50', damage_type: 'force' });
    };
    // A natural 1 on the CON save: the feature was used even though it did not hold.
    Math.random = () => 0.351;
    const failed = await drop();
    expect(texts(failed)).toMatch(/rage is not enough this time/);
    expect(texts(failed)).toMatch(/The next one is DC 15/);
    Math.random = () => 0.5;
    heal(db, { campaign_id: campaignId, character_id: id, amount: 40 });
    const second = await drop();
    expect(texts(second)).toMatch(/vs DC 15/);
    expect(relentlessRageDc(combatSheet(db, id))).toBe(20);
    // The count is on the sheet, not on the fight: a short rest wipes it - so the fight has to be over first.
    endEncounter(db, { campaign_id: campaignId, outcome: 'retreat' });
    rest(db, { campaign_id: campaignId, character_id: id, kind: 'short' });
    expect(relentlessRageDc(combatSheet(db, id))).toBe(10);
  });

  it('adds Staggering and Sundering to Brutal Strike at 13, and a second effect and 2d10 at 17', async () => {
    hero('barbarian', 13, { gear: ['Greataxe'] });
    await ambush();
    startTurn(pc().id);
    const staggered = await swing(pc().id, foe().id, 'Greataxe', { reckless: true, brutal_strike: 'staggering' });
    expect(named(staggered, 'Improved Brutal Strike')?.stance).toEqual({ staggered: true });
    expect(byId(foe().id).flags.staggered).toBe(true);
    // Two effects at once are refused until level 17.
    startTurn(pc().id);
    await expect(
      swing(pc().id, foe().id, 'Greataxe', { reckless: true, brutal_strike: ['staggering', 'sundering'] }),
    ).rejects.toThrow(/carries 1 effect/);
  });

  it('carries two Brutal Strike effects and 2d10 at level 17', async () => {
    hero('barbarian', 17, { gear: ['Greataxe'] });
    await ambush();
    startTurn(pc().id);
    const both = await swing(pc().id, foe().id, 'Greataxe', { reckless: true, brutal_strike: ['hamstring', 'sundering'] });
    expect(named(both, 'Brutal Strike')?.note).toMatch(/2d10/);
    expect(byId(foe().id).flags.sundering_blow?.by_id).toBe(pc().id);
    expect(byId(foe().id).flags.slowed_by).toBeDefined();
  });

  it('frightens everything within 30 ft for a Bonus Action (Intimidating Presence)', async () => {
    const id = hero('barbarian', 14, { gear: ['Greataxe'] });
    await ambush(2);
    startTurn(pc().id);
    const roar = await use(pc().id, 'intimidating_presence', { rolls: { [String(foe().id)]: { total: 1, natural: 1 } } });
    expect(texts(roar)).toMatch(/primal fury/);
    expect(pc().bonus_used).toBe(true);
    expect(left(id, 'berserker-intimidating-presence')).toBe(0);
    expect(byId(foe().id).conditions).toContain('frightened');
  });

  it('offers every Rage back when Initiative is rolled, and takes nothing unasked (Persistent Rage)', async () => {
    const id = hero('barbarian', 15, { gear: ['Greataxe'] });
    spend(id, 'rage', 3);
    expect(left(id, 'barbarian-rage')).toBe(2);
    const opened = await ambush();
    // "you can regain": offered, and neither the Rages nor the use move until the DM says so.
    expect(opened.persistent_rage_available?.[0]?.rages).toBe(3);
    expect(left(id, 'barbarian-rage')).toBe(2);
    expect(left(id, 'barbarian-persistent-rage')).toBe(1);
    await turnOf(pc().id);
    expect(actionIds(pc().id)).toContain('feature:persistent_rage_regain');
    const taken = await use(pc().id, 'persistent_rage_regain');
    expect(texts(taken)).toMatch(/every expended use of Rage comes back/);
    expect(left(id, 'barbarian-rage')).toBe(5);
    expect(left(id, 'barbarian-persistent-rage')).toBe(0);
  });

  it("closes the Persistent Rage window at the end of the Barbarian's first turn", async () => {
    const id = hero('barbarian', 15, { gear: ['Greataxe'] });
    spend(id, 'rage', 3);
    await ambush();
    await turnOf(pc().id);
    await advanceTurn(db, campaignId);
    expect(pc().flags.persistent_rage_offered).toBeUndefined();
    await turnOf(pc().id);
    await expect(use(pc().id, 'persistent_rage_regain')).rejects.toThrow(/offered when .* rolls Initiative/);
    expect(left(id, 'barbarian-rage')).toBe(2);
    expect(left(id, 'barbarian-persistent-rage')).toBe(1);
  });

  it('keeps Intimidating Presence on offer at 0 uses while a Rage can buy it back', async () => {
    const id = hero('barbarian', 14, { gear: ['Greataxe'] });
    await ambush(2);
    await turnOf(pc().id);
    await use(pc().id, 'intimidating_presence', { rolls: { [String(foe().id)]: { total: 1, natural: 1 } } });
    expect(left(id, 'berserker-intimidating-presence')).toBe(0);
    await advanceTurn(db, campaignId);
    await turnOf(pc().id);
    const offered = legalActions(byId(pc().id), combatSheet(db, id)).find(
      (a) => a.id === 'feature:intimidating_presence',
    );
    expect(offered?.hint).toMatch(/No uses left: this one costs a use of Rage/);
    const rages = left(id, 'barbarian-rage')!;
    const roar = await use(pc().id, 'intimidating_presence', { rolls: { [String(foe().id)]: { total: 1, natural: 1 } } });
    expect(texts(roar)).toMatch(/paid for with a use of Rage/);
    expect(left(id, 'barbarian-rage')).toBe(rages - 1);
    // With no Rage left either, it drops off the list.
    spend(id, 'rage', left(id, 'barbarian-rage')!);
    await advanceTurn(db, campaignId);
    await turnOf(pc().id);
    expect(actionIds(pc().id)).not.toContain('feature:intimidating_presence');
  });

  it('counts a Strength save as the Strength score when the roll comes out lower (Indomitable Might)', async () => {
    hero('barbarian', 18, { gear: ['Greataxe'] });
    await ambush();
    startTurn(foe().id);
    const shoved = await use(foe().id, 'a shove of raw force', {
      target_id: pc().id,
      save_ability: 'str',
      save_dc: 30,
      rolls: { [String(pc().id)]: { total: 4, natural: 3 } },
    });
    const save = (shoved as { targets: Array<{ save: { total: number; notes: string[] } }> }).targets[0]!.save;
    expect(save.notes.join(' ')).toMatch(/Indomitable Might/);
    expect(save.total).toBe(combatSheet(db, pc().character_id!).abilities.str!.score);
  });

  it('raises Strength and Constitution by 4 at level 20 (Primal Champion)', () => {
    const id = hero('barbarian', 19, { gear: ['Greataxe'] });
    const before = sheetOf(id).abilities as Record<string, { score: number }>;
    const str = before.str!.score;
    const con = before.con!.score;
    climbTo(id, 20, SUBCLASS.barbarian!);
    const after = sheetOf(id).abilities as Record<string, { score: number }>;
    expect(after.str!.score).toBe(Math.min(25, str + 4));
    expect(after.con!.score).toBe(Math.min(25, con + 4));
  });
});

// --- 3. Fighter ---------------------------------------------------------------

describe('the Fighter above level 10', () => {
  it('swings three times at 11 (Two Extra Attacks)', () => {
    const eleven = hero('fighter', 11);
    expect(attacksPerAction(combatSheet(db, eleven))).toBe(3);
    expect(combatSheet(db, eleven).features.some((entry) => entry.name === 'Two Extra Attacks')).toBe(true);
  });

  it('has Advantage on the next swing at a creature it missed (Studied Attacks)', async () => {
    hero('fighter', 13);
    await ambush();
    startTurn(pc().id);
    const missed = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: miss,
    });
    expect(named(missed, 'Studied Attacks')).toBeDefined();
    expect(pc().flags.studied_target?.target_id).toBe(foe().id);
    const again = await swing(pc().id, foe().id, 'Longsword');
    expect((again as { advantage: string }).advantage).toBe('advantage');
    // "Advantage on your next attack roll against that creature": the one swing, and no more.
    expect(pc().flags.studied_target).toBeUndefined();
    const third = await swing(pc().id, foe().id, 'Longsword');
    expect((third as { advantage: string }).advantage).not.toBe('advantage');
  });

  it('rerolls a failed saving throw with its level on it, and only then spends the use (Indomitable)', async () => {
    const id = hero('fighter', 13);
    await ambush();
    startTurn(pc().id);
    const declared = await use(pc().id, 'indomitable');
    expect(pc().flags.d20_stance?.feature).toBe('Indomitable');
    expect(left(id, 'fighter-indomitable')).toBe(2);
    startTurn(foe().id);
    const forced = await use(foe().id, 'a blast of fear', {
      target_id: pc().id,
      save_ability: 'wis',
      save_dc: 25,
      rolls: { [String(pc().id)]: { total: 3, natural: 2 } },
    });
    const save = (forced as { targets: Array<{ save: { total: number; notes: string[] } }> }).targets[0]!.save;
    expect(save.notes.join(' ')).toMatch(/Indomitable: the roll is made again with \+13/);
    expect(left(id, 'fighter-indomitable')).toBe(1);
    expect(pc().flags.d20_stance).toBeUndefined();
    expect(declared.log.length).toBeGreaterThan(0);
  });

  it('crits on an 18 at level 15 (Superior Critical)', () => {
    expect(critRangeOf(combatSheet(db, hero('fighter', 15)))).toBe(18);
    expect(critRangeOf(combatSheet(db, hero('fighter', 14, { name: 'Younger' })))).toBe(19);
  });

  it('rolls its death saves with Advantage and counts an 18 as a 20 (Survivor)', async () => {
    const id = hero('fighter', 18);
    await ambush();
    // This seed rolls a natural 18 with Advantage: not a 20, but Defy Death counts it as one.
    Math.random = () => 0.038;
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: sheetOf(id).hp_current ?? 0 });
    let seen = '';
    for (let step = 0; step < 6 && byId(pc().id).hp_current === 0; step += 1) {
      seen += texts(await advanceTurn(db, campaignId));
    }
    // An 18 is not a natural 20, so only Defy Death could have put them back on their feet.
    expect(seen).toMatch(/death save: critical_success/);
    expect(byId(pc().id).hp_current).toBeGreaterThan(0);
  });

  it('sends the death save to the player with Advantage, and counts their 18 as a 20 (Survivor)', async () => {
    const id = hero('fighter', 18);
    updateSettings(db, campaignId, { roll_mode: 'player', player_rolls: 'd20_only' });
    const stopClicking = resolvePendingRollsImmediately(db);
    try {
      await ambush();
      Math.random = () => 0.038;
      applyDamage(db, { campaign_id: campaignId, character_id: id, amount: sheetOf(id).hp_current ?? 0 });
      let seen = '';
      for (let step = 0; step < 6 && byId(pc().id).hp_current === 0; step += 1) {
        seen += texts(await advanceTurn(db, campaignId));
      }
      const card = db
        .prepare(
          "SELECT advantage, purpose FROM pending_roll WHERE campaign_id = ? AND roll_type = 'save' ORDER BY id DESC",
        )
        .get(campaignId) as { advantage: string; purpose: string };
      expect(card.advantage).toBe('advantage');
      expect(card.purpose).toMatch(/Survivor/);
      expect(seen).toMatch(/death save: critical_success/);
      expect(byId(pc().id).hp_current).toBeGreaterThan(0);
    } finally {
      stopClicking();
    }
  });

  it('shows a declared Indomitable as armed on a later turn (class_features)', async () => {
    const id = hero('fighter', 13);
    await ambush();
    await turnOf(pc().id);
    await use(pc().id, 'indomitable');
    await advanceTurn(db, campaignId);
    await turnOf(pc().id);
    const armed = classFeatures(combatSheet(db, id), byId(pc().id)).find((f) => f.name === 'Indomitable')!;
    expect(armed.active).toBe(true);
    expect(armed.stance_mode).toBe('reroll');
  });

  it('heals at the top of its turn while Bloodied (Survivor)', async () => {
    const id = hero('fighter', 18);
    await ambush();
    const half = Math.floor(pc().hp_max / 2) - 2;
    db.prepare('UPDATE combatant SET hp_current = ? WHERE id = ?').run(half, pc().id);
    db.prepare('UPDATE character SET hp_current = ? WHERE id = ?').run(half, id);
    let turns = 0;
    while (byId(pc().id).hp_current === half && turns < 6) {
      await advanceTurn(db, campaignId);
      turns += 1;
    }
    expect(byId(pc().id).hp_current).toBeGreaterThan(half);
  });
});

// --- 4. Rogue -----------------------------------------------------------------

describe('the Rogue above level 10', () => {
  it('puts two Cunning Strike effects on one Sneak Attack (Improved Cunning Strike)', async () => {
    hero('rogue', 11, { gear: ['Shortsword'] });
    await ambush();
    startTurn(pc().id);
    const struck = await swing(pc().id, foe().id, 'Shortsword', {
      advantage: 'advantage',
      cunning_strike: ['trip', 'withdraw'],
    });
    expect(named(struck, 'Sneak Attack')?.note).toMatch(/2d6 traded for trip and withdraw/);
  });

  it('adds Daze, Obscure and Knock Out at their own die costs (Devious Strikes)', async () => {
    hero('rogue', 14, { gear: ['Shortsword'] });
    await ambush();
    startTurn(pc().id);
    const before = byId(foe().id).conditions;
    const dazed = await swing(pc().id, foe().id, 'Shortsword', {
      advantage: 'advantage',
      cunning_strike: ['daze'],
      rolls: { [String(foe().id)]: { total: 1, natural: 1 } },
    });
    expect(named(dazed, 'Sneak Attack')?.note).toMatch(/2d6 traded for daze/);
    // There is no Dazed condition in the SRD: the engine states the limit and leaves it to the DM.
    expect(named(dazed, 'Devious Strikes')?.note).toMatch(/move or take an action or a Bonus Action, not both/);
    expect(byId(foe().id).conditions).toEqual(before);
    expect(byId(foe().id).conditions).not.toContain('dazed');
    // Six dice of Knock Out is more than a level 14 Rogue can pay and still deal damage.
    startTurn(pc().id);
    await expect(
      swing(pc().id, foe().id, 'Shortsword', { advantage: 'advantage', cunning_strike: ['knock_out', 'obscure'] }),
    ).rejects.toThrow(/at least one die/);
  });

  it("blinds a creature until the end of its own next turn (Devious Strikes: Obscure)", async () => {
    hero('rogue', 20, { gear: ['Shortsword'] });
    await ambush();
    await turnOf(pc().id);
    await swing(pc().id, foe().id, 'Shortsword', {
      advantage: 'advantage',
      cunning_strike: ['obscure'],
      rolls: { [String(foe().id)]: { total: 1, natural: 1 } },
    });
    expect(byId(foe().id).conditions).toContain('blinded');
    // The goblin takes its turn blinded, and the condition lifts when that turn ends.
    await turnOf(foe().id);
    expect(byId(foe().id).conditions).toContain('blinded');
    await advanceTurn(db, campaignId);
    expect(byId(foe().id).conditions).not.toContain('blinded');
  });

  it('attunes to four magic items (Use Magic Device)', () => {
    const thief = hero('rogue', 13, { gear: ['Shortsword'] });
    const younger = hero('rogue', 12, { gear: ['Shortsword'], name: 'Younger' });
    expect((sheetOf(thief) as unknown as { attunement: { max: number } }).attunement.max).toBe(4);
    expect((sheetOf(younger) as unknown as { attunement: { max: number } }).attunement.max).toBe(3);
  });

  it('is proficient in Wisdom and Charisma saving throws (Slippery Mind)', () => {
    const id = hero('rogue', 15, { gear: ['Shortsword'] });
    const saves = sheetOf(id).saves as Record<string, { proficient: boolean }>;
    expect(saves.wis!.proficient).toBe(true);
    expect(saves.cha!.proficient).toBe(true);
  });

  it('lets no attack roll have Advantage against it (Elusive)', async () => {
    hero('rogue', 18, { gear: ['Shortsword'] });
    await ambush();
    startTurn(foe().id);
    const swung = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Scimitar',
      roll: hit,
      advantage: 'advantage',
    });
    expect((swung as { advantage: string }).advantage).toBe('none');
    expect(texts(swung)).toMatch(/Elusive/);
  });

  it('turns a failed D20 Test into a 20 once per short rest (Stroke of Luck)', async () => {
    const id = hero('rogue', 20, { gear: ['Shortsword'] });
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'stroke_of_luck');
    expect(pc().flags.d20_stance?.mode).toBe('set_20');
    const missed = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Shortsword',
      roll: miss,
    });
    expect((missed as { hit: boolean }).hit).toBe(true);
    expect(texts(missed)).toMatch(/turned into a 20/);
    expect(left(id, 'rogue-stroke-of-luck')).toBe(0);
  });
});

// --- 5. Monk ------------------------------------------------------------------

describe('the Monk above level 10', () => {
  it('takes Step of the Wind on the heels of a Bonus Action, and not before one (Fleet Step)', async () => {
    hero('monk', 11, { gear: [] });
    await ambush();
    startTurn(pc().id);
    await expect(use(pc().id, 'fleet_step')).rejects.toThrow(/follows a Bonus Action/);
    await use(pc().id, 'patient_defense');
    const stepped = await use(pc().id, 'fleet_step');
    expect(texts(stepped)).toMatch(/Fleet Step/);
    expect(byId(pc().id).flags.dashed).toBe(true);
  });

  it("stuns to the start of the Monk's next turn, not the goblin's (Stunning Strike)", async () => {
    hero('monk', 11, { gear: [] });
    await ambush();
    await turnOf(pc().id);
    await swing(pc().id, foe().id, 'Unarmed Strike', {
      stunning_strike: true,
      rolls: { [String(foe().id)]: { total: 1, natural: 1 } },
    });
    expect(byId(foe().id).conditions).toContain('stunned');
    // The goblin's own turn comes and goes with the Stunned condition still on it.
    await turnOf(foe().id);
    expect(byId(foe().id).conditions).toContain('stunned');
    await turnOf(pc().id);
    expect(byId(foe().id).conditions).not.toContain('stunned');
  });

  it('buys the Disengage half of Step of the Wind for a Focus Point (Fleet Step)', async () => {
    const id = hero('monk', 11, { gear: [] });
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'patient_defense');
    const focus = left(id, 'monk-monks-focus');
    const stepped = await use(pc().id, 'fleet_step_focus');
    expect(texts(stepped)).toMatch(/Disengage and Dash actions both/);
    expect(byId(pc().id).flags.dashed).toBe(true);
    expect(byId(pc().id).flags.disengaged).toBe(true);
    expect(left(id, 'monk-monks-focus')).toBe(focus! - 1);
  });

it('offers Deflect Attacks against fire only once Deflect Energy has arrived', () => {
    const older = hero('monk', 13, { gear: [] });
    const younger = hero('monk', 12, { gear: [], name: 'Younger' });
    const handler = FEATURES['monk-deflect-attacks']!;
    const ask = (id: number) => {
      const sheet = combatSheet(db, id);
      return handler.onDamageTaken!({
        sheet,
        feature: { name: 'Deflect Attacks' },
        actor: { name: sheet.name, flags: {}, reaction_used: false, conditions: [] } as unknown as Combatant,
        attacker: { name: 'Goblin Warrior' } as unknown as Combatant,
        damage: 12,
        damage_type: 'fire',
        distance_ft: 5,
      });
    };
    expect(ask(older)).not.toBeNull();
    expect(ask(younger)).toBeNull();
  });

  it('is proficient in every save and rerolls a failed one for a Focus Point (Disciplined Survivor)', async () => {
    const id = hero('monk', 14, { gear: [] });
    const saves = sheetOf(id).saves as Record<string, { proficient: boolean }>;
    expect(Object.values(saves).every((entry) => entry.proficient)).toBe(true);
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'disciplined_survivor');
    const focus = left(id, 'monk-monks-focus');
    startTurn(foe().id);
    const forced = await use(foe().id, 'a wave of dread', {
      target_id: pc().id,
      save_ability: 'cha',
      save_dc: 25,
      rolls: { [String(pc().id)]: { total: 2, natural: 2 } },
    });
    const save = (forced as { targets: Array<{ save: { notes: string[] } }> }).targets[0]!.save;
    expect(save.notes.join(' ')).toMatch(/Disciplined Survivor: the roll is made again/);
    expect(left(id, 'monk-monks-focus')).toBe(focus! - 1);
  });

  it('comes back up to four Focus Points when Initiative is rolled (Perfect Focus)', async () => {
    const id = hero('monk', 15, { gear: [] });
    spend(id, 'focus_points', 14);
    expect(left(id, 'monk-monks-focus')).toBe(1);
    await ambush();
    expect(left(id, 'monk-monks-focus')).toBe(4);
  });

  it('sets lethal vibrations and ends them for 10d12 (Quivering Palm)', async () => {
    const id = hero('monk', 17, { gear: [] });
    await ambush();
    startTurn(pc().id);
    const set = await swing(pc().id, foe().id, 'Unarmed Strike', { quivering_palm: true });
    expect(named(set, 'Quivering Palm')).toBeDefined();
    expect(byId(foe().id).flags.quivering_palm?.monk_id).toBe(pc().id);
    expect(left(id, 'monk-monks-focus')).toBe(13);
    startTurn(pc().id);
    const ended = await use(pc().id, 'quivering_palm', {
      target_id: foe().id,
      rolls: { [String(foe().id)]: { total: 1, natural: 1 } },
    });
    expect(texts(ended)).toMatch(/force damage/);
    expect(byId(foe().id).flags.quivering_palm).toBeUndefined();
  });

  it('carries its vibrations on one creature at a time (Quivering Palm)', async () => {
    hero('monk', 17, { gear: [] });
    await ambush(2);
    // Both goblins within the Monk's reach, whichever way initiative ordered them.
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(pc().x + 1, pc().y, foe(0).id);
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(pc().x - 1, pc().y, foe(1).id);
    await turnOf(pc().id);
    await swing(pc().id, foe(0).id, 'Unarmed Strike', { quivering_palm: true });
    expect(byId(foe(0).id).flags.quivering_palm?.monk_id).toBe(pc().id);
    await advanceTurn(db, campaignId);
    await turnOf(pc().id);
    const moved = await swing(pc().id, foe(1).id, 'Unarmed Strike', { quivering_palm: true });
    expect(texts(moved)).toMatch(/only one creature carries them at a time/);
    expect(byId(foe(1).id).flags.quivering_palm?.monk_id).toBe(pc().id);
    expect(byId(foe(0).id).flags.quivering_palm).toBeUndefined();
  });

  it('resists everything but Force for three Focus Points (Superior Defense)', async () => {
    hero('monk', 18, { gear: [] });
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'superior_defense');
    expect(pc().flags.superior_defense).toBeDefined();
    startTurn(foe().id);
    const burned = await use(foe().id, 'a gout of flame', {
      target_id: pc().id,
      damage_expr: '20',
      damage_type: 'fire',
    });
    expect(texts(burned)).toMatch(/resistant/);
    startTurn(foe().id);
    const forced = await use(foe().id, 'a bolt of raw magic', {
      target_id: pc().id,
      damage_expr: '20',
      damage_type: 'force',
    });
    expect(texts(forced)).not.toMatch(/resistant/);
  });

  it('raises Dexterity and Wisdom by 4 at level 20 (Body and Mind)', () => {
    const id = hero('monk', 19, { gear: [] });
    const before = sheetOf(id).abilities as Record<string, { score: number }>;
    const dex = before.dex!.score;
    const wis = before.wis!.score;
    climbTo(id, 20, SUBCLASS.monk!);
    const after = sheetOf(id).abilities as Record<string, { score: number }>;
    expect(after.dex!.score).toBe(Math.min(25, dex + 4));
    expect(after.wis!.score).toBe(Math.min(25, wis + 4));
  });
});

// --- 6. Paladin ---------------------------------------------------------------

describe('the Paladin above level 10', () => {
  it('adds 1d8 Radiant to every melee hit (Radiant Strikes)', async () => {
    hero('paladin', 11);
    await ambush();
    startTurn(pc().id);
    const struck = await swing(pc().id, foe().id, 'Longsword');
    expect(named(struck, 'Radiant Strikes')?.note).toMatch(/1d8 extra Radiant/);
  });

  it('lifts a condition for five points of the pool (Restoring Touch)', async () => {
    const id = hero('paladin', 14);
    await ambush();
    db.prepare("UPDATE combatant SET conditions_json = '[\"frightened\"]' WHERE id = ?").run(pc().id);
    startTurn(pc().id);
    const before = left(id, 'paladin-lay-on-hands');
    const touched = await use(pc().id, 'lay_on_hands_frightened', { target_id: pc().id });
    expect(texts(touched)).toMatch(/frightened condition lifts/);
    expect(byId(pc().id).conditions).not.toContain('frightened');
    expect(left(id, 'paladin-lay-on-hands')).toBe(before! - 5);
  });

  it("shelters the aura with Half Cover after a Divine Smite, through the goblin's own turn (Smite of Protection)", async () => {
    hero('paladin', 15);
    await ambush();
    await turnOf(pc().id);
    await swing(pc().id, foe().id, 'Longsword');
    const smote = await cast(pc().id, 'Divine Smite', { slot_level: 1 });
    expect(texts(smote)).toMatch(/Smite of Protection/);
    expect(pc().flags.smite_protection).toBeDefined();
    // The window runs to the start of the Paladin's next turn, so it outlives the end of this one.
    await turnOf(foe().id);
    expect(pc().flags.smite_protection).toBeDefined();
    const swung = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Scimitar',
      roll: hit,
    });
    expect(texts(swung)).toMatch(/Half Cover inside/);
  });

  it('keeps Holy Nimbus on offer at 0 uses while a level 5 slot can buy it back', async () => {
    const id = hero('paladin', 20);
    await ambush();
    await turnOf(pc().id);
    await use(pc().id, 'holy_nimbus');
    expect(left(id, 'devotion-holy-nimbus')).toBe(0);
    await advanceTurn(db, campaignId);
    await turnOf(pc().id);
    const offered = legalActions(byId(pc().id), combatSheet(db, id)).find((a) => a.id === 'feature:holy_nimbus');
    expect(offered?.hint).toMatch(/No uses left: this one costs a level 5 spell slot/);
    const before = combatSheet(db, id).spell_slots['5']!.used;
    const blazed = await use(pc().id, 'holy_nimbus');
    expect(texts(blazed)).toMatch(/paid for with a level 5 spell slot/);
    expect(combatSheet(db, id).spell_slots['5']!.used).toBe(before + 1);
  });

  it('widens the aura to 30 ft (Aura Expansion)', async () => {
    hero('paladin', 18);
    const squire = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Squire',
      source: { class: 'Fighter', species: 'Human', background: 'Soldier' },
    }).companion!.id;
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'large',
      enemies: [{ creature: 'Goblin Warrior' }],
      extra_party: [squire],
    });
    const ally = combatants().find((c) => c.character_id === squire)!;
    // Twenty feet away: inside the widened aura, and well outside the ten feet it used to be.
    db.prepare('UPDATE combatant SET x = 3, y = 5 WHERE id = ?').run(pc().id);
    db.prepare('UPDATE combatant SET x = 7, y = 5 WHERE id = ?').run(ally.id);
    db.prepare('UPDATE combatant SET x = 9, y = 5 WHERE id = ?').run(foe().id);
    startTurn(foe().id);
    const forced = await use(foe().id, 'a wave of dread', {
      target_id: ally.id,
      save_ability: 'wis',
      save_dc: 25,
      rolls: { [String(ally.id)]: { total: 5, natural: 5 } },
    });
    const save = (forced as { targets: Array<{ save: { notes: string[] } }> }).targets[0]!.save;
    expect(save.notes.join(' ')).toMatch(/Aura of Protection/);
  });

  it('burns the enemies who start their turn in the aura (Holy Nimbus)', async () => {
    const id = hero('paladin', 20);
    await ambush();
    startTurn(pc().id);
    const lit = await use(pc().id, 'holy_nimbus');
    expect(pc().flags.holy_nimbus).toBeDefined();
    expect(left(id, 'devotion-holy-nimbus')).toBe(0);
    expect(texts(lit)).toMatch(/holy light/);
    const before = foe().hp_current;
    let turns = 0;
    while (foe().hp_current === before && turns < 6) {
      await advanceTurn(db, campaignId);
      turns += 1;
    }
    expect(foe().hp_current).toBeLessThan(before);
  });
});

// --- 7. Ranger ----------------------------------------------------------------

describe('the Ranger above level 10', () => {
  const marked = async (id: number): Promise<void> => {
    startTurn(pc().id);
    await cast(pc().id, "Hunter's Mark", { target_id: foe().id });
    expect(left(id, 'ranger-favored-enemy')).toBeGreaterThanOrEqual(0);
  };

  it("sends the mark's damage on to a second creature (Superior Hunter's Prey)", async () => {
    const id = hero('ranger', 11);
    await ambush(2);
    await marked(id);
    startTurn(pc().id);
    const second = foe(1);
    // The marked one within reach, and its neighbour a step behind it.
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(pc().x + 1, pc().y, foe().id);
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(pc().x + 2, pc().y, second.id);
    const before = byId(second.id).hp_current;
    const struck = await swing(pc().id, foe().id, 'Longsword', { prey_target_id: second.id });
    expect(texts(struck)).toMatch(/leaps to/);
    expect(byId(second.id).hp_current).toBeLessThan(before);
  });

  it("holds Concentration on Hunter's Mark through any damage (Relentless Hunter)", async () => {
    const id = hero('ranger', 13);
    await ambush();
    await marked(id);
    startTurn(foe().id);
    const hurt = await use(foe().id, 'a crushing blow', { target_id: pc().id, damage_expr: '40', damage_type: 'force' });
    expect(texts(hurt)).toMatch(/Relentless Hunter/);
    expect(pc().concentration).not.toBeNull();
  });

  it("vanishes for a Bonus Action (Nature's Veil)", async () => {
    const id = hero('ranger', 14);
    await ambush();
    startTurn(pc().id);
    const veiled = await use(pc().id, 'natures_veil');
    expect(texts(veiled)).toMatch(/vanishes/);
    expect(byId(pc().id).conditions).toContain('invisible');
    expect(left(id, 'ranger-natures-veil')).toBe(0);
  });

  it("halves the next blow and resists its type for the turn (Superior Hunter's Defense)", async () => {
    hero('ranger', 15);
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'superior_hunters_defense');
    expect(pc().flags.hunters_defense_ready).toBe(true);
    startTurn(foe().id);
    const swung = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Scimitar',
      roll: hit,
    });
    expect(texts(swung)).toMatch(/takes the blow head on/);
    expect(pc().flags.resisting?.type).toBe('slashing');
  });

  it('has Advantage on the marked creature (Precise Hunter)', async () => {
    const id = hero('ranger', 17);
    await ambush();
    await marked(id);
    startTurn(pc().id);
    const struck = await swing(pc().id, foe().id, 'Longsword');
    expect((struck as { advantage: string }).advantage).toBe('advantage');
    expect((struck as { notes: string[] }).notes.join(' ')).toMatch(/Precise Hunter/);
  });

  it("rolls a d10 for Hunter's Mark (Foe Slayer)", async () => {
    const id = hero('ranger', 20);
    await ambush();
    await marked(id);
    startTurn(pc().id);
    const struck = await swing(pc().id, foe().id, 'Longsword');
    expect(named(struck, "Hunter's Mark")?.note).toMatch(/1d10 force/);
  });
});

// --- 8. Bard ------------------------------------------------------------------

describe('the Bard above level 10', () => {
  it('adds a Bardic Inspiration die to a failed attack roll, and keeps the use when it still fails (Peerless Skill)', async () => {
    const id = hero('bard', 14, { gear: ['Rapier'] });
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'peerless_skill');
    const held = left(id, 'bard-bardic-inspiration');
    // A hopeless roll: the die goes on and still falls short, so nothing is spent.
    const hopeless = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Rapier',
      roll: { total: 2, natural: 2 },
    });
    expect((hopeless as { hit: boolean }).hit).toBe(false);
    expect(texts(hopeless)).toMatch(/Peerless Skill/);
    expect(left(id, 'bard-bardic-inspiration')).toBe(held);
    // One that falls just short: the die turns it, and the use goes.
    startTurn(pc().id);
    const turned = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Rapier',
      roll: { total: foe().ac - 1, natural: 11 },
    });
    expect((turned as { hit: boolean }).hit).toBe(true);
    expect(left(id, 'bard-bardic-inspiration')).toBe(held! - 1);
  });

  it('comes back up to two uses when Initiative is rolled (Superior Inspiration)', async () => {
    const id = hero('bard', 18, { gear: ['Rapier'], abilities: { cha: 15 } });
    const max = left(id, 'bard-bardic-inspiration')!;
    expect(max).toBeGreaterThanOrEqual(2);
    spend(id, 'bardic_inspiration', max);
    expect(left(id, 'bard-bardic-inspiration')).toBe(0);
    await ambush();
    expect(left(id, 'bard-bardic-inspiration')).toBe(2);
  });

  it('sends Power Word Kill at a second creature within 10 ft (Words of Creation)', async () => {
    hero('bard', 20, { gear: ['Rapier'] });
    await ambush(2);
    startTurn(pc().id);
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(pc().x + 1, pc().y, foe().id);
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(pc().x + 2, pc().y, foe(1).id);
    const word = await cast(pc().id, 'Power Word Kill', { target_id: foe().id, twin_target: foe(1).id, slot_level: 9 });
    expect(texts(word)).toMatch(/Words of Creation/);
    expect((word as { targets: unknown[] }).targets).toHaveLength(2);
  });

  it('refuses a second creature standing further than 10 ft from the first (Words of Creation)', async () => {
    const id = hero('bard', 20, { gear: ['Rapier'] });
    await ambush(2);
    startTurn(pc().id);
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(pc().x + 1, pc().y, foe().id);
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(pc().x + 6, pc().y, foe(1).id);
    const before = combatSheet(db, id).spell_slots['9']!.used;
    await expect(
      cast(pc().id, 'Power Word Kill', { target_id: foe().id, twin_target: foe(1).id, slot_level: 9 }),
    ).rejects.toThrow(/within 10 ft of/);
    expect(combatSheet(db, id).spell_slots['9']!.used).toBe(before);
  });

  it('has Power Word Heal and Power Word Kill always prepared (Words of Creation)', async () => {
    const id = hero('bard', 20, { gear: ['Rapier'] });
    const prepared = (sheetOf(id).spells as { prepared: string[] }).prepared;
    expect(prepared).toContain('Power Word Heal');
    expect(prepared).toContain('Power Word Kill');
    await ambush();
    startTurn(pc().id);
    expect(actionIds(pc().id)).toContain('cast:Power Word Heal');
    expect(actionIds(pc().id)).toContain('cast:Power Word Kill');
    // The two are granted, so they do not eat into what the Bard table lets them prepare.
    const granted = (sheetOf(id).spells as { granted?: string[] }).granted ?? [];
    expect(prepared.filter((name) => !granted.includes(name))).toHaveLength(
      classLevelRow('bard', 20).spellcasting!.prepared_spells!,
    );
  });
});

// --- 9. Cleric ----------------------------------------------------------------

describe('the Cleric above level 10', () => {
  it('deals 2d8 with Divine Strike (Improved Blessed Strikes)', async () => {
    hero('cleric', 14, { gear: ['Mace'] });
    await ambush();
    startTurn(pc().id);
    const struck = await swing(pc().id, foe().id, 'Mace');
    expect(named(struck, 'Divine Strike')?.note).toMatch(/2d8 extra/);
  });

  it('rolls no healing dice at all (Supreme Healing)', async () => {
    hero('cleric', 17, { gear: ['Mace'] });
    await ambush();
    startTurn(pc().id);
    db.prepare('UPDATE combatant SET hp_current = 10 WHERE id = ?').run(pc().id);
    db.prepare('UPDATE character SET hp_current = 10 WHERE id = ?').run(pc().character_id);
    await cast(pc().id, 'Cure Wounds', { target_id: pc().id, slot_level: 1 });
    // 2d8 at its highest is 16, and Disciple of Life adds 3 on top: 19, where rolled dice would give 11.
    expect(byId(pc().id).hp_current).toBe(29);
  });

  it('calls for Wish through Divine Intervention (Greater Divine Intervention)', async () => {
    const id = hero('cleric', 20, { gear: ['Mace'] });
    await ambush();
    startTurn(pc().id);
    const wished = await cast(pc().id, 'Wish', { free_cast: 'divine_intervention' });
    expect(texts(wished)).toMatch(/2d4 Long Rests/);
    expect(left(id, 'cleric-divine-intervention')).toBe(0);
  });
});

// --- 10. Druid ----------------------------------------------------------------

describe('the Druid above level 10', () => {
  it("spends a use of Wild Shape on a grove of spectral trees (Nature's Sanctuary)", async () => {
    const id = hero('druid', 14, { gear: ['Quarterstaff'] });
    await ambush();
    startTurn(pc().id);
    const before = left(id, 'druid-wild-shape')!;
    const grove = await use(pc().id, 'natures_sanctuary', { point: { x: pc().x + 1, y: pc().y } });
    expect(texts(grove)).toMatch(/Spectral trees/);
    expect(left(id, 'druid-wild-shape')).toBe(before - 1);
  });

  it('deals 2d8 with Primal Strike (Improved Elemental Fury)', async () => {
    hero('druid', 15, { gear: ['Quarterstaff'], picks: { 'Elemental Fury': ['Primal Strike'] } });
    await ambush();
    startTurn(pc().id);
    const struck = await swing(pc().id, foe().id, 'Quarterstaff');
    expect(named(struck, 'Primal Strike')?.note).toMatch(/2d8 extra/);
  });

  it('casts in a Beast form (Beast Spells)', async () => {
    hero('druid', 18, { gear: ['Quarterstaff'] });
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'wild_shape', { option: 'Wolf' });
    expect(pc().flags.wild_shape).toBeDefined();
    const cantrip = combatSheet(db, pc().character_id!).spells.cantrips[0]!;
    const cast_ = await cast(pc().id, cantrip, { target_id: foe().id });
    expect((cast_ as { action: string }).action).toBe(cantrip);
  });

  it('turns uses of Wild Shape into a spell slot, and gets one back at Initiative (Archdruid)', async () => {
    const id = hero('druid', 20, { gear: ['Quarterstaff'] });
    spend(id, 'wild_shape', left(id, 'druid-wild-shape')!);
    await ambush();
    // Evergreen Wild Shape: rolling Initiative with none left gives one back.
    expect(left(id, 'druid-wild-shape')).toBe(1);
    startTurn(pc().id);
    const woven = await use(pc().id, 'natures_magician', { amount: 1 });
    expect(texts(woven)).toMatch(/level 2 spell slot/);
    expect(left(id, 'druid-wild-shape')).toBe(0);
  });
});

// --- 11. Sorcerer -------------------------------------------------------------

describe('the Sorcerer above level 10', () => {
  it('leaves the wings and the dragon to the DM, with a reason', () => {
    expect(FEATURES['draconic-sorcery-dragon-wings']!.dm_applied).toMatch(/Fly Speed/);
    expect(FEATURES['draconic-sorcery-dragon-companion']!.dm_applied).toMatch(/summoning/);
  });

  it('bends one spell a turn for nothing while Innate Sorcery runs (Arcane Apotheosis)', async () => {
    const id = hero('sorcerer', 20, { gear: ['Dagger'], picks: { Metamagic: ['Empowered Spell', 'Careful Spell'] } });
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'innate_sorcery');
    const points = left(id, 'sorcerer-font-of-magic');
    const bent = await cast(pc().id, 'Fireball', {
      point: { x: foe().x, y: foe().y },
      slot_level: 3,
      metamagic: ['Empowered Spell'],
    });
    expect(texts(bent)).toMatch(/Arcane Apotheosis/);
    expect(pc().flags.apotheosis_used).toBe(true);
    expect(left(id, 'sorcerer-font-of-magic')).toBe(points);
  });
});

// --- 12. Warlock --------------------------------------------------------------

describe('the Warlock above level 10', () => {
  it('casts the level 6 spell it chose, once a long rest and with no slot (Mystic Arcanum)', async () => {
    const id = hero('warlock', 11, { gear: ['Dagger'] });
    const chosen = (featureRow(id, 'Mystic Arcanum')!.mechanics!.options as string[])[0]!;
    await ambush();
    startTurn(pc().id);
    const arcanum = await cast(pc().id, chosen, { free_cast: 'mystic_arcanum', target_id: foe().id });
    expect(texts(arcanum)).toMatch(/Mystic Arcanum/);
    expect(combatSheet(db, id).spell_slots['5']?.used ?? 0).toBe(0);
    // The arcanum is the one spell the level-up recorded, not any Warlock spell of that level.
    startTurn(pc().id);
    // Eyebite is the other level 6 Warlock spell an action can cast; the arcanum is not it.
    const other = 'Eyebite';
    expect(chosen).not.toBe(other);
    await expect(cast(pc().id, other, { free_cast: 'mystic_arcanum', target_id: foe().id })).rejects.toThrow(
      new RegExp(`Mystic Arcanum is ${chosen}, not ${other}`),
    );
    startTurn(pc().id);
    await expect(cast(pc().id, chosen, { free_cast: 'mystic_arcanum', target_id: foe().id })).rejects.toThrow(
      /0 of 1 Mystic Arcanum/,
    );
  });

  it('hurls a creature through the Lower Planes (Hurl Through Hell)', async () => {
    const id = hero('warlock', 14, { gear: ['Dagger'] });
    await ambush();
    startTurn(pc().id);
    const hurled = await swing(pc().id, foe().id, 'Dagger', {
      hurl_through_hell: true,
      rolls: { [String(foe().id)]: { total: 1, natural: 1 } },
    });
    expect(texts(hurled)).toMatch(/Psychic damage/);
    expect(byId(foe().id).conditions).toContain('incapacitated');
    expect(left(id, 'fiend-patron-hurl-through-hell')).toBe(0);
  });

  it("keeps the creature in the Lower Planes to the end of the Warlock's next turn (Hurl Through Hell)", async () => {
    hero('warlock', 14, { gear: ['Dagger'] });
    await ambush();
    await turnOf(pc().id);
    await swing(pc().id, foe().id, 'Dagger', {
      hurl_through_hell: true,
      rolls: { [String(foe().id)]: { total: 1, natural: 1 } },
    });
    expect(byId(foe().id).conditions).toContain('incapacitated');
    // The end of this turn of the Warlock's is not the end of their next one.
    await advanceTurn(db, campaignId);
    expect(byId(foe().id).conditions).toContain('incapacitated');
    await turnOf(pc().id);
    expect(byId(foe().id).conditions).toContain('incapacitated');
    await advanceTurn(db, campaignId);
    expect(byId(foe().id).conditions).not.toContain('incapacitated');
  });

  it('leaves Eldritch Master to the DM, with a reason', () => {
    expect(FEATURES['warlock-eldritch-master']!.dm_applied).toMatch(/Magical Cunning/);
  });
});

// --- 13. Wizard ---------------------------------------------------------------

describe('the Wizard above level 10', () => {
  it('deals maximum damage and pays for the second use (Overchannel)', async () => {
    const id = hero('wizard', 14, { gear: ['Dagger'] });
    await ambush();
    startTurn(pc().id);
    const first = await cast(pc().id, 'Magic Missile', { target_id: foe().id, slot_level: 1, overchannel: true });
    expect(texts(first)).toMatch(/every die at its highest/);
    expect(texts(first)).not.toMatch(/Overchannel burns/);
    expect(left(id, 'evoker-overchannel')).toBe(9);
    const before = pc().hp_current;
    startTurn(pc().id);
    const second = await cast(pc().id, 'Magic Missile', { target_id: foe().id, slot_level: 1, overchannel: true });
    expect(texts(second)).toMatch(/Overchannel burns/);
    expect(byId(pc().id).hp_current).toBeLessThan(before);
  });

  it('casts its mastered spells with no slot at all (Spell Mastery)', async () => {
    const id = hero('wizard', 18, { gear: ['Dagger'], picks: { 'Spell Mastery': ['Magic Missile', 'Misty Step'] } });
    const mastered = (featureRow(id, 'Spell Mastery')!.mechanics!.options as string[]).find(
      (name) => name === 'Magic Missile',
    )!;
    await ambush();
    startTurn(pc().id);
    const before = combatSheet(db, id).spell_slots['1']!.used;
    await cast(pc().id, mastered, { free_cast: 'spell_mastery', target_id: foe().id });
    expect(combatSheet(db, id).spell_slots['1']!.used).toBe(before);
  });

  it('casts each signature spell once before a rest (Signature Spells)', async () => {
    const id = hero('wizard', 20, { gear: ['Dagger'], picks: { 'Signature Spells': ['Fireball', 'Dispel Magic'] } });
    const signature = (featureRow(id, 'Signature Spells')!.mechanics!.options as string[]).find(
      (name) => name === 'Fireball',
    )!;
    await ambush();
    startTurn(pc().id);
    const before = combatSheet(db, id).spell_slots['3']!.used;
    await cast(pc().id, signature, { free_cast: 'signature_spell', target_id: foe().id, point: { x: foe().x, y: foe().y } });
    expect(combatSheet(db, id).spell_slots['3']!.used).toBe(before);
    startTurn(pc().id);
    await expect(
      cast(pc().id, signature, { free_cast: 'signature_spell', target_id: foe().id, point: { x: foe().x, y: foe().y } }),
    ).rejects.toThrow(/0 of 1/);
  });
});

// --- 14. the Epic Boons -------------------------------------------------------

describe('the Epic Boons of level 19', () => {
  it('turns the miss you ask it to into a hit, once until your turn comes round (Boon of Combat Prowess)', async () => {
    hero('fighter', 19, { boon: 'Boon of Combat Prowess' });
    await ambush();
    await turnOf(pc().id);
    const aimAt = (extra: Record<string, unknown> = {}) =>
      attack(db, {
        campaign_id: campaignId,
        attacker_id: pc().id,
        target_id: foe().id,
        action_name: 'Longsword',
        roll: miss,
        ...extra,
      });
    // "you can hit instead": a miss stays a miss until the swing asks for it.
    const plain = await aimAt();
    expect((plain as { hit: boolean }).hit).toBe(false);
    expect(pc().flags.peerless_aim_used).toBeUndefined();
    const aimed = await aimAt({ peerless_aim: true });
    expect((aimed as { hit: boolean }).hit).toBe(true);
    expect(texts(aimed)).toMatch(/Peerless Aim/);
    expect(pc().flags.peerless_aim_used).toBe(true);
    await expect(aimAt({ peerless_aim: true })).rejects.toThrow(/already used Peerless Aim/);
    // It comes back at the start of your next turn, not at every turn boundary the fight passes.
    await turnOf(foe().id);
    expect(pc().flags.peerless_aim_used).toBe(true);
    await turnOf(pc().id);
    expect(pc().flags.peerless_aim_used).toBeUndefined();
  });

  it('ignores Resistance and adds the raised score on a natural 20 (Boon of Irresistible Offense)', async () => {
    hero('fighter', 19, { boon: 'Boon of Irresistible Offense' });
    await ambush(1, 'Skeleton');
    startTurn(pc().id);
    const crit = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: { total: 40, natural: 20 },
    });
    expect(texts(crit)).toMatch(/Overwhelming Strike/);
  });

  it('sometimes keeps the slot a spell was cast with (Boon of Spell Recall)', async () => {
    const id = hero('wizard', 19, { gear: ['Dagger'], boon: 'Boon of Spell Recall' });
    await ambush();
    startTurn(pc().id);
    // A d4 of 1 on a level 1 slot: the slot is not expended at all.
    const before = combatSheet(db, id).spell_slots['1']!.used;
    const cast_ = await cast(pc().id, 'Magic Missile', { target_id: foe().id, slot_level: 1 });
    expect(texts(cast_)).toMatch(/Boon of Spell Recall/);
    expect(combatSheet(db, id).spell_slots['1']!.used).toBe(before);
  });

  it('names both halves of Boon of Fate it leaves to the DM', () => {
    const id = hero('fighter', 19, { boon: 'Boon of Fate' });
    const note = FEATURES['fighter-epic-boon']!.passive!(combatSheet(db, id))!.note!;
    expect(note).toMatch(/lending it to another creature within 60 ft/);
    expect(note).toMatch(/subtracting the 2d4 from a successful D20 Test an enemy made/);
  });

  it('puts 2d4 on a D20 Test that would fail (Boon of Fate)', async () => {
    const id = hero('fighter', 19, { boon: 'Boon of Fate' });
    await ambush();
    startTurn(pc().id);
    await use(pc().id, 'boon_of_fate');
    expect(pc().flags.d20_stance?.dice).toBe('2d4');
    startTurn(foe().id);
    const forced = await use(foe().id, 'a wave of dread', {
      target_id: pc().id,
      save_ability: 'wis',
      save_dc: 25,
      rolls: { [String(pc().id)]: { total: 2, natural: 2 } },
    });
    const save = (forced as { targets: Array<{ save: { notes: string[] } }> }).targets[0]!.save;
    expect(save.notes.join(' ')).toMatch(/Boon of Fate/);
    expect(left(id, 'fighter-epic-boon')).toBe(0);
  });
});
