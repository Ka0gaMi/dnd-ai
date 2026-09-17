import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, createCompanion } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { attack, startEncounter, useAction } from '../src/combat/engine.js';
import { getBattleState, listCombatants, type CombatLogEntry, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const CRIT = { total: 30, natural: 20 };
const HIT = { total: 30, natural: 12 };

function makeCampaign(database: Db): number {
  const id = createCampaign(database, { name: 'Smite', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
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

/** A level 2 paladin companion holding Paladin's Smite, a Longsword and a level 1 slot. */
function makePaladin(): number {
  const id = createCompanion(db, {
    campaign_id: campaignId,
    name: 'Dain',
    source: { class: 'Paladin', species: 'Human', background: 'Soldier' },
  }).companion!.id;
  db.prepare('UPDATE character SET level = 2, features_json = ?, spell_slots_json = ?, inventory_json = ? WHERE id = ?').run(
    JSON.stringify([{ name: "Paladin's Smite" }]),
    JSON.stringify({ '1': { max: 2, used: 0 } }),
    JSON.stringify([{ name: 'Longsword', qty: 1, equipped: true }]),
    id,
  );
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
  // Each side keeps its own column, so the two are always within melee reach of each other.
  let party = 3;
  let enemy = 4;
  for (const c of listCombatants(db, state.encounter.id)) {
    const x = c.team === 'enemy' ? enemy++ : party++;
    db.prepare('UPDATE combatant SET x = ?, y = 5 WHERE id = ?').run(x, c.id);
  }
  db.prepare("UPDATE combatant SET hp_max = 200, hp_current = 200 WHERE team = 'enemy'").run();
}

const combatants = (): Combatant[] => listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
const foe = (): Combatant => combatants().find((c) => c.team === 'enemy')!;
const byId = (id: number): Combatant => combatants().find((c) => c.id === id)!;

const startTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?').run(id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === id),
    state.encounter.id,
  );
};

const swing = (attacker: number, target: number, action: string, roll: { total: number; natural: number }) =>
  attack(db, { campaign_id: campaignId, attacker_id: attacker, target_id: target, action_name: action, roll });

const use = (actor: number, action: string, extra: Record<string, unknown> = {}) =>
  useAction(db, { campaign_id: campaignId, actor_id: actor, action_name: action, ...extra });

/** The damage expression the log recorded for one action's own damage entry. */
const damageExprOf = (result: { log: CombatLogEntry[] }, action: string): string => {
  const entry = result.log.find(
    (e) => e.kind === 'damage' && (e.payload as { action?: string } | null)?.action === action,
  );
  expect(entry, `no damage entry for ${action}`).toBeDefined();
  return (entry!.payload as { expr: string }).expr;
};

const smiteReady = (struck: unknown): { critical?: boolean } | undefined =>
  (struck as { smite_ready?: { critical?: boolean } }).smite_ready;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('Divine Smite and critical hits (audit smite)', () => {
  it('doubles the Smite dice when the triggering weapon hit was a critical', async () => {
    const paladin = makePaladin();
    await ambush();
    startTurn(paladin);
    const struck = await swing(paladin, foe().id, 'Longsword', CRIT);
    const smite = await use(paladin, 'Divine Smite', { spell: 'Divine Smite', slot_level: 1 });
    // Divine Smite's own 2d8 double, exactly as Eldritch Smite's rider does.
    expect(damageExprOf(smite, 'Divine Smite')).toBe('4d8');
    expect(smiteReady(struck)?.critical).toBe(true);
  });

  it('leaves the Smite dice alone when the triggering hit was ordinary', async () => {
    const paladin = makePaladin();
    await ambush();
    startTurn(paladin);
    const struck = await swing(paladin, foe().id, 'Longsword', HIT);
    expect(smiteReady(struck)?.critical).toBe(false);

    const smite = await use(paladin, 'Divine Smite', { spell: 'Divine Smite', slot_level: 1 });
    expect(damageExprOf(smite, 'Divine Smite')).toBe('2d8');
  });

  it('treats a smite_ready flag saved without the critical field as an ordinary hit', async () => {
    const paladin = makePaladin();
    await ambush();
    startTurn(paladin);
    await swing(paladin, foe().id, 'Longsword', CRIT);
    // An older encounter's row: the flag predates the field, and reading it must not crash.
    db.prepare('UPDATE combatant SET flags_json = ? WHERE id = ?').run(
      JSON.stringify({ ...byId(paladin).flags, smite_ready: { target_id: foe().id, action: 'Longsword' } }),
      paladin,
    );

    const smite = await use(paladin, 'Divine Smite', { spell: 'Divine Smite', slot_level: 1 });
    expect(damageExprOf(smite, 'Divine Smite')).toBe('2d8');
  });

  it('still doubles a spell that genuinely has an attack roll of its own', async () => {
    makeWizard();
    await ambush();
    const wizard = combatants().find((c) => c.name === 'Zel')!.id;
    startTurn(wizard);

    const bolt = await use(wizard, 'Fire Bolt', { spell: 'Fire Bolt', target_id: foe().id, roll: CRIT });
    expect(damageExprOf(bolt, 'Fire Bolt')).toBe('4d10');
  });
});
