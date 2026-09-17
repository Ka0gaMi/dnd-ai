// Audit turnstate: the once-a-turn flags and the fallback death save must both respect what a turn
// boundary and exhaustion do to the rolls they carry.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, createCompanion, setExhaustion } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { advanceTurn, attack, startEncounter } from '../src/combat/engine.js';
import { activeEncounter, getBattleState, insertCombatant, listCombatants, type BattleState, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
let stopRolls: () => void;
const realRandom = Math.random;
const MID_D20 = 0.5;
const hit = { total: 25, natural: 12 };

function makeCampaign(database: Db): number {
  const id = createCampaign(database, { name: 'Turn State', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
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

const arm = (...items: string[]): void => {
  db.prepare('UPDATE character SET inventory_json = ? WHERE campaign_id = ? AND is_pc = 1').run(
    JSON.stringify(items.map((name) => ({ name, qty: 1, equipped: true }))),
    campaignId,
  );
};

/** Puts these weapons under the character's Weapon Mastery, the way a long rest's weapon drills do. */
const master = (...weapons: string[]): void => {
  const row = db.prepare('SELECT id, features_json FROM character WHERE campaign_id = ? AND is_pc = 1').get(campaignId) as {
    id: number;
    features_json: string;
  };
  const features = JSON.parse(row.features_json) as Array<{ name: string; mechanics?: Record<string, unknown> }>;
  const feature = features.find((f) => f.name === 'Weapon Mastery')!;
  feature.mechanics = { ...feature.mechanics, mastery_weapons: weapons };
  db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(features), row.id);
};

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

/** Enemies tough enough to stay standing, so a turn boundary can come round again. */
const toughen = (): void => {
  db.prepare("UPDATE combatant SET hp_max = 60, hp_current = 60 WHERE team = 'enemy'").run();
};

const combatants = (): Combatant[] => listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
const pcId = (): number => combatants().find((c) => c.kind === 'pc')!.id;
const enemyIds = (): number[] => combatants().filter((c) => c.team === 'enemy').map((c) => c.id);
const combatantById = (id: number): Combatant => combatants().find((c) => c.id === id)!;

const place = (id: number, x: number, y: number): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
};

const startTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  const index = state.combatants.findIndex((c) => c.id === id);
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?').run(id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, state.encounter.id);
};

/** A swing that lands, with the attacker standing right next to its target. */
async function swing(attacker: number, target: number, action: string, extra: Record<string, unknown> = {}) {
  return attack(db, { campaign_id: campaignId, attacker_id: attacker, target_id: target, action_name: action, roll: hit, ...extra });
}

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
  stopRolls = resolvePendingRollsImmediately(db);
  Math.random = () => MID_D20;
});

afterEach(() => {
  stopRolls();
  Math.random = realRandom;
});

describe('Cleave is once a turn, not once a fight', () => {
  it('clears the spent flag at the turn boundary, so the next turn can cleave again', async () => {
    arm('Greataxe');
    master('Greataxe');
    await ambush(2);
    toughen();
    const pc = pcId();
    const [first, second] = enemyIds() as [number, number];
    place(pc, 5, 5);
    place(first, 6, 5);
    place(second, 6, 6);
    startTurn(pc);

    const opening = await swing(pc, first, 'Greataxe');
    expect(opening.cleave_available).toEqual({ targets: [second] });
    await swing(pc, second, 'Greataxe', { cleave_from: first });
    expect(combatantById(pc).flags.cleaved).toBe(true);

    // Every turn boundary clears the once-a-turn features for everyone, Cleave included, so the flag is
    // already gone as the next creature steps up - not left to linger until the attacker's own turn.
    await advanceTurn(db, campaignId);
    expect(combatantById(pc).flags.cleaved).toBeUndefined();

    // A full round later the turn comes back to the same combatant, and Cleave is on offer again.
    for (let i = 1; i < combatants().length; i += 1) {
      await advanceTurn(db, campaignId);
    }
    expect(getBattleState(db, campaignId)!.active?.id).toBe(pc);
    expect(combatantById(pc).flags.cleaved).toBeUndefined();

    // And the mastery really is on offer again: a fresh opening swing and its cleave both land.
    const again = await swing(pc, first, 'Greataxe');
    expect(again.cleave_available).toEqual({ targets: [second] });
    const secondCleave = await swing(pc, second, 'Greataxe', { cleave_from: first });
    expect(secondCleave.mastery).toMatchObject({ property: 'Cleave' });
  });
});
