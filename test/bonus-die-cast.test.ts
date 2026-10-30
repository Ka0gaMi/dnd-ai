import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rollCheck, rollSave } from '../src/combat/d20.js';
import { advanceTurn, attack, damageCombatant, startEncounter, useAction } from '../src/combat/engine.js';
import { combatSheet } from '../src/combat/sheet.js';
import {
  combatLog,
  getCombatant,
  listCombatants,
  listEffects,
  requireEncounter,
  setCombatantStatBlock,
  type Combatant,
} from '../src/combat/state.js';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, createCompanion } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
/** Pins every d20 to a 20 and every d4 to a 4. */
const HIGH = 0.041;
/** Pins every d20 to a 4 and every d4 to a 4. */
const LOW = 0.99;
/** Pins every d20 to a 9 and every d4 to a 1. */
const MID = 0.5;

interface Party {
  bram: number;
  elowen: number;
  wren: number;
  aldo: number;
  goblins: number[];
}

function companion(name: string, cls: string, spells: Record<string, unknown>): number {
  const id = createCompanion(db, { campaign_id: campaignId, name, source: { class: cls, species: 'Human', background: 'Acolyte' } })
    .companion!.id;
  db.prepare('UPDATE character SET spells_json = ?, spell_slots_json = ? WHERE id = ?').run(
    JSON.stringify(spells),
    JSON.stringify({ '1': { max: 4, used: 0 }, '2': { max: 2, used: 0 } }),
    id,
  );
  return id;
}

/** The journey playtest's camp: Bram the fighter, Elowen the cleric, Wren the wizard, Aldo, and goblins on an open map. */
async function camp(playerRolls: 'none' | 'all' = 'none', goblins = 1): Promise<Party> {
  campaignId = createCampaign(db, { name: 'Journey', story_shape: 'sandbox', settings: { player_rolls: playerRolls } }).campaign_id;
  createCharacter(db, {
    campaign_id: campaignId,
    name: 'Bram',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
  companion('Elowen', 'Cleric', {
    cantrips: ['Guidance', 'Resistance'],
    known: ['Bless', 'Bane'],
    prepared: ['Bless', 'Bane'],
    save_dc: 13,
    attack_bonus: 5,
  });
  companion('Wren', 'Wizard', { cantrips: ['Fire Bolt'], known: [], prepared: [], save_dc: 13, attack_bonus: 5 });
  companion('Aldo', 'Fighter', {});
  const stopClicking = resolvePendingRollsImmediately(db);
  const started = await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: goblins }],
  });
  stopClicking();
  const map = { w: 30, h: 10, rows: Array.from({ length: 10 }, () => '.'.repeat(30)), features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), started.encounter_id);
  const all = listCombatants(db, started.encounter_id);
  const id = (name: string): number => all.find((c) => c.name === name)!.id;
  const party: Party = {
    bram: id('Bram'),
    elowen: id('Elowen'),
    wren: id('Wren'),
    aldo: id('Aldo'),
    goblins: all.filter((c) => c.team === 'enemy').map((c) => c.id),
  };
  const place = (who: number, x: number, y = 5): void => {
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, who);
  };
  place(party.bram, 5);
  place(party.elowen, 4);
  place(party.wren, 3);
  place(party.aldo, 4, 4);
  party.goblins.forEach((goblin, index) => {
    place(goblin, 6, 5 + index);
    db.prepare('UPDATE combatant SET hp_current = 100, hp_max = 100 WHERE id = ?').run(goblin);
  });
  return party;
}

const encounter = () => requireEncounter(db, campaignId);
const who = (id: number): Combatant => getCombatant(db, encounter().id, id);

/** A fresh turn for this combatant, with the turn-scoped marks a real turn edge would clear. */
const startTurn = (id: number): void => {
  const index = listCombatants(db, encounter().id).findIndex((c) => c.id === id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, encounter().id);
  db.prepare(
    "UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, flags_json = json_remove(coalesce(flags_json, '{}'), '$.spent_slot_this_turn', '$.cast_levelled_spell') WHERE id = ?",
  ).run(id);
};

const effectsNamed = (name: string) => listEffects(db, encounter().id).filter((e) => e.name === name);
const slotsUsed = (party: Party, level: string): number => combatSheet(db, who(party.elowen).character_id!).spell_slots[level]!.used;

/** The roll an attack log line carries, for the attacker named. */
const attackRoll = (attacker: number): { expr: string; total: number } =>
  (combatLog(db, encounter().id).filter((e) => e.kind === 'attack' && e.actor_id === attacker).at(-1)!.payload as {
    roll: { expr: string; total: number };
  }).roll;

