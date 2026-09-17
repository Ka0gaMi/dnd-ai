// Audit P3d: what happens when a combatant drops to 0 hit points - a pulled blow, massive damage at
// 0 HP, a drop Relentless Rage undoes, and the third success on a death save.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import { createCharacter, grantFeature, type CreateCharacterInput } from '../src/core/character.js';
import { addCombatant, advanceTurn, attack, damageCombatant, startEncounter, useAction } from '../src/combat/engine.js';
import { activeEncounter, combatLog, getBattleState, getCombatant, insertCombatant, listCombatants, type Combatant } from '../src/combat/state.js';
import { classLevelRow, findClass, findSpecies, skillChoiceGroups, spellsForClass } from '../src/srd/lookup.js';
import type { Ability } from '../src/core/rules.js';
import { openDb, type Db } from '../src/db/connection.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
let stopRolls: () => void;
const realRandom = Math.random;
const hit = { total: 40, natural: 12 };
type Abilities = Record<Ability, number>;

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

/** A character on this campaign: the first call makes the PC, later ones an NPC. */
function make(cls: string, name: string, abilities: Abilities, isPc = true): number {
  const data = findClass(cls);
  const casting = data.spellcasting ? classLevelRow(data.index, 1).spellcasting : undefined;
  const input: CreateCharacterInput = {
    campaign_id: campaignId,
    name,
    species: 'Human',
    class: cls,
    background: 'Soldier',
    ability_method: 'manual',
    abilities,
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: skillPicks(cls),
    cantrips: spellsForClass(data.index, 0).slice(0, casting?.cantrips_known ?? 0),
    spells: spellsForClass(data.index, 1).slice(0, casting?.prepared_spells ?? 0),
    is_pc: isPc,
    ...(isPc ? {} : { role: 'npc' as const }),
  };
  return createCharacter(db, input).character!.id;
}

async function ambush(): Promise<void> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior' }],
  });
}

const combatants = (): Combatant[] => listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
const byId = (id: number): Combatant => combatants().find((c) => c.id === id)!;
const sheetOf = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;
const texts = (result: unknown): string =>
  (result as { log: Array<{ text: string }> }).log.map((e) => e.text).join('\n');
const place = (id: number, x: number, y: number): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
};
const startTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?').run(id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === id),
    state.encounter.id,
  );
};

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, {
    name: 'Dropping to Zero',
    story_shape: 'sandbox',
    settings: { player_rolls: 'none' },
  }).campaign_id;
  stopRolls = resolvePendingRollsImmediately(db);
  Math.random = () => 0.5;
});

afterEach(() => {
  stopRolls();
  Math.random = realRandom;
  db.close();
});

describe('defect 1: knocking a creature out leaves it at 1 HP and Unconscious', () => {
  it('does that for a player character, and names the waking rule', async () => {
    const pcId = make('Barbarian', 'Krug', { str: 15, dex: 14, con: 14, int: 8, wis: 12, cha: 10 });
    await ambush();
    const pc = combatants().find((c) => c.kind === 'pc')!;
    const foe = combatants().find((c) => c.team === 'enemy')!;
    db.prepare('UPDATE character SET hp_current = 1 WHERE id = ?').run(pcId);
    db.prepare('UPDATE combatant SET hp_current = 1 WHERE id = ?').run(pc.id);
    place(pc.id, 1, 5);
    place(foe.id, 2, 5);
    startTurn(foe.id);

    await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe.id,
      target_id: pc.id,
      action_name: 'Scimitar',
      knock_out: true,
      roll: hit,
    });

    const sheet = sheetOf(pcId);
    expect(sheet.hp_current).toBe(1);
    expect(sheet.stable).toBe(false);
    expect(sheet.conditions).toContain('unconscious');
    expect(sheet.conditions).toContain('prone');
    expect(byId(pc.id).conditions).toContain('unconscious');
    const knocked = combatLog(db, activeEncounter(db, campaignId)!.id).filter((e) => e.kind === 'knock_out');
    // The waking rule is what has teeth; "starts a Short Rest" is not modelled and is not claimed.
    expect(knocked.map((e) => e.text).join(' ')).toMatch(/first aid/i);
    expect(knocked.map((e) => e.text).join(' ')).not.toMatch(/Short Rest/);
  });

  it('does that for a monster, without the stable flag the old rule set', async () => {
    make('Fighter', 'Borg', { str: 15, dex: 14, con: 14, int: 8, wis: 12, cha: 10 });
    await ambush();
    const pc = combatants().find((c) => c.kind === 'pc')!;
    const foe = combatants().find((c) => c.team === 'enemy')!;
    db.prepare('UPDATE combatant SET hp_current = 1 WHERE id = ?').run(foe.id);
    place(pc.id, 1, 5);
    place(foe.id, 2, 5);
    startTurn(pc.id);

    await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc.id,
      target_id: foe.id,
      action_name: 'Unarmed Strike',
      knock_out: true,
      roll: hit,
    });

    const knocked = byId(foe.id);
    expect(knocked.hp_current).toBe(1);
    expect(knocked.alive).toBe(true);
    expect(knocked.conditions).toContain('unconscious');
    expect(knocked.flags.stable).toBeUndefined();
  });
});

