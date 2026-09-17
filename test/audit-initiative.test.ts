import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { addCombatant, startEncounter } from '../src/combat/engine.js';
import { getBattleState, listCombatants } from '../src/combat/state.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

/** rpg-dice-roller maps Math.random through its own integer step, so the d20 a value yields is not linear. */
function queueRolls(values: number[]): void {
  let index = 0;
  Math.random = () => values[Math.min(index++, values.length - 1)] ?? 0.5;
}

/** The total a recorded roll output ends with, e.g. "1d20: [18] = 18" -> 18. */
const rolledTotal = (output: string): number => Number(output.slice(output.lastIndexOf('=') + 1).trim());

function makeCampaign(database: Db): number {
  const id = createCampaign(database, {
    name: 'Initiative audit',
    story_shape: 'sandbox',
    settings: { player_rolls: 'none' },
  }).campaign_id;
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

async function twoGoblins(): Promise<void> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: 2 }],
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
});

afterEach(() => {
  Math.random = realRandom;
});

describe('initiative tiebreak', () => {
  it('breaks a tie with a second die from the engine dice and records it', async () => {
    // PC initiative, PC tiebreak, goblin 1 initiative, its tiebreak, goblin 2 initiative, its tiebreak.
    queueRolls([0.5, 0.5, 0.5, 0.3, 0.5, 0.6]);
    await twoGoblins();

    const entries = getBattleState(db, campaignId)!.log_tail.filter((entry) => entry.kind === 'initiative');
    const one = entries.find((entry) => entry.text.startsWith('Goblin Warrior 1'))!;
    const two = entries.find((entry) => entry.text.startsWith('Goblin Warrior 2'))!;
    const first = one.payload as { initiative: number; order: number; tiebreak: string };
    const second = two.payload as { initiative: number; order: number; tiebreak: string };

    // Same total and same DEX, so only the tiebreak separates them.
    expect(first.initiative).toBe(second.initiative);
    // The tiebreak is a rollDice output, the one format the map generator's PRNG never produces.
    expect(first.tiebreak).toMatch(/^1d100: \[/);
    expect(second.tiebreak).toMatch(/^1d100: \[/);
    expect(rolledTotal(first.tiebreak)).toBeGreaterThan(rolledTotal(second.tiebreak));
    expect(first.order).toBe(0);
    expect(second.order).toBe(1);
  });
});

describe('add_combatant mid-fight', () => {
  it('slots a late arrival into the settled order without moving anyone already in it', async () => {
    Math.random = () => 0.5;
    await twoGoblins();
    const encounterId = getBattleState(db, campaignId)!.encounter.id;
    const started = listCombatants(db, encounterId);
    const pc = started.find((c) => c.kind === 'pc')!;
    const enemies = started.filter((c) => c.team === 'enemy');
    // Row id must not decide the tie order, so the higher id is deliberately put first.
    const high = enemies[0]!.id > enemies[1]!.id ? enemies[0]! : enemies[1]!;
    const low = high.id === enemies[0]!.id ? enemies[1]! : enemies[0]!;

    db.prepare('UPDATE combatant SET initiative = 12, initiative_order = 0 WHERE id = ?').run(high.id);
    db.prepare('UPDATE combatant SET initiative = 12, initiative_order = 1 WHERE id = ?').run(low.id);
    db.prepare('UPDATE combatant SET initiative = 5 WHERE id = ?').run(pc.id);
    db.prepare('UPDATE encounter SET turn_index = 0 WHERE id = ?').run(encounterId);
    const before = listCombatants(db, encounterId).map((c) => c.id);
    expect(before).toEqual([high.id, low.id, pc.id]);

    // Highest initiative yet: the newcomer must take the front without shifting the rest.
    Math.random = () => 0.2;
    const added = await addCombatant(db, { campaign_id: campaignId, creature: 'Goblin Warrior', name: 'Grey' });

    const state = getBattleState(db, campaignId)!;
    expect(state.combatants.filter((c) => c.id !== added.combatant_id).map((c) => c.id)).toEqual(before);
    expect(state.combatants.map((c) => c.initiative_order)).toEqual([0, 1, 2, 3]);
    // The turn was on the higher-id goblin and stays there even though the newcomer went in ahead.
    expect(state.active?.id).toBe(high.id);
  });
});
