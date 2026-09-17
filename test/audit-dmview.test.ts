// Audit: the DM's own battle view names its gear truly; the player's stays masked.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import { addItem, createCharacter, type CreateCharacterInput } from '../src/core/character.js';
import { attack, startEncounter } from '../src/combat/engine.js';
import { getBattleState, listCombatants } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import { openDb, type Db } from '../src/db/connection.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
let stopRolls: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, {
    name: 'Audit DM view',
    story_shape: 'sandbox',
    settings: { player_rolls: 'none' },
  }).campaign_id;
  stopRolls = resolvePendingRollsImmediately(db);
});

afterEach(() => {
  stopRolls();
});

function fighter(overrides: Partial<CreateCharacterInput> = {}) {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
    ...overrides,
  }).character!.id;
}

const playerSnapshot = () => campaignSnapshot(db, campaignId, { forPlayer: true });
const dmSnapshot = () => campaignSnapshot(db, campaignId);

/** The longsword swings in a snapshot, which is where the mask reaches legal_actions. */
const swordActions = (snapshot: ReturnType<typeof dmSnapshot>) =>
  snapshot.encounter!.legal_actions.filter((a) => a.id.toLowerCase().includes('longsword'));

/** Puts the fight on the PC's turn, beside a goblin that survives more than one swing. */
async function ambush(): Promise<{ pcId: number; foeId: number }> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior' }],
  });
  const state = getBattleState(db, campaignId)!;
  const map: BattleMap = { w: 20, h: 10, rows: Array.from({ length: 10 }, () => '.'.repeat(20)), features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
  const pcId = listCombatants(db, state.encounter.id).find((c) => c.kind === 'pc')!.id;
  const foeId = listCombatants(db, state.encounter.id).find((c) => c.team === 'enemy')!.id;
  db.prepare('UPDATE combatant SET x = 3, y = 5, action_used = 0, bonus_used = 0, reaction_used = 0 WHERE id = ?').run(pcId);
  db.prepare('UPDATE combatant SET x = 4, y = 5, hp_max = 200, hp_current = 200 WHERE id = ?').run(foeId);
  const index = getBattleState(db, campaignId)!.combatants.findIndex((c) => c.id === pcId);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, state.encounter.id);
  return { pcId, foeId };
}

/** Gives the PC a fresh turn, as advance_turn would, without moving the clock on. */
const freshTurn = (pcId: number): void => {
  db.prepare("UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, flags_json = '{}' WHERE id = ?").run(pcId);
};

const swing = (pcId: number, foeId: number, actionName: string) =>
  attack(db, {
    campaign_id: campaignId,
    attacker_id: pcId,
    target_id: foeId,
    action_name: actionName,
    roll: { total: 30, natural: 12 },
  });

describe('the DM battle view keeps the true name of its own gear', () => {
  it('names an unidentified weapon truly for the DM and keeps the player masked', async () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true, equipped: true });

    await ambush();

    const dm = swordActions(dmSnapshot());
    expect(dm).toHaveLength(1);
    expect(dm[0]!.label).toBe('Attack: +1 Longsword');
    expect(dm[0]!.id).toBe('attack:+1 Longsword');
    // The DM still gets the weapon's own properties under the true name.
    expect(dm[0]!.hint).toContain('Versatile');

    const player = swordActions(playerSnapshot());
    expect(player).toHaveLength(1);
    expect(player[0]!.label).toBe('Attack: Unidentified longsword');
    // Nothing about the player's whole payload names the weapon.
    expect(JSON.stringify(playerSnapshot())).not.toContain('+1 Longsword');
  });

  it('resolves a DM attack by the true name and still writes only the mask to the shared log', async () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true, equipped: true });

    const { pcId, foeId } = await ambush();
    expect(swordActions(dmSnapshot())[0]!.id).toBe('attack:+1 Longsword');

    const result = await swing(pcId, foeId, '+1 Longsword');
    expect(result.hit).toBe(true);

    // The stored log is written once for both audiences, so it keeps the mask.
    const after = playerSnapshot();
    expect(after.encounter!.log_tail.map((e) => e.text).join('\n')).toContain('Unidentified longsword');
    expect(JSON.stringify(after)).not.toContain('+1 Longsword');
  });
});

describe('the DM view numbers only genuinely repeated labels', () => {
  it('leaves two distinct true names unnumbered and resolves each', async () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true, equipped: true });
    addItem(db, { campaign_id: campaignId, name: '+2 Longsword', unidentified: true, equipped: true });

    const { pcId, foeId } = await ambush();

    const dm = swordActions(dmSnapshot());
    expect(dm.map((a) => a.label)).toEqual(['Attack: +1 Longsword', 'Attack: +2 Longsword']);
    expect(dm.some((a) => a.label.includes('('))).toBe(false);

    // The player's two swings still collide on the masked name, so the second is numbered apart.
    expect(swordActions(playerSnapshot()).map((a) => a.label)).toEqual([
      'Attack: Unidentified longsword',
      'Attack: Unidentified longsword (2)',
    ]);

    const first = await swing(pcId, foeId, '+1 Longsword');
    expect(first.hit).toBe(true);
    freshTurn(pcId);
    const second = await swing(pcId, foeId, '+2 Longsword');
    expect(second.hit).toBe(true);

    expect(JSON.stringify(playerSnapshot())).not.toMatch(/\+1 Longsword|\+2 Longsword/);
  });
});
