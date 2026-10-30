// PF1 review fixes: the Resistance cantrip in the reply text, a recorded blessed death save, typed upcast
// targets, a multi-target homebrew effect, and an effect named "blessed".
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { d20Context } from '../src/combat/d20.js';
import { tickEffects } from '../src/combat/effects.js';
import { advanceTurn, applyEffect, attack, damageCombatant, startEncounter, useAction } from '../src/combat/engine.js';
import { getCombatant, listCombatants, listEffects, requireEncounter, type Combatant } from '../src/combat/state.js';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, createCompanion, grantFeature } from '../src/core/character.js';
import { classifyClause, clauseSchema, clausesSchema } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import { openDb, type Db } from '../src/db/connection.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
/** Pins every d20 to a 20 and every d4 to a 4. */
const HIGH = 0.041;
/** Pins every d20 to a 9 and every d4 to a 1. */
const MID = 0.5;
/** Pins every d20 to a 4 and every d4 to a 4. */
const LOW = 0.99;

interface Party {
  bram: number;
  elowen: number;
  wren: number;
  goblins: number[];
}

/** Bram the fighter, Elowen the cleric and Wren the wizard beside two goblins with 100 HP each, on an open map. */
async function camp(): Promise<Party> {
  campaignId = createCampaign(db, { name: 'PF1 fixes', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
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
  const caster = (name: string, cls: string, spells: Record<string, unknown>): void => {
    const id = createCompanion(db, { campaign_id: campaignId, name, source: { class: cls, species: 'Human', background: 'Acolyte' } })
      .companion!.id;
    db.prepare('UPDATE character SET spells_json = ?, spell_slots_json = ? WHERE id = ?').run(
      JSON.stringify({ save_dc: 13, attack_bonus: 5, ...spells }),
      JSON.stringify({ '1': { max: 4, used: 0 }, '2': { max: 3, used: 0 }, '3': { max: 2, used: 0 } }),
      id,
    );
  };
  caster('Elowen', 'Cleric', { cantrips: ['Resistance'], known: ['Bless', 'Hold Person'], prepared: ['Bless', 'Hold Person'] });
  caster('Wren', 'Wizard', { cantrips: ['Fire Bolt'], known: [], prepared: [] });
  const stopClicking = resolvePendingRollsImmediately(db);
  const started = await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: 2 }],
  });
  stopClicking();
  const map = { w: 30, h: 10, rows: Array.from({ length: 10 }, () => '.'.repeat(30)), features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), started.encounter_id);
  const all = listCombatants(db, started.encounter_id);
  const id = (name: string): number => all.find((c) => c.name === name)!.id;
  const party: Party = { bram: id('Bram'), elowen: id('Elowen'), wren: id('Wren'), goblins: all.filter((c) => c.team === 'enemy').map((c) => c.id) };
  const place = (who: number, x: number, y = 5): void => {
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, who);
  };
  place(party.bram, 5);
  place(party.elowen, 4);
  place(party.wren, 3);
  party.goblins.forEach((goblin, index) => {
    place(goblin, 6, 5 + index);
    db.prepare('UPDATE combatant SET hp_current = 100, hp_max = 100 WHERE id = ?').run(goblin);
  });
  return party;
}

const encounter = () => requireEncounter(db, campaignId);
const who = (id: number): Combatant => getCombatant(db, encounter().id, id);

const startTurn = (id: number): void => {
  const index = listCombatants(db, encounter().id).findIndex((c) => c.id === id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, encounter().id);
  db.prepare(
    "UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, flags_json = json_remove(coalesce(flags_json, '{}'), '$.spent_slot_this_turn', '$.cast_levelled_spell') WHERE id = ?",
  ).run(id);
};

const hold = (name: string, target: number, source: number, damageType?: string): void => {
  applyEffect(db, {
    campaign_id: campaignId,
    target_id: target,
    source_id: source,
    name,
    kind: 'buff',
    tick: 'end',
    ends: 'concentration',
    ...(damageType ? { damage_type: damageType } : {}),
  });
};

