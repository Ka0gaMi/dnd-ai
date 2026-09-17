// Audit P4d: Aura of Devotion and Aura of Courage shield a Paladin only while that Paladin is
// conscious - the auras are inactive while their source has the Incapacitated condition.
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
import { setCombatCondition, startEncounter } from '../src/combat/engine.js';
import { getBattleState, listCombatants, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
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
  feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
  spellcasting?: { cantrips_to_add: number; spells_to_add: number; cantrip_options: string[]; spell_options: Record<string, string[]> };
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

/** A Paladin of the Oath of Devotion at the level named, with a weapon in hand. */
function paladin(level: number): number {
  const id = make({ class: 'paladin', name: 'paladin', abilities: { ...ABILITIES, str: 15, cha: 14 } });
  if (level > 1) climbTo(id, level, 'Oath of Devotion');
  db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(
    JSON.stringify(['Longsword'].map((name) => ({ name, qty: 1, equipped: true }))),
    id,
  );
  return id;
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

/** Puts a condition on a combatant with the engine call: it refuses one the creature is immune to. */
const put = async (id: number, condition: string) =>
  setCombatCondition(db, { campaign_id: campaignId, combatant_id: id, condition, active: true });

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Audit P4d', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('P4d the Paladin aura condition immunities run only while the Paladin is conscious', () => {
  it('shields a conscious level 10 Paladin from Charmed and Frightened inside its own aura', async () => {
    paladin(10);
    await ambush();
    await expect(put(pc().id, 'charmed')).rejects.toThrow(/immune to the charmed/i);
    await expect(put(pc().id, 'frightened')).rejects.toThrow(/immune to the frightened/i);
    expect(pc().conditions).not.toContain('charmed');
    expect(pc().conditions).not.toContain('frightened');
  });

  it('drops both immunities the moment the Paladin is Incapacitated', async () => {
    paladin(10);
    await ambush();
    // Unconscious is Incapacitated, so the Aura of Protection that carries both immunities is inactive.
    await put(pc().id, 'unconscious');
    await put(pc().id, 'charmed');
    await put(pc().id, 'frightened');
    expect(pc().conditions).toContain('charmed');
    expect(pc().conditions).toContain('frightened');
  });

  it('keeps Aura of Devotion alone from level 7 shielding Charmed, and loses it when down', async () => {
    paladin(7);
    await ambush();
    await expect(put(pc().id, 'charmed')).rejects.toThrow(/immune to the charmed/i);
    // At level 7 only Aura of Devotion is online; Aura of Courage arrives at level 10.
    await put(pc().id, 'unconscious');
    await put(pc().id, 'charmed');
    expect(pc().conditions).toContain('charmed');
  });
});
