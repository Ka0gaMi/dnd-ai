// A2a-2 wild shape: the form is kept on the character row outside a fight, timed on the world clock, carried
// into and out of fights; plus the species wiring on spell saves, spell attacks and initiative.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addCombatant,
  advanceTurn,
  attack,
  endEncounter,
  startEncounter,
  undoLastCombatAction,
  useAction,
} from '../src/combat/engine.js';
import { FEATURES, resourceState } from '../src/combat/features.js';
import type { BattleMap } from '../src/combat/map.js';
import { combatSheet } from '../src/combat/sheet.js';
import { combatLog, getBattleState, listCombatants, requireEncounter, type Combatant } from '../src/combat/state.js';
import { useFeatureOutsideCombat } from '../src/combat/use-action.js';
import { advanceTime } from '../src/core/calendar.js';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  applyDamage,
  awardXp,
  createCharacter,
  levelUp,
  levelUpOptions,
  setCondition,
  type CreateCharacterInput,
  type LevelUpChoices,
} from '../src/core/character.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import { classLevelRow, findClass, findSpecies, skillChoiceGroups, spellsForClass } from '../src/srd/lookup.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const hit = { total: 30, natural: 12 };

// rpg-dice-roller turns each Math.random into one die through its own integer step, so these are measured.
const D20_1 = 0;
const D20_18 = 0.6;

/** The next dice the engine rolls, in order; anything after them rolls as 0.5. */
function queueRolls(values: number[]): void {
  let index = 0;
  Math.random = () => values[index++] ?? 0.5;
}

// --- building characters ------------------------------------------------------

const ABILITIES = { str: 10, dex: 14, con: 13, int: 15, wis: 15, cha: 15 };

const sheetOf = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;

function skillPicks(cls: string, species: string): string[] {
  const picks: string[] = [];
  for (const group of skillChoiceGroups(findClass(cls), findSpecies(species))) {
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

/** A level 1 caster with an Acolyte's background and the first spells of its list. */
function makeCaster(cls: string, species: string, extra: Partial<CreateCharacterInput> = {}): number {
  const data = findClass(cls);
  const casting = classLevelRow(data.index, 1).spellcasting;
  return createCharacter(db, {
    campaign_id: campaignId,
    name: `${species} ${cls}`,
    class: cls,
    species,
    background: 'Acolyte',
    ability_method: 'manual',
    abilities: ABILITIES,
    ability_bonuses: { wis: 2, cha: 1 },
    skill_choices: skillPicks(cls, species),
    cantrips: spellsForClass(data.index, 0).slice(0, casting?.cantrips_known ?? 0),
    spells: spellsForClass(data.index, 1).slice(0, casting?.prepared_spells ?? 0),
    ...extra,
  } as CreateCharacterInput).character!.id;
}

/** Levels a character to the target level, answering whatever each level asks for. */
function climbTo(characterId: number, level: number): void {
  const owed = XP_THRESHOLDS[level - 1]! - sheetOf(characterId).xp;
  if (owed > 0) awardXp(db, { campaign_id: campaignId, character_id: characterId, amount: owed });
  while (sheetOf(characterId).level < level) {
    const options = levelUpOptions(db, campaignId, characterId) as {
      subclass_choice?: unknown;
      ability_score_improvement?: unknown;
      feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
      spellcasting?: { cantrips_to_add: number; spells_to_add: number; cantrip_options: string[]; spell_options: Record<string, string[]> };
    };
    const character = sheetOf(characterId);
    const choices: LevelUpChoices = { hp: 'average' };
    if (options.subclass_choice) choices.subclass = 'Circle of the Land';
    if (options.ability_score_improvement) choices.ability_increases = { wis: 1, con: 1 } as Partial<Record<Ability, number>>;
    if (options.feature_choices) {
      choices.feature_options = Object.fromEntries(options.feature_choices.map((spec) => [spec.feature, spec.from.slice(0, spec.choose)]));
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

/** A Human Druid at the level given; level 2 is the first with Wild Shape. */
function druid(level = 2, extra: Partial<CreateCharacterInput> = {}): number {
  const id = makeCaster('druid', 'Human', extra);
  climbTo(id, level);
  return id;
}

/** A level 1 Elf fighter, for Fey Ancestry. */
function elfFighter(): number {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Elf',
    class: 'fighter',
    species: 'Elf',
    lineage: 'Elven Lineage: High Elf',
    background: 'Soldier',
    ability_method: 'manual',
    abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: skillPicks('fighter', 'Elf'),
  } as CreateCharacterInput).character!.id;
}

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
  const rows = Array.from({ length: 14 }, () => '.'.repeat(60));
  const map: BattleMap = { w: 60, h: 14, rows, features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
  let x = 3;
  for (const c of [...listCombatants(db, state.encounter.id)].sort((a, b) => a.id - b.id)) {
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, 5, c.id);
    x += 1;
  }
  db.prepare("UPDATE combatant SET hp_max = 200, hp_current = 200 WHERE team = 'enemy'").run();
}

const encounter = () => requireEncounter(db, campaignId);
const combatants = (): Combatant[] => listCombatants(db, encounter().id);
const pc = (): Combatant => combatants().find((c) => c.kind === 'pc')!;
const foe = (): Combatant => combatants().find((c) => c.team === 'enemy')!;
const byCharacter = (id: number): Combatant => combatants().find((c) => c.character_id === id)!;

/** Hands the turn to this combatant with its whole economy back. */
const turnOf = (who: Combatant): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?').run(who.id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === who.id),
    state.encounter.id,
  );
};

