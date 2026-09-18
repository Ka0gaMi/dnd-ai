import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { concentrationSaveDc, createCharacter, createCompanion } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { applyEffect, startEncounter, useAction } from '../src/combat/engine.js';
import { getBattleState, listCombatants, listEffects, type BattleState } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const HIGH = 0.99;

function makeCampaign(database: Db): number {
  const id = createCampaign(database, { name: 'Concentration', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
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

/** A level 5 Evoker with Fire Bolt, Empowered Evocation and an Intelligence that makes the rider bite. */
function makeEvoker(): number {
  const id = createCompanion(db, {
    campaign_id: campaignId,
    name: 'Zel',
    source: { class: 'Wizard', species: 'Human', background: 'Sage' },
  }).companion!.id;
  const row = db.prepare('SELECT abilities_json FROM character WHERE id = ?').get(id) as { abilities_json: string };
  const abilities = JSON.parse(row.abilities_json) as Record<string, { score: number; mod: number }>;
  abilities.int = { score: 60, mod: 25 };
  db.prepare('UPDATE character SET level = 5, abilities_json = ?, features_json = ?, spells_json = ?, spell_slots_json = ?, inventory_json = ? WHERE id = ?').run(
    JSON.stringify(abilities),
    JSON.stringify([{ name: 'Empowered Evocation' }]),
    JSON.stringify({ cantrips: ['Fire Bolt'], known: [], prepared: [], save_dc: 14, attack_bonus: 6 }),
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

const ids = (): { zel: number; enemy: number } => {
  const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
  return {
    zel: combatants.find((c) => c.name === 'Zel')!.id,
    enemy: combatants.find((c) => c.team === 'enemy')!.id,
  };
};

const place = (id: number, x: number, y: number): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
};

const startTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  const index = state.combatants.findIndex((c) => c.id === id);
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0 WHERE id = ?').run(id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, state.encounter.id);
};

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
  Math.random = () => HIGH;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('apply_effect and concentration', () => {
  it('ends the concentration the source already held and says so', async () => {
    const zel = makeEvoker();
    await ambush();
    const { enemy } = ids();

    const first = await applyEffect(db, {
      campaign_id: campaignId,
      target_id: enemy,
      source_id: zel,
      name: 'blessed',
      kind: 'buff',
      ends: 'concentration',
    });
    expect(listCombatants(db, first.state.encounter.id).find((c) => c.id === zel)!.concentration).toEqual({ name: 'blessed' });

    const second = await applyEffect(db, {
      campaign_id: campaignId,
      target_id: enemy,
      source_id: zel,
      name: 'hexed',
      kind: 'buff',
      ends: 'concentration',
    });

    // The old effect is closed and the log names both it and the concentration that replaced it.
    expect(second.log.some((entry) => entry.kind === 'effect_end' && /blessed/.test(entry.text) && /hexed/.test(entry.text))).toBe(true);
    const effects = listEffects(db, second.state.encounter.id);
    expect(effects.map((e) => e.name)).toEqual(['hexed']);
    expect(listCombatants(db, second.state.encounter.id).find((c) => c.id === zel)!.concentration).toEqual({ name: 'hexed' });
  });
});

describe('a spell and its riders are one instance of damage', () => {
  it('asks a concentrating target for one save at the summed DC', async () => {
    const zel = makeEvoker();
    await ambush();
    const { enemy } = ids();
    place(zel, 1, 5);
    place(enemy, 3, 5);
    db.prepare('UPDATE combatant SET hp_max = 200, hp_current = 200, concentration_json = ? WHERE id = ?').run(
      JSON.stringify({ name: 'Hex' }),
      enemy,
    );
    startTurn(zel);

    const hit = await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: enemy,
      roll: { total: 30, natural: 12 },
    });

    // The spell's own damage and the rider's are separate log lines but one instance for the save.
    const main = hit.log.find((entry) => entry.kind === 'damage')!.payload as { applied: number };
    const rider = hit.log.find((entry) => entry.kind === 'feature_damage')!.payload as { applied: number };
    expect(rider.applied).toBeGreaterThan(0);
    const total = main.applied + rider.applied;

    const saves = hit.log.filter((entry) => entry.kind === 'concentration');
    expect(saves).toHaveLength(1);
    const dc = (saves[0]!.payload as { save: { dc: number } }).save.dc;
    expect(dc).toBe(Math.max(10, Math.floor(total / 2)));
    // Neither part on its own would have asked for this DC.
    expect(dc).toBeGreaterThan(Math.max(10, Math.floor(main.applied / 2)));
    expect(dc).toBeGreaterThan(Math.max(10, Math.floor(rider.applied / 2)));
  });
});

describe('the damage Concentration DC caps at 30', () => {
  it('floors at 10, halves the damage, and never exceeds 30', () => {
    expect(concentrationSaveDc(4)).toBe(10);
    expect(concentrationSaveDc(25)).toBe(12);
    expect(concentrationSaveDc(60)).toBe(30);
    expect(concentrationSaveDc(61)).toBe(30);
    expect(concentrationSaveDc(200)).toBe(30);
  });

  it('asks DC 30, not 35, for a single 70-damage hit', async () => {
    const zel = makeEvoker();
    await ambush();
    const { enemy } = ids();
    place(zel, 1, 5);
    place(enemy, 2, 5);
    db.prepare('UPDATE combatant SET hp_max = 200, hp_current = 200, concentration_json = ? WHERE id = ?').run(
      JSON.stringify({ name: 'Hex' }),
      enemy,
    );
    startTurn(zel);

    const hit = await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'a heavy blow',
      target_id: enemy,
      damage_expr: '70',
      out_of_turn: true,
      reason: 'testing the Concentration DC cap',
    });

    const saves = hit.log.filter((entry) => entry.kind === 'concentration');
    expect(saves).toHaveLength(1);
    const entry = saves[0]!;
    expect((entry.payload as { save: { dc: number } }).save.dc).toBe(30);
    expect(entry.text).toMatch(/DC 30/);
  });

  it('still halves a 24-damage hit to DC 12', async () => {
    const zel = makeEvoker();
    await ambush();
    const { enemy } = ids();
    place(zel, 1, 5);
    place(enemy, 2, 5);
    db.prepare('UPDATE combatant SET hp_max = 200, hp_current = 200, concentration_json = ? WHERE id = ?').run(
      JSON.stringify({ name: 'Hex' }),
      enemy,
    );
    startTurn(zel);

    const hit = await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'a heavy blow',
      target_id: enemy,
      damage_expr: '24',
      out_of_turn: true,
      reason: 'testing the Concentration DC halving',
    });

    const saves = hit.log.filter((entry) => entry.kind === 'concentration');
    expect(saves).toHaveLength(1);
    expect((saves[0]!.payload as { save: { dc: number } }).save.dc).toBe(12);
  });
});

describe('one casting, several targets', () => {
  it('does not end its own earlier effect when the DM names the same effect again', async () => {
    const state = await ambush(2);
    const encounterId = state.encounter.id;
    const caster = listCombatants(db, encounterId).find((c) => c.kind !== 'monster')!.id;
    const foes = listCombatants(db, encounterId).filter((c) => c.kind === 'monster').map((c) => c.id);
    const held = (name: string) => listEffects(db, encounterId).filter((e) => e.active && e.name === name);
    const same = { campaign_id: campaignId, name: 'hold person', kind: 'buff' as const, ends: 'concentration' as const, source_id: caster };

    await applyEffect(db, { ...same, target_id: foes[0]! });
    await applyEffect(db, { ...same, target_id: foes[1]! });
    // Both targets belong to one casting, so the first must still be held.
    expect(held('hold person')).toHaveLength(2);

    // A different effect from the same caster is a new concentration, and ends the old one.
    await applyEffect(db, { ...same, name: 'haste', target_id: foes[0]! });
    expect(held('hold person')).toHaveLength(0);
    expect(held('haste')).toHaveLength(1);
  });
});
