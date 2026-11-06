// A death save the player rolled themselves reaches advance_turn as a pre-roll keyed by their combatant
// id: it is the save's d20, so no card goes out and nothing is rolled on the server.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addCombatant, advanceTurn, applyEffect, damageCombatant, startEncounter, undoLastCombatAction } from '../src/combat/engine.js';
import type { PreRoll } from '../src/combat/engine-core.js';
import { activeEncounter, getCombatant, listCombatants, type Combatant, type CombatLogEntry, type EncounterRow } from '../src/combat/state.js';
import { createCampaign } from '../src/core/campaign.js';
import { applyDamage, createCharacter } from '../src/core/character.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
let stopClicking: () => void;
const realRandom = Math.random;

/** Pins every d20 to a natural 20, so a card or a server roll would show as a critical success. */
const NAT_20 = 0.041;

beforeEach(async () => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Pre-rolled', story_shape: 'sandbox' }).campaign_id;
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
  // The player clicks their own dice, so a death save without a pre-roll goes to the window as a card.
  updateSettings(db, campaignId, { roll_mode: 'player', player_rolls: 'd20_only' });
  stopClicking = resolvePendingRollsImmediately(db);
  Math.random = () => NAT_20;
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior' }],
  });
});

afterEach(() => {
  stopClicking();
  Math.random = realRandom;
  db.close();
});

const encounter = (): EncounterRow => activeEncounter(db, campaignId)!;
const row = (id: number): Combatant => getCombatant(db, encounter().id, id);
const pc = (): Combatant => listCombatants(db, encounter().id).find((c) => c.kind === 'pc')!;
const goblin = (): Combatant => listCombatants(db, encounter().id).find((c) => c.team === 'enemy')!;

/** The character row's own death saves and HP, which the PC branch writes through deathSave. */
function sheet(): { hp_current: number; death_saves: { successes: number; failures: number } } {
  const found = db.prepare('SELECT hp_current, death_saves_json FROM character WHERE campaign_id = ? AND is_pc = 1').get(campaignId) as {
    hp_current: number;
    death_saves_json: string;
  };
  return { hp_current: found.hp_current, death_saves: JSON.parse(found.death_saves_json) };
}

function downPc(): void {
  applyDamage(db, { campaign_id: campaignId, amount: pc().hp_current, source: 'a goblin blade' });
  expect(pc().hp_current).toBe(0);
}

/** Puts the turn just before this combatant's and advances into it with the given pre-rolls. */
async function turnOf(id: number, rolls?: Record<string, PreRoll>) {
  const order = listCombatants(db, encounter().id);
  const index = order.findIndex((c) => c.id === id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run((index - 1 + order.length) % order.length, encounter().id);
  return advanceTurn(db, campaignId, rolls);
}

const deathSave = (log: CombatLogEntry[], id: number): Record<string, unknown> => {
  const saves = log.filter((entry) => entry.kind === 'death_save' && entry.actor_id === id);
  expect(saves).toHaveLength(1);
  return saves[0]!.payload as Record<string, unknown>;
};

const deathSaveCards = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM pending_roll WHERE campaign_id = ? AND context_json LIKE '%\"step\":\"death_save\"%'").get(campaignId) as {
    n: number;
  }).n;

const serverDeathRolls = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM roll WHERE campaign_id = ? AND purpose LIKE 'Death saving throw%'").get(campaignId) as { n: number }).n;

describe('a player character pre-rolling their death save', () => {
  it('takes an 8 as a failure, with no card and no server roll', async () => {
    downPc();

    const turn = await turnOf(pc().id, { [String(pc().id)]: { total: 8, natural: 8 } });

    const payload = deathSave(turn.log, pc().id);
    expect(payload).toMatchObject({ roll: 8, natural: 8, result: 'failure' });
    expect(pc().death_saves).toEqual({ successes: 0, failures: 1 });
    expect(sheet().death_saves).toEqual({ successes: 0, failures: 1 });
    expect(deathSaveCards()).toBe(0);
    expect(serverDeathRolls()).toBe(0);
  });

  it('wakes on a natural 20 with 1 HP', async () => {
    downPc();

    const turn = await turnOf(pc().id, { [String(pc().id)]: { total: 20, natural: 20 } });

    expect(deathSave(turn.log, pc().id)).toMatchObject({ result: 'critical_success' });
    expect(pc().hp_current).toBe(1);
    expect(pc().conditions).not.toContain('unconscious');
    expect(sheet().hp_current).toBe(1);
    expect(deathSaveCards()).toBe(0);
  });

  it('counts a natural 1 as two failures', async () => {
    downPc();

    const turn = await turnOf(pc().id, { [String(pc().id)]: { total: 1, natural: 1 } });

    expect(deathSave(turn.log, pc().id)).toMatchObject({ result: 'critical_failure' });
    expect(pc().death_saves).toEqual({ successes: 0, failures: 2 });
    expect(sheet().death_saves.failures).toBe(2);
  });

  it('reads a pre-roll without its natural face as no crit either way', async () => {
    downPc();

    const high = await turnOf(pc().id, { [String(pc().id)]: { total: 20 } });
    expect(deathSave(high.log, pc().id)).toMatchObject({ roll: 20, natural: null, result: 'success' });
    expect(pc().hp_current).toBe(0);

    const low = await turnOf(pc().id, { [String(pc().id)]: { total: 1 } });
    expect(deathSave(low.log, pc().id)).toMatchObject({ roll: 1, natural: null, result: 'failure' });
    expect(pc().death_saves).toEqual({ successes: 1, failures: 1 });
    expect(deathSaveCards()).toBe(0);
  });

  it('counts an 18 as a 20 for a Champion with Survivor', async () => {
    const found = db.prepare('SELECT id, features_json FROM character WHERE campaign_id = ? AND is_pc = 1').get(campaignId) as {
      id: number;
      features_json: string;
    };
    const features = [...(JSON.parse(found.features_json) as unknown[]), { name: 'Survivor' }];
    db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(features), found.id);
    downPc();

    const turn = await turnOf(pc().id, { [String(pc().id)]: { total: 18, natural: 18 } });

    expect(deathSave(turn.log, pc().id)).toMatchObject({ natural: 20, result: 'critical_success' });
    expect(pc().hp_current).toBeGreaterThan(0);
    expect(deathSaveCards()).toBe(0);
  });

  it('rolls as before when no pre-roll is keyed to the downed combatant', async () => {
    downPc();

    const turn = await turnOf(pc().id, { [String(goblin().id)]: { total: 8, natural: 8 } });

    // The card went out and was clicked at the pinned natural 20.
    expect(deathSaveCards()).toBe(1);
    expect(deathSave(turn.log, pc().id)).toMatchObject({ result: 'critical_success' });
    expect(pc().hp_current).toBe(1);
  });

  it('is put back by undo, on the combatant and on the sheet', async () => {
    downPc();
    const order = listCombatants(db, encounter().id);
    const before = (order.findIndex((c) => c.kind === 'pc') - 1 + order.length) % order.length;

    await turnOf(pc().id, { [String(pc().id)]: { total: 8, natural: 8 } });
    expect(pc().death_saves.failures).toBe(1);
    undoLastCombatAction(db, campaignId);

    expect(pc().death_saves).toEqual({ successes: 0, failures: 0 });
    expect(sheet().death_saves).toEqual({ successes: 0, failures: 0 });
    expect(encounter().turn_index).toBe(before);
  });
});