const end = () => endEncounter(db, { campaign_id: campaignId, outcome: 'victory' });

const outside = (id: number, action: string, option?: string) =>
  useFeatureOutsideCombat(db, { campaign_id: campaignId, actor_id: id, action_name: action, ...(option ? { option } : {}) }) as Record<
    string,
    unknown
  >;

interface Record_ {
  form: string;
  temp_hp: number;
  started_at: string;
  started_minute: number;
  duration_minutes: number;
}

const record = (id: number): Record_ | null => {
  const row = db.prepare('SELECT wild_shape_json FROM character WHERE id = ?').get(id) as { wild_shape_json: string | null };
  return row.wild_shape_json ? (JSON.parse(row.wild_shape_json) as Record_) : null;
};
const tempHpOf = (id: number): number => combatSheet(db, id).temp_hp;
const usesLeft = (id: number): number => resourceState(combatSheet(db, id), FEATURES['druid-wild-shape']!)!.left;
const texts = (result: unknown): string => (result as { log: Array<{ text: string }> }).log.map((e) => e.text).join('\n');

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Shapes', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

// --- out of a fight -----------------------------------------------------------

describe('Wild Shape outside a fight', () => {
  it('spends the use, grants the temporary hit points and records the form on the world clock', () => {
    const id = druid(2);
    const shifted = outside(id, 'wild_shape', 'Wolf');
    expect(shifted.wild_shape).toMatchObject({ form: 'Wolf', ac: 12, duration_minutes: 60 });
    expect(shifted.temp_hp).toBe(2);
    expect(shifted.uses_left).toBe(1);
    expect(usesLeft(id)).toBe(1);
    expect(tempHpOf(id)).toBe(2);
    expect(record(id)).toMatchObject({ form: 'Wolf', temp_hp: 2, duration_minutes: 60 });
    expect(record(id)!.started_at).toBe((shifted.wild_shape as { started_at: string }).started_at);
  });

  it('reverts outside a fight for no use, and refuses a revert with no form on', () => {
    const id = druid(2);
    expect(() => outside(id, 'wild_shape_revert')).toThrow(/not in a Wild Shape form/);
    outside(id, 'wild_shape', 'Wolf');
    const back = outside(id, 'wild_shape_revert');
    expect(back.wild_shape).toBeNull();
    expect(back.text).toMatch(/drops back into their own shape/);
    expect(record(id)).toBeNull();
    expect(usesLeft(id)).toBe(1);
    expect(() => outside(id, 'wild_shape_revert')).toThrow(/not in a Wild Shape form/);
  });

  it('refuses a shift at no cost: a Beast out of reach, no Beast named, no use left, an Incapacitated Druid', () => {
    const id = druid(2);
    expect(() => outside(id, 'wild_shape', 'Dire Wolf')).toThrow(/CR 1/);
    expect(() => outside(id, 'wild_shape', 'Hawk')).toThrow(/Fly Speed/);
    expect(() => outside(id, 'wild_shape', 'Goblin Warrior')).toThrow(/form of a Beast/);
    expect(() => outside(id, 'wild_shape')).toThrow(/pass option/);
    expect(usesLeft(id)).toBe(2);
    expect(tempHpOf(id)).toBe(0);
    expect(record(id)).toBeNull();

    // A second shift is a new form and a second use; with none left the third is refused and the form stands.
    outside(id, 'wild_shape', 'Wolf');
    outside(id, 'wild_shape', 'Wolf');
    const held = record(id);
    expect(usesLeft(id)).toBe(0);
    expect(() => outside(id, 'wild_shape', 'Wolf')).toThrow(/0 of 2 Wild Shape left/);
    expect(record(id)).toEqual(held);

    const other = druid(2, { name: 'Dazed' });
    setCondition(db, { campaign_id: campaignId, character_id: other, condition: 'stunned', active: true });
    expect(() => outside(other, 'wild_shape', 'Wolf')).toThrow(/incapacitated|stunned/i);
    expect(usesLeft(other)).toBe(2);
    expect(record(other)).toBeNull();
  });
});