describe('defect 2: massive damage at 0 HP kills a non-player combatant outright', () => {
  it('kills a companion already at 0 that takes more than its maximum', async () => {
    make('Fighter', 'Borg', { str: 15, dex: 14, con: 14, int: 8, wis: 12, cha: 10 });
    await ambush();
    const encounter = activeEncounter(db, campaignId)!;
    const downedId = insertCombatant(db, {
      encounter_id: encounter.id,
      kind: 'companion',
      character_id: null,
      name: 'Downed Fang',
      team: 'party',
      x: 0,
      y: 0,
      size: 'M',
      hp_current: 0,
      hp_max: 11,
      ac: 12,
      speed: 30,
      alive: true,
      death_saves: { successes: 0, failures: 0 },
    });

    damageCombatant(db, encounter, getCombatant(db, encounter.id, downedId), { amount: 20, type: 'piercing' });

    expect(getCombatant(db, encounter.id, downedId).alive).toBe(false);
  });
});

describe("defect 3: a drop Relentless Rage undoes is no drop", () => {
  it("is not logged as down and pays no Dark One's Blessing to a nearby Warlock", async () => {
    const barbarian = make('Barbarian', 'Krug', { str: 15, dex: 14, con: 14, int: 8, wis: 12, cha: 10 });
    grantFeature(db, {
      campaign_id: campaignId,
      character_id: barbarian,
      name: 'Relentless Rage',
      text: 'A raging Barbarian dropped to 0 HP may make a DC 10 Constitution save to stand back up.',
      source: 'homebrew',
    });
    const warlock = make('Warlock', 'Mord', { str: 10, dex: 14, con: 14, int: 8, wis: 12, cha: 15 }, false);
    grantFeature(db, {
      campaign_id: campaignId,
      character_id: warlock,
      name: "Dark One's Blessing",
      text: 'Dropping an enemy to 0 HP pays temporary hit points.',
      source: 'homebrew',
    });
    await ambush();
    await addCombatant(db, { campaign_id: campaignId, character_id: warlock, team: 'enemy' });

    const pc = combatants().find((c) => c.kind === 'pc')!;
    const foe = combatants().find((c) => c.team === 'enemy' && c.character_id === null)!;
    const mord = combatants().find((c) => c.character_id === warlock)!;
    startTurn(pc.id);
    await useAction(db, { campaign_id: campaignId, actor_id: pc.id, action_name: 'rage' });

    db.prepare('UPDATE character SET hp_current = 1 WHERE id = ?').run(barbarian);
    db.prepare('UPDATE combatant SET hp_current = 1 WHERE id = ?').run(pc.id);
    place(pc.id, 3, 5);
    place(foe.id, 2, 5);
    place(mord.id, 4, 5);

    startTurn(foe.id);
    const felled = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe.id,
      target_id: pc.id,
      action_name: 'Scimitar',
      roll: hit,
    });

    expect(texts(felled)).toMatch(/refuses to fall/);
    expect(texts(felled)).not.toMatch(/drops to 0 HP/);
    expect(byId(pc.id).hp_current).toBe(2);
    expect(byId(mord.id).temp_hp).toBe(0);
  });
});

describe('defect 4: a third death-save success leaves the roller stable', () => {
  it('sets the stable flag so advance_turn stops asking for death saves', async () => {
    make('Fighter', 'Borg', { str: 15, dex: 14, con: 14, int: 8, wis: 12, cha: 10 });
    await ambush();
    const encounter = activeEncounter(db, campaignId)!;
    const fallerId = insertCombatant(db, {
      encounter_id: encounter.id,
      kind: 'companion',
      character_id: null,
      name: 'Faller',
      team: 'party',
      x: 0,
      y: 0,
      size: 'M',
      hp_current: 0,
      hp_max: 10,
      ac: 10,
      speed: 30,
      alive: true,
      death_saves: { successes: 2, failures: 0 },
    });
    const order = combatants();
    const index = order.findIndex((c) => c.id === fallerId);
    const before = (index - 1 + order.length) % order.length;
    const setTurn = (): void => {
      db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(before, encounter.id);
    };
    Math.random = () => 0.6; // the d20 comes up 18: a plain success, not the 20 that revives

    setTurn();
    const turn = await advanceTurn(db, campaignId);
    const saves = turn.log.filter((entry) => entry.kind === 'death_save' && entry.actor_id === fallerId);
    expect(saves).toHaveLength(1);
    expect((saves[0]!.payload as { outcome: string }).outcome).toBe('success');
    const fallen = getCombatant(db, encounter.id, fallerId);
    expect(fallen.flags.stable).toBe(true);
    expect(fallen.death_saves).toEqual({ successes: 0, failures: 0 });

    setTurn();
    const again = await advanceTurn(db, campaignId);
    expect(again.log.some((entry) => entry.kind === 'death_save' && entry.actor_id === fallerId)).toBe(false);
  });
});