describe('one pre-roll in one advance_turn', () => {
  it('goes to an effect save first, and the death save then rolls as it does without one', async () => {
    downPc();
    applyEffect(db, {
      campaign_id: campaignId,
      target_id: pc().id,
      source_id: goblin().id,
      name: 'Gnawing rot',
      kind: 'buff',
      save_ability: 'con',
      save_dc: 30,
      ends: 'save',
      tick: 'start',
    });

    const turn = await turnOf(pc().id, { [String(pc().id)]: { total: 8, natural: 8 } });

    const effectSave = turn.log.find((entry) => entry.kind === 'save' && entry.target_id === pc().id)!;
    expect((effectSave.payload as { save: { total: number } }).save.total).toBe(8);
    expect(deathSaveCards()).toBe(1);
    expect(deathSave(turn.log, pc().id)).toMatchObject({ result: 'critical_success' });
  });

  it('stays with the death save when the effect save fails outright without a die', async () => {
    downPc();
    applyEffect(db, {
      campaign_id: campaignId,
      target_id: pc().id,
      source_id: goblin().id,
      name: 'Grasping mud',
      kind: 'buff',
      save_ability: 'dex',
      save_dc: 12,
      ends: 'save',
      tick: 'start',
    });

    const turn = await turnOf(pc().id, { [String(pc().id)]: { total: 8, natural: 8 } });

    const effectSave = turn.log.find((entry) => entry.kind === 'save' && entry.target_id === pc().id)!;
    expect((effectSave.payload as { save: { auto_fail: string | null } }).save.auto_fail).toMatch(/unconscious/);
    expect(deathSaveCards()).toBe(0);
    expect(deathSave(turn.log, pc().id)).toMatchObject({ roll: 8, result: 'failure' });
  });
});

describe('a party ally with no sheet pre-rolling its death save', () => {
  async function downedAlly(): Promise<number> {
    const id = (await addCombatant(db, { campaign_id: campaignId, creature: 'Guard', name: 'Sergeant Torvald', team: 'party', unique: true }))
      .combatant_id;
    damageCombatant(db, encounter(), row(id), { amount: row(id).hp_max, type: 'piercing' });
    expect(row(id).hp_current).toBe(0);
    expect(row(id).alive).toBe(true);
    return id;
  }

  it('takes the pre-roll instead of rolling its own', async () => {
    const ally = await downedAlly();

    const turn = await turnOf(ally, { [String(ally)]: { total: 8, natural: 8 } });

    expect(deathSave(turn.log, ally)).toMatchObject({ roll: 8, natural: 8, outcome: 'failure' });
    expect(row(ally).death_saves).toEqual({ successes: 0, failures: 1 });
    expect(serverDeathRolls()).toBe(0);
  });

  it('follows the natural face: a 20 wakes it, and a bare total of 1 is one failure', async () => {
    const ally = await downedAlly();

    const low = await turnOf(ally, { [String(ally)]: { total: 1 } });
    expect(deathSave(low.log, ally)).toMatchObject({ roll: 1, natural: null, outcome: 'failure' });
    expect(row(ally).death_saves).toEqual({ successes: 0, failures: 1 });

    const high = await turnOf(ally, { [String(ally)]: { total: 20, natural: 20 } });
    expect(deathSave(high.log, ally)).toMatchObject({ outcome: 'critical_success' });
    expect(row(ally).hp_current).toBe(1);
  });
});