// --- into a fight and out again -----------------------------------------------

describe('Wild Shape across fights', () => {
  it('walks into a fight already in the form, with the temporary hit points it has left', async () => {
    const id = druid(2);
    outside(id, 'wild_shape', 'Wolf');
    // Damage taken outside the fight comes off the temporary hit points first, and the fight starts from there.
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: 1 });
    advanceTime(db, campaignId, { minutes: 20 });
    await ambush();
    const wolf = pc();
    expect(wolf.flags.wild_shape).toMatchObject({ form: 'Wolf', rounds_left: 400 });
    expect(wolf.stat_block?.name).toBe('Wolf');
    expect(wolf.ac).toBe(12);
    expect(wolf.speed).toBe(40);
    expect(wolf.temp_hp).toBe(1);
    expect(combatLog(db, encounter().id).map((e) => e.text).join('\n')).toMatch(/still in the Wolf form \(Wild Shape, 40 minutes left\)/);
    // The record stays as it was taken: the start and the duration run on the world clock.
    expect(record(id)).toMatchObject({ form: 'Wolf', duration_minutes: 60 });
  });

  it('keeps the form at the end of the fight, with the temporary hit points left and the original start', async () => {
    const id = druid(2);
    outside(id, 'wild_shape', 'Wolf');
    const taken = record(id)!;
    await ambush();
    turnOf(foe());
    await attack(db, { campaign_id: campaignId, attacker_id: foe().id, target_id: pc().id, action_name: 'Scimitar', roll: hit });
    expect(pc().temp_hp).toBe(0);
    end();
    expect(record(id)).toEqual({ ...taken, temp_hp: 0 });

    // Thirty minutes on, the next fight still finds the Druid a Wolf, with half the hour left.
    advanceTime(db, campaignId, { minutes: 30 });
    await ambush();
    expect(pc().flags.wild_shape).toMatchObject({ form: 'Wolf', rounds_left: 300 });
  });

  it('enters unshaped once the clock has run past the form, and clears the record', async () => {
    const id = druid(2);
    outside(id, 'wild_shape', 'Wolf');
    advanceTime(db, campaignId, { minutes: 60 });
    await ambush();
    expect(pc().flags.wild_shape).toBeUndefined();
    expect(pc().stat_block).toBeNull();
    expect(record(id)).toBeNull();
  });

  it('carries a form into a fight through add_combatant as well', async () => {
    makeCaster('druid', 'Human', { name: 'Lead' });
    const id = druid(2, { name: 'Late', is_pc: false });
    outside(id, 'wild_shape', 'Wolf');
    await ambush();
    expect(combatants().some((c) => c.character_id === id)).toBe(false);
    const joined = await addCombatant(db, { campaign_id: campaignId, character_id: id });
    expect(texts(joined)).toMatch(/still in the Wolf form/);
    expect(byCharacter(id).flags.wild_shape?.form).toBe('Wolf');
    expect(byCharacter(id).ac).toBe(12);
  });

  it('records a form taken in the fight, and clears it when the Druid reverts there', async () => {
    const id = druid(2);
    await ambush();
    turnOf(pc());
    await useAction(db, { campaign_id: campaignId, actor_id: pc().id, action_name: 'wild_shape', option: 'Wolf' });
    expect(record(id)).toMatchObject({ form: 'Wolf', temp_hp: 2, duration_minutes: 60 });
    turnOf(pc());
    await useAction(db, { campaign_id: campaignId, actor_id: pc().id, action_name: 'wild_shape_revert' });
    expect(record(id)).toBeNull();
    end();
    expect(record(id)).toBeNull();
  });

  it('writes a form taken in the fight back at its end, timed from when it was taken', async () => {
    const id = druid(2);
    await ambush();
    turnOf(pc());
    await useAction(db, { campaign_id: campaignId, actor_id: pc().id, action_name: 'wild_shape', option: 'Wolf' });
    const taken = record(id)!;
    end();
    expect(record(id)).toEqual(taken);
  });

  it('clears the record when the Druid drops out of the form in the fight', async () => {
    const id = druid(2);
    outside(id, 'wild_shape', 'Wolf');
    await ambush();
    const druidId = pc().id;
    db.prepare('UPDATE combatant SET conditions_json = ? WHERE id = ?').run(JSON.stringify(['stunned']), druidId);
    while (getBattleState(db, campaignId)!.active!.id !== druidId) await advanceTurn(db, campaignId);
    const ended = await advanceTurn(db, campaignId);
    expect(texts(ended)).toMatch(/drops the Wolf form/);
    expect(record(id)).toBeNull();
  });
});

// --- undo ---------------------------------------------------------------------

