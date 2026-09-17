// Audit spell attack: a critical spell hit owes a downed creature two death-save failures, and Smite
// of Protection's Half Cover adds +2 to the AC a spell attack must beat just as it does to a save.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, createCompanion } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { startEncounter, useAction } from '../src/combat/engine.js';
import { combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, type BattleState, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
let stopRolls: () => void;
const realRandom = Math.random;
const MID_D20 = 0.5;
const CRIT = { total: 30, natural: 20 };

function makeCampaign(database: Db): number {
  const id = createCampaign(database, { name: 'Spell Attack', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
    .campaign_id;
  createCharacter(database, {
    campaign_id: id,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
  return id;
}

/** A level 5 wizard companion whose Fire Bolt genuinely has an attack roll. */
function makeWizard(): number {
  const id = createCompanion(db, {
    campaign_id: campaignId,
    name: 'Zel',
    source: { class: 'Wizard', species: 'Human', background: 'Sage' },
  }).companion!.id;
  db.prepare('UPDATE character SET level = 5, spells_json = ?, spell_slots_json = ?, inventory_json = ? WHERE id = ?').run(
    JSON.stringify({ cantrips: ['Fire Bolt'], known: [], prepared: [], save_dc: 14, attack_bonus: 6 }),
    JSON.stringify({ '1': { max: 4, used: 0 } }),
    JSON.stringify([]),
    id,
  );
  return id;
}

/** A level 15 Devotion paladin holding the aura and Smite of Protection. */
function makePaladin(): number {
  const id = createCompanion(db, {
    campaign_id: campaignId,
    name: 'Dain',
    source: { class: 'Paladin', species: 'Human', background: 'Soldier' },
  }).companion!.id;
  db.prepare('UPDATE character SET level = 15, features_json = ?, spells_json = ?, spell_slots_json = ?, inventory_json = ? WHERE id = ?').run(
    JSON.stringify([{ name: 'Aura of Protection' }, { name: 'Smite of Protection' }]),
    JSON.stringify({ cantrips: [], known: [], prepared: [], save_dc: 14, attack_bonus: 6 }),
    JSON.stringify({ '1': { max: 4, used: 0 } }),
    JSON.stringify([]),
    id,
  );
  return id;
}

async function ambush(enemies = 1): Promise<BattleState> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: enemies }],
  });
  const state = getBattleState(db, campaignId)!;
  const rows = Array.from({ length: 14 }, () => '.'.repeat(60));
  const map: BattleMap = { w: 60, h: 14, rows, features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
  return getBattleState(db, campaignId)!;
}

const combatants = (): Combatant[] => listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
const byId = (id: number): Combatant => combatants().find((c) => c.id === id)!;
const pcId = (): number => combatants().find((c) => c.kind === 'pc')!.id;
const enemyIds = (): number[] => combatants().filter((c) => c.team === 'enemy').map((c) => c.id);

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
  campaignId = makeCampaign(db);
  Math.random = () => MID_D20;
  stopRolls = resolvePendingRollsImmediately(db);
});

afterEach(() => {
  stopRolls();
  Math.random = realRandom;
});

describe('a critical spell hit on a downed creature (audit spell attack)', () => {
  it('costs two death save failures, not one', async () => {
    const zel = makeWizard();
    await ambush();
    const pc = pcId();
    const borg = byId(pc).character_id!;
    // Borg is already at 0 hit points and dying, with a pad of hit points so the blow cannot kill outright.
    db.prepare(
      'UPDATE character SET hp_current = 0, hp_max = 50, death_saves_json = ?, conditions_json = ?, stable = 0 WHERE id = ?',
    ).run(JSON.stringify({ successes: 0, failures: 0 }), JSON.stringify(['unconscious']), borg);
    db.prepare('UPDATE combatant SET hp_current = 0, hp_max = 50, death_saves_json = ?, conditions_json = ? WHERE id = ?').run(
      JSON.stringify({ successes: 0, failures: 0 }),
      JSON.stringify(['unconscious']),
      pc,
    );
    place(zel, 1, 5);
    place(pc, 3, 5);
    startTurn(zel);

    await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: pc,
      roll: CRIT,
    });

    expect(combatSheet(db, borg).death_saves).toEqual({ successes: 0, failures: 2 });
  });
});

describe('Smite of Protection half cover against a spell attack (audit spell attack)', () => {
  it('adds +2 to the AC the spell attack must beat, as it does to a save', async () => {
    const zel = makeWizard();
    const paladin = makePaladin();
    await ambush();
    const pc = pcId();
    place(zel, 1, 5);
    place(pc, 8, 5);
    // Beside the ally and off the line of fire, so the paladin lends only the aura's cover.
    place(paladin, 8, 7);
    for (const foe of enemyIds()) place(foe, 55, 12);

    const castAt = async (roll: { total: number; natural: number }) => {
      startTurn(zel);
      const cast = await useAction(db, {
        campaign_id: campaignId,
        actor_id: zel,
        action_name: 'Fire Bolt',
        spell: 'Fire Bolt',
        target_id: pc,
        roll,
      });
      return (cast.targets[0] as { attack: { ac: number; hit: boolean } }).attack;
    };

    // A miss, only to read the plain AC: no aura yet, so the cover comes from the map alone.
    const plain = await castAt({ total: 1, natural: 1 });
    expect(plain.ac).toBe(byId(pc).ac);

    // The paladin smites: the aura shelters everyone inside it, and the shot must beat +2 more.
    db.prepare('UPDATE combatant SET flags_json = ? WHERE id = ?').run(
      JSON.stringify({ ...byId(paladin).flags, smite_protection: { rounds_left: 1 } }),
      paladin,
    );
    const sheltered = await castAt({ total: plain.ac, natural: 10 });

    expect(sheltered.ac).toBe(plain.ac + 2);
    expect(sheltered.hit).toBe(false);
  });
});