beforeEach(() => {
  db = openDb(':memory:');
  Math.random = () => HIGH;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('Bless cast the way the playtest DM cast it', () => {
  it('blesses every target from one slot, and Bram then attacks and saves with +1d4', async () => {
    const party = await camp();
    startTurn(party.elowen);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: party.elowen,
      action_name: 'Bless',
      spell: 'Bless',
      target_ids: [party.bram, party.wren],
      concentration: true,
    });
    expect(slotsUsed(party, '1')).toBe(1);
    expect(effectsNamed('Bless').map((e) => [e.target_id, e.ends, e.concentration_of])).toEqual([
      [party.bram, 'concentration', party.elowen],
      [party.wren, 'concentration', party.elowen],
    ]);

    startTurn(party.bram);
    await attack(db, { campaign_id: campaignId, attacker_id: party.bram, target_id: party.goblins[0]!, action_name: 'Greatsword' });
    const swing = attackRoll(party.bram);
    const modifier = Number(/^1d20\+(\d+)\+1d4$/.exec(swing.expr)?.[1]);
    expect(swing.total).toBe(20 + modifier + 4);

    const save = await rollSave(db, encounter(), who(party.bram), 'dex', 15);
    expect(save.total).toBe(20 + save.bonus + 4);
  });

  it('takes a third target, refuses a fourth at level 1 for nothing, and takes it with a level 2 slot', async () => {
    const party = await camp();
    startTurn(party.elowen);
    const four = [party.wren, party.aldo, party.elowen];
    await expect(
      useAction(db, { campaign_id: campaignId, actor_id: party.elowen, action_name: 'Bless', spell: 'Bless', target_id: party.bram, target_ids: four }),
    ).rejects.toThrow(/Bless reaches up to 3 creatures with a level 1 slot and 4 are named: drop 1, or upcast with slot_level/);
    expect(slotsUsed(party, '1')).toBe(0);
    expect(effectsNamed('Bless')).toHaveLength(0);
    expect(who(party.elowen).action_used).toBe(false);

    await useAction(db, {
      campaign_id: campaignId,
      actor_id: party.elowen,
      action_name: 'Bless',
      spell: 'Bless',
      target_ids: [party.bram, party.wren, party.aldo],
    });
    expect(effectsNamed('Bless')).toHaveLength(3);

    startTurn(party.elowen);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: party.elowen,
      action_name: 'Bless',
      spell: 'Bless',
      slot_level: 2,
      target_id: party.bram,
      target_ids: four,
    });
    // Recasting ends the first Bless, so only the upcast one's four targets are left.
    expect(effectsNamed('Bless').map((e) => e.target_id).sort()).toEqual([party.bram, ...four].sort());
    expect(slotsUsed(party, '2')).toBe(1);
  });

  it('ends on every target when the concentration goes', async () => {
    const party = await camp();
    startTurn(party.elowen);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: party.elowen,
      action_name: 'Bless',
      spell: 'Bless',
      target_ids: [party.bram, party.wren, party.aldo],
    });
    expect(effectsNamed('Bless')).toHaveLength(3);
    startTurn(party.elowen);
    await useAction(db, { campaign_id: campaignId, actor_id: party.elowen, action_name: 'Bane', spell: 'Bane', target_id: party.goblins[0]! });
    expect(effectsNamed('Bless')).toHaveLength(0);
    const save = await rollSave(db, encounter(), who(party.bram), 'dex', 15);
    expect(save.notes).not.toContain('Bless: +1d4');
    expect(save.total).toBe(20 + save.bonus);
  });

  it('puts the die on a spell attack roll', async () => {
    const party = await camp();
    startTurn(party.elowen);
    await useAction(db, { campaign_id: campaignId, actor_id: party.elowen, action_name: 'Bless', spell: 'Bless', target_id: party.wren });
    startTurn(party.wren);
    await useAction(db, { campaign_id: campaignId, actor_id: party.wren, action_name: 'Fire Bolt', spell: 'Fire Bolt', target_id: party.goblins[0]! });
    expect(attackRoll(party.wren)).toMatchObject({ expr: '1d20+5+1d4', total: 29 });
  });
});