describe('Wild Shape and the combat undo', () => {
  it('takes back a blow on a shaped Druid and leaves the form and its record standing', async () => {
    const id = druid(2);
    outside(id, 'wild_shape', 'Wolf');
    const taken = record(id)!;
    await ambush();
    turnOf(foe());
    const before = pc();
    await attack(db, { campaign_id: campaignId, attacker_id: foe().id, target_id: before.id, action_name: 'Scimitar', roll: hit });
    expect(pc().temp_hp).toBe(0);
    undoLastCombatAction(db, campaignId);
    const after = pc();
    expect(after.temp_hp).toBe(2);
    expect(after.hp_current).toBe(before.hp_current);
    expect(after.flags.wild_shape).toEqual(before.flags.wild_shape);
    expect(after.stat_block?.name).toBe('Wolf');
    expect(after.ac).toBe(12);
    expect(tempHpOf(id)).toBe(2);
    end();
    expect(record(id)).toEqual(taken);
  });

  it('keeps the books straight when a shift or a revert in the fight is undone', async () => {
    const id = druid(2);
    await ambush();
    turnOf(pc());
    await useAction(db, { campaign_id: campaignId, actor_id: pc().id, action_name: 'wild_shape', option: 'Wolf' });
    undoLastCombatAction(db, campaignId);
    expect(pc().flags.wild_shape).toBeUndefined();
    expect(usesLeft(id)).toBe(2);
    end();
    // The shift never happened, so no form outlives the fight.
    expect(record(id)).toBeNull();

    await ambush();
    turnOf(pc());
    await useAction(db, { campaign_id: campaignId, actor_id: pc().id, action_name: 'wild_shape', option: 'Wolf' });
    turnOf(pc());
    await useAction(db, { campaign_id: campaignId, actor_id: pc().id, action_name: 'wild_shape_revert' });
    undoLastCombatAction(db, campaignId);
    expect(pc().flags.wild_shape?.form).toBe('Wolf');
    end();
    // The revert never happened either: the Wolf form outlives the fight on the rounds it had left.
    expect(record(id)).toMatchObject({ form: 'Wolf', duration_minutes: 60, temp_hp: 2 });
  });
});

// --- the species wiring -------------------------------------------------------

describe('species traits on the use_action and initiative rolls', () => {
  it('Halfling Luck rerolls a natural 1 on a spell attack roll', async () => {
    const wizard = findClass('wizard');
    const known = classLevelRow(wizard.index, 1).spellcasting?.cantrips_known ?? 3;
    const cantrips = ['Fire Bolt', ...spellsForClass(wizard.index, 0).filter((name) => name !== 'Fire Bolt')].slice(0, known);
    makeCaster('wizard', 'Halfling', { cantrips });
    await ambush();
    // Nobody stands within 5 ft of the wizard, so no crowded shot puts a second die on the roll.
    db.prepare('UPDATE combatant SET x = 12 WHERE id = ?').run(foe().id);
    turnOf(pc());
    queueRolls([D20_1, D20_18]);
    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: foe().id,
    });
    const line = (cast as unknown as { log: Array<{ kind: string; text: string; payload: Record<string, unknown> }> }).log.find(
      (e) => e.kind === 'attack',
    )!;
    expect((line.payload.roll as { natural: number }).natural).toBe(18);
    expect(line.payload.roll).not.toHaveProperty('reroll_note');
    expect(line.text).toMatch(/Halfling Luck: the natural 1 is rerolled and the d20 now reads 18/);
  });

  it('Halfling Luck rerolls a natural 1 on initiative', async () => {
    makeCaster('wizard', 'Halfling');
    queueRolls([D20_1, D20_18]);
    await ambush();
    const roll = combatLog(db, encounter().id).find((e) => e.kind === 'initiative' && e.actor_id === pc().id)!;
    expect(roll.text).toMatch(/Halfling Luck: the natural 1 is rerolled and the d20 now reads 18/);
  });

  it('Fey Ancestry gives an Elf Advantage on a save against a Charmed effect, and not against a Frightened one', async () => {
    elfFighter();
    await ambush();
    const charm = (condition: string) => {
      turnOf(foe());
      return useAction(db, {
        campaign_id: campaignId,
        actor_id: foe().id,
        action_name: 'Beguiling Song',
        target_id: pc().id,
        save_ability: 'wis',
        save_dc: 12,
        effect: { name: condition, kind: 'condition', tick: 'end', ends: 'manual' },
      });
    };
    const charmed = (await charm('charmed')).targets[0] as { save: { advantage: string; notes: string[] } };
    expect(charmed.save.advantage).toBe('advantage');
    expect(charmed.save.notes.join(' ')).toMatch(/Fey Ancestry/);
    const scared = (await charm('frightened')).targets[0] as { save: { advantage: string } };
    expect(scared.save.advantage).toBe('none');
  });
});