const texts = (result: unknown): string[] => (result as { log: Array<{ text: string }> }).log.map((e) => e.text);

/** A homebrew feature with these clauses on the character's sheet; returns its homebrew id. */
function grant(characterId: number, name: string, clauses: unknown[]): number {
  const id = saveHomebrew(db, { campaign_id: campaignId, kind: 'feature', name, schema: { name, text: name, clauses: clausesSchema.parse(clauses) } }).id;
  grantFeature(db, { campaign_id: campaignId, character_id: characterId, name, text: name, source: 'homebrew', mechanics: { homebrew_id: id } });
  return id;
}

beforeEach(() => {
  db = openDb(':memory:');
  Math.random = () => HIGH;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('the Resistance cantrip in the reply the DM reads', () => {
  it('names its reduction on the damage line of an attack and of a spell', async () => {
    const party = await camp();
    const [goblin, other] = party.goblins as [number, number];
    hold('Resistance', goblin, party.elowen, 'slashing');
    startTurn(party.bram);
    const swing = await attack(db, { campaign_id: campaignId, attacker_id: party.bram, target_id: goblin, action_name: 'Greatsword' });
    expect(texts(swing).find((t) => /takes \d+ slashing damage/.test(t))).toMatch(/, Resistance spell -4\)/);

    hold('Resistance', other, party.elowen, 'fire');
    startTurn(party.wren);
    const bolt = await useAction(db, { campaign_id: campaignId, actor_id: party.wren, action_name: 'Fire Bolt', spell: 'Fire Bolt', target_id: other });
    expect(texts(bolt).find((t) => /takes \d+ fire damage/.test(t))).toMatch(/, Resistance spell -4\)/);
  });

  it('puts the reduction ahead of the creature own resistance in the note', async () => {
    const party = await camp();
    // Bram is a Dwarf, resistant to Poison: (10 - 4) halved is 3.
    hold('Resistance', party.bram, party.elowen, 'poison');
    expect(damageCombatant(db, encounter(), who(party.bram), { amount: 10, type: 'poison' })).toMatchObject({
      applied: 3,
      resistance: 'Resistance spell -4, resistant',
    });
    // Once a turn: the second blow carries only the creature's own resistance.
    expect(damageCombatant(db, encounter(), who(party.bram), { amount: 10, type: 'poison' }).resistance).toBe('resistant');
  });

  it('names it on an effect tick', async () => {
    const party = await camp();
    const goblin = party.goblins[0]!;
    hold('Resistance', goblin, party.elowen, 'fire');
    applyEffect(db, { campaign_id: campaignId, target_id: goblin, name: 'Burning', kind: 'damage', damage_expr: '1d6', damage_type: 'fire', tick: 'start', ends: 'manual' });
    const ticked = await tickEffects(db, encounter(), goblin, 'start');
    expect(ticked.find((e) => e.kind === 'effect_tick')!.text).toMatch(/, Resistance spell -\d\)/);
  });

  it('names it on a damage rider and on a Graze', async () => {
    const party = await camp();
    const [goblin, other] = party.goblins as [number, number];
    grant(who(party.bram).character_id!, 'Ember Edge', [{ when: 'hit', do: [{ kind: 'extra_damage', dice: '1d6', type: 'fire' }] }]);
    hold('Resistance', goblin, party.elowen, 'fire');
    startTurn(party.bram);
    const hit = await attack(db, { campaign_id: campaignId, attacker_id: party.bram, target_id: goblin, action_name: 'Greatsword' });
    expect(texts(hit).find((t) => /takes \d+ more/.test(t))).toMatch(/, Resistance spell -\d\)/);

    // A d20 of 4 misses, and the Greatsword's Graze still deals the Strength modifier.
    const row = db.prepare('SELECT id, features_json FROM character WHERE id = ?').get(who(party.bram).character_id!) as { id: number; features_json: string };
    const features = JSON.parse(row.features_json) as Array<{ name: string; mechanics?: Record<string, unknown> }>;
    const mastery = features.find((f) => f.name === 'Weapon Mastery')!;
    mastery.mechanics = { ...mastery.mechanics, mastery_weapons: ['Greatsword'] };
    db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(features), row.id);
    hold('Resistance', other, party.elowen, 'slashing');
    Math.random = () => LOW;
    startTurn(party.bram);
    const miss = await attack(db, { campaign_id: campaignId, attacker_id: party.bram, target_id: other, action_name: 'Greatsword' });
    expect(texts(miss).find((t) => t.startsWith('The blow grazes'))).toMatch(/\(Resistance spell -3\)/);
  });
});