describe('Bane cast on two goblins', () => {
  it('takes 1d4 off the one that fails its Charisma save and leaves the one that passes', async () => {
    const party = await camp('none', 2);
    const [weak, strong] = party.goblins as [number, number];
    setCombatantStatBlock(db, strong, { ...who(strong).stat_block!, saves: { ...who(strong).stat_block!.saves, cha: 20 } });
    Math.random = () => LOW;
    startTurn(party.elowen);
    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: party.elowen,
      action_name: 'Bane',
      spell: 'Bane',
      target_ids: [weak, strong],
    });
    const saves = (cast as { targets: Array<{ target_id: number; save: { success: boolean } }> }).targets;
    expect(saves.map((t) => [t.target_id, t.save.success])).toEqual([
      [weak, false],
      [strong, true],
    ]);
    expect(effectsNamed('Bane').map((e) => e.target_id)).toEqual([weak]);

    startTurn(weak);
    await attack(db, { campaign_id: campaignId, attacker_id: weak, target_id: party.bram, action_name: 'Scimitar' });
    expect(attackRoll(weak).expr).toMatch(/^1d20\+\d+-1d4$/);
    startTurn(strong);
    await attack(db, { campaign_id: campaignId, attacker_id: strong, target_id: party.bram, action_name: 'Scimitar' });
    expect(attackRoll(strong).expr).toMatch(/^1d20\+\d+$/);
  });
});

describe('Guidance and Resistance name what they help', () => {
  it('refuses Guidance without a skill and Resistance without a damage type, for nothing', async () => {
    const party = await camp();
    startTurn(party.elowen);
    const cast = (spell: string, choice?: string) =>
      useAction(db, {
        campaign_id: campaignId,
        actor_id: party.elowen,
        action_name: spell,
        spell,
        target_id: party.bram,
        ...(choice ? { choice } : {}),
      });
    await expect(cast('Guidance')).rejects.toThrow(/Guidance helps one skill: pass choice with one of acrobatics, animal_handling/);
    await expect(cast('Resistance', 'psychic')).rejects.toThrow(
      /Resistance guards one damage type, and "psychic" is not one: pass choice with one of acid, bludgeoning/,
    );
    expect(who(party.elowen).action_used).toBe(false);
    expect(listEffects(db, encounter().id)).toHaveLength(0);

    await cast('Guidance', 'Sleight of Hand');
    expect(effectsNamed('Guidance (sleight of hand)')).toHaveLength(1);
    const check = await rollCheck(db, encounter(), who(party.bram), {
      ability: 'dex',
      skill: 'sleight_of_hand',
      dc: 10,
      purpose: 'Sleight of Hand',
      tool: 'use_action',
    });
    expect(check.total).toBe(20 + check.bonus + 4);
  });

  it('takes 1d4 off damage of the chosen type once Resistance is cast', async () => {
    const party = await camp();
    startTurn(party.elowen);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: party.elowen,
      action_name: 'Resistance',
      spell: 'Resistance',
      target_id: party.bram,
      choice: 'Fire',
    });
    expect(effectsNamed('Resistance')[0]).toMatchObject({ damage_type: 'fire', ends: 'concentration' });
    const hp = who(party.bram).hp_current;
    expect(damageCombatant(db, encounter(), who(party.bram), { amount: 5, type: 'fire' }).applied).toBe(1);
    expect(who(party.bram).hp_current).toBe(hp - 1);
  });
});

describe('Bless on a creature at 0 hit points', () => {
  it('adds its die to the death save, which turns a 9 into a success', async () => {
    Math.random = () => MID;
    const party = await camp();
    startTurn(party.elowen);
    await useAction(db, { campaign_id: campaignId, actor_id: party.elowen, action_name: 'Bless', spell: 'Bless', target_id: party.bram });
    damageCombatant(db, encounter(), who(party.bram), { amount: who(party.bram).hp_current });
    expect(who(party.bram).hp_current).toBe(0);

    const order = listCombatants(db, encounter().id);
    const before = (order.findIndex((c) => c.id === party.bram) + order.length - 1) % order.length;
    db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(before, encounter().id);
    await advanceTurn(db, campaignId);
    const death = combatLog(db, encounter().id).filter((e) => e.kind === 'death_save').at(-1)!;
    expect(death.payload).toMatchObject({ result: 'success', successes: 1 });
  });
});

describe('the player rolling their own attack', () => {
  it('shows the die on the attack card', async () => {
    const party = await camp('all');
    startTurn(party.elowen);
    await useAction(db, { campaign_id: campaignId, actor_id: party.elowen, action_name: 'Bless', spell: 'Bless', target_id: party.bram });
    startTurn(party.bram);
    const stopClicking = resolvePendingRollsImmediately(db);
    try {
      await attack(db, { campaign_id: campaignId, attacker_id: party.bram, target_id: party.goblins[0]!, action_name: 'Greatsword' });
    } finally {
      stopClicking();
    }
    const card = db.prepare("SELECT expr FROM pending_roll WHERE purpose LIKE 'Attack:%' ORDER BY id DESC LIMIT 1").get() as {
      expr: string;
    };
    expect(card.expr).toMatch(/^1d20\+\d+\+1d4$/);
    const modifier = Number(/^1d20\+(\d+)/.exec(card.expr)![1]);
    expect(attackRoll(party.bram).total).toBe(20 + modifier + 4);
  });
});
