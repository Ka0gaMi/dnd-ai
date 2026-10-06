// The SRD PDF's corrections to bundled spell data that the engine, the sheet and srd_lookup all read.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, createCompanion } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { castingEconomy, spellFill, startEncounter, useAction } from '../src/combat/engine.js';
import { getBattleState, listCombatants } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import { findSpell, srdSearch } from '../src/srd/lookup.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Errata', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
    .campaign_id;
  createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
  db.close();
});

/** The one srd_lookup spell result for an exact name. */
const lookupSpell = (name: string): Record<string, unknown> => {
  const { results } = srdSearch('spell', name, 1, true);
  return results[0] as Record<string, unknown>;
};

describe('SRD spell errata', () => {
  it("reads the PDF's casting times off findSpell", () => {
    expect(findSpell('Fabricate')?.casting_time).toBe('10minutes');
    expect(findSpell('Control Weather')?.casting_time).toBe('10minutes');
    expect(findSpell('Scrying')?.casting_time).toBe('10minutes');
    // Overgrowth is an action and Enrichment 8 hours; the entry prints both.
    expect(findSpell('Plant Growth')?.casting_time).toBe('action or 8 hours');
  });

  it('carries the same corrections into the srd_lookup results', () => {
    expect(lookupSpell('Fabricate').casting_time).toBe('10minutes');
    expect(lookupSpell('Control Weather').casting_time).toBe('10minutes');
    expect(lookupSpell('Scrying').casting_time).toBe('10minutes');
    expect(lookupSpell('Plant Growth').casting_time).toBe('action or 8 hours');
  });

  it('leaves Scrying material unconsumed at both lookups', () => {
    expect(findSpell('Scrying')?.material_consumed).toBe(false);
    expect(lookupSpell('Scrying').material_consumed).toBe(false);
  });

  it('keeps Plant Growth an action so Overgrowth stays castable in a fight', async () => {
    const plantGrowth = findSpell('Plant Growth')!;
    expect(castingEconomy(plantGrowth.casting_time)).toBe('action');
    expect(spellFill('Plant Growth', null)).toMatchObject({ casting_time: 'action or 8 hours', economy: 'action' });

    const { companion } = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Zel',
      source: { class: 'Druid', species: 'Human', background: 'Sage' },
    });
    const casterId = companion!.id;
    db.prepare('UPDATE character SET level = 5, spells_json = ?, spell_slots_json = ? WHERE id = ?').run(
      JSON.stringify({ cantrips: [], known: ['Plant Growth'], prepared: ['Plant Growth'], save_dc: 14, attack_bonus: 6 }),
      JSON.stringify({ '3': { max: 2, used: 0 } }),
      casterId,
    );
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }],
    });
    const state = getBattleState(db, campaignId)!;
    const map: BattleMap = { w: 60, h: 14, rows: Array.from({ length: 14 }, () => '.'.repeat(60)), features: [] };
    db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
    const caster = listCombatants(db, state.encounter.id).find((c) => c.id === casterId)!;
    const turnIndex = state.combatants.findIndex((c) => c.id === casterId);
    db.prepare(
      'UPDATE combatant SET x = 1, y = 5, action_used = 0, bonus_used = 0, reaction_used = 0 WHERE id = ?',
    ).run(casterId);
    db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(turnIndex, state.encounter.id);

    // Nothing is refused as a long cast, and the action and the slot are both spent.
    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: casterId,
      action_name: 'Plant Growth',
      spell: 'Plant Growth',
      point: { x: 10, y: 5 },
    });
    expect(cast.log.some((entry) => entry.kind === 'spell_slot')).toBe(true);
    const after = listCombatants(db, state.encounter.id).find((c) => c.id === casterId)!;
    expect(after.action_used).toBe(true);
    expect(caster.action_used).toBe(false);
  });
});