describe('a blessed death save', () => {
  it('is recorded as a roll, the way an unblessed one is', async () => {
    Math.random = () => MID;
    const party = await camp();
    hold('Bless', party.bram, party.elowen);
    damageCombatant(db, encounter(), who(party.bram), { amount: who(party.bram).hp_current });
    const order = listCombatants(db, encounter().id);
    const before = (order.findIndex((c) => c.id === party.bram) + order.length - 1) % order.length;
    db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(before, encounter().id);
    await advanceTurn(db, campaignId);
    const rows = db.prepare("SELECT expr, total FROM roll WHERE purpose = 'Death saving throw'").all() as Array<{ expr: string; total: number }>;
    expect(rows).toEqual([{ expr: '1d20+1d4', total: 10 }]);
  });
});

describe('a spell that upcasts to one more typed creature', () => {
  it('lets Hold Person at level 3 take two targets and refuses a third', async () => {
    const party = await camp();
    const [first, second] = party.goblins as [number, number];
    startTurn(party.elowen);
    const holdPerson = (targets: number[]) =>
      useAction(db, { campaign_id: campaignId, actor_id: party.elowen, action_name: 'Hold Person', spell: 'Hold Person', slot_level: 3, target_ids: targets });
    await expect(holdPerson([first, second, party.bram])).rejects.toThrow(
      /Hold Person reaches up to 2 creatures with a level 3 slot and 3 are named/,
    );
    const cast = await holdPerson([first, second]);
    expect((cast as { targets: Array<{ target_id: number }> }).targets.map((t) => t.target_id)).toEqual([first, second]);
  });
});

describe('a homebrew action effect with two targets', () => {
  const twinBolt = [
    { when: 'action', do: [{ kind: 'effect', economy: 'action', effect: { kind: 'auto', damage: { dice: '1d6', type: 'force' }, targets: 2 } }] },
  ];

  it('runs on up to its two target_ids and refuses a third', async () => {
    expect(classifyClause(clauseSchema.parse(twinBolt[0])).status).toBe('runs');
    const party = await camp();
    const [first, second] = party.goblins as [number, number];
    const homebrew = grant(who(party.bram).character_id!, 'Twin Bolt', twinBolt);
    startTurn(party.bram);
    const bolt = (targets: number[]) =>
      useAction(db, { campaign_id: campaignId, actor_id: party.bram, action_name: `homebrew_${homebrew}_0`, target_ids: targets });
    await expect(bolt([first, second, party.elowen])).rejects.toThrow(/reaches 2 creatures and 3 are named: re-call with 1 fewer target_ids/);
    await bolt([first, second]);
    expect(who(first).hp_current).toBeLessThan(100);
    expect(who(second).hp_current).toBe(who(first).hp_current);
  });
});

describe('an effect named "blessed"', () => {
  it('adds the Bless die', async () => {
    const party = await camp();
    hold('Blessed', party.bram, party.elowen);
    expect(listEffects(db, encounter().id).map((e) => e.name)).toEqual(['Blessed']);
    expect(d20Context(db, encounter(), who(party.bram), { kind: 'save', ability: 'wis' }).dice).toBe('+1d4');
  });
});
