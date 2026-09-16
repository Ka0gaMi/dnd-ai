import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  awardXp,
  createCharacter,
  levelUp,
  levelUpOptions,
  type LevelUpChoices,
} from '../src/core/character.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import { legalActions } from '../src/combat/actions.js';
import { attack, setCombatCondition, startEncounter, useAction } from '../src/combat/engine.js';
import { combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, type BattleState } from '../src/combat/state.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const MID_D20 = 0.5;
const hit = { total: 25, natural: 12 };

const sheetOf = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;

/** A Fighter climbed to the level, so Extra Attack is the real level-5 class feature and not a fake row. */
function fighter(level: number): number {
  const id = createCharacter(db, {
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
  const owed = XP_THRESHOLDS[level - 1]! - sheetOf(id).xp;
  if (owed > 0) awardXp(db, { campaign_id: campaignId, character_id: id, amount: owed });
  while (sheetOf(id).level < level) {
    const options = levelUpOptions(db, campaignId, id) as {
      subclass_choice?: unknown;
      ability_score_improvement?: unknown;
      feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
    };
    const abilities = sheetOf(id).abilities as Record<string, { score: number }>;
    const gains = (Object.keys(abilities) as Ability[])
      .filter((a) => abilities[a]!.score < 20)
      .sort((a, b) => abilities[a]!.score - abilities[b]!.score);
    const choices: LevelUpChoices = { hp: 'average' };
    if (options.subclass_choice) choices.subclass = 'Champion';
    if (options.ability_score_improvement) choices.ability_increases = { [gains[0]!]: 1, [gains[1]!]: 1 };
    if (options.feature_choices) {
      choices.feature_options = Object.fromEntries(
        options.feature_choices.map((spec) => [spec.feature, spec.from.slice(0, spec.choose)]),
      );
    }
    levelUp(db, { campaign_id: campaignId, character_id: id, choices });
  }
  return id;
}

async function ambush(): Promise<BattleState> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: 1 }],
  });
  const state = getBattleState(db, campaignId)!;
  // The dummy soaks every blow: these tests are about the action economy, never about a corpse.
  db.prepare("UPDATE combatant SET hp_max = 200, hp_current = 200 WHERE team = 'enemy'").run();
  return state;
}

const ids = (): { pc: number; enemy: number } => {
  const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
  return {
    pc: combatants.find((c) => c.kind === 'pc')!.id,
    enemy: combatants.find((c) => c.team === 'enemy')!.id,
  };
};

const place = (id: number, x: number, y: number): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
};

const giveTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === id),
    state.encounter.id,
  );
};

const combatant = (id: number) => getBattleState(db, campaignId)!.combatants.find((c) => c.id === id)!;

const listed = (id: number): Array<{ id: string; label: string; hint: string }> => {
  const encounterId = getBattleState(db, campaignId)!.encounter.id;
  const c = listCombatants(db, encounterId).find((entry) => entry.id === id)!;
  return legalActions(c, combatSheet(db, c.character_id!));
};

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Audit P3b', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
    .campaign_id;
  Math.random = () => MID_D20;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('Extra Attack belongs to the Attack action', () => {
  it('refuses every attack after the Action was spent on a Dash', async () => {
    const pcSheet = fighter(5);
    await ambush();
    const { pc, enemy } = ids();
    expect(combatSheet(db, pcSheet).features.some((f) => f.name === 'Extra Attack')).toBe(true);
    place(pc, 1, 5);
    place(enemy, 2, 5);
    giveTurn(pc);

    await useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'dash' });
    expect(combatant(pc).action_used).toBe(true);
    expect(combatant(pc).flags.attacks_used ?? 0).toBe(0);

    await expect(
      attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: enemy, action_name: 'Unarmed Strike', roll: hit }),
    ).rejects.toThrow(/already taken their Action/);
    // The list agrees: a Dash closes the Attack action's door.
    expect(listed(pc).some((a) => a.id.startsWith('attack:'))).toBe(false);
  });

  it('still allows the second swing of an Attack action already under way', async () => {
    fighter(5);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy, 2, 5);
    giveTurn(pc);

    const shot = { campaign_id: campaignId, attacker_id: pc, target_id: enemy, action_name: 'Unarmed Strike', roll: hit };
    const first = await attack(db, shot);
    expect(first.attacks_used).toBe(1);
    expect(first.attacks_per_action).toBe(2);
    const second = await attack(db, shot);
    expect(second.attacks_used).toBe(2);
    await expect(attack(db, shot)).rejects.toThrow(/all 2 attacks/);
  });

  it('offers the remaining swing to the legal-action list, and drops it once it is spent', async () => {
    fighter(5);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy, 2, 5);
    giveTurn(pc);

    const before = listed(pc).find((a) => a.id === 'attack:Unarmed Strike')!;
    expect(before.label).toBe('Attack: Unarmed Strike ×2');

    const shot = { campaign_id: campaignId, attacker_id: pc, target_id: enemy, action_name: 'Unarmed Strike', roll: hit };
    await attack(db, shot);
    const afterFirst = listed(pc).find((a) => a.id === 'attack:Unarmed Strike')!;
    expect(afterFirst.hint).toContain('1 of 2 attacks left');
    // The runtime accepts exactly this one, so the list must still offer it.
    await expect(attack(db, shot)).resolves.toBeDefined();

    expect(listed(pc).some((a) => a.id === 'attack:Unarmed Strike')).toBe(false);
  });
});

describe('standing up from Prone', () => {
  it('costs half the speed rounded down, so 12 ft of movement stands a Speed 25 creature', async () => {
    fighter(5);
    await ambush();
    const { pc } = ids();
    giveTurn(pc);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'prone', active: true });
    db.prepare('UPDATE combatant SET speed = 25, movement_left = 12 WHERE id = ?').run(pc);

    const offered = listed(pc).find((a) => a.id === 'stand')!;
    expect(offered.hint).toContain('12 ft of movement');

    const stood = (await useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'stand' })) as unknown as {
      cost_ft: number;
      movement_left: number;
    };
    expect(stood.cost_ft).toBe(12);
    expect(stood.movement_left).toBe(0);
    expect(combatant(pc).conditions).not.toContain('prone');
  });

  it('refuses the stand when the movement left is short of half the speed', async () => {
    fighter(5);
    await ambush();
    const { pc } = ids();
    giveTurn(pc);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'prone', active: true });
    db.prepare('UPDATE combatant SET speed = 25, movement_left = 11 WHERE id = ?').run(pc);

    await expect(
      useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'stand' }),
    ).rejects.toThrow(/Standing up costs 12 ft/);
    expect(combatant(pc).conditions).toContain('prone');
  });
});
