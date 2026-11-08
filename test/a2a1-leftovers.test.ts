// A2a-1 leftovers: a spell attack hides an AC built on unidentified gear, and Overchannel keeps negative modifiers.
import { beforeEach, describe, expect, it } from 'vitest';
import { maximumDamage } from '../src/combat/damage-math.js';
import { startEncounter } from '../src/combat/engine.js';
import { getBattleState, listCombatants } from '../src/combat/state.js';
import { useAction } from '../src/combat/use-action.js';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import { addItem, createCharacter } from '../src/core/character.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Leftovers', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
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
  updateSettings(db, campaignId, { dc_disclosure: 'shown' });
});

/** The goblin casts Fire Bolt at the PC; returns the player's and the DM's attack lines. */
async function bolt(): Promise<{ player: string; dm: string }> {
  await startEncounter(db, { campaign_id: campaignId, seed: 7, terrain: 'road', size: 'small', enemies: [{ creature: 'Goblin Warrior' }] });
  const encounterId = getBattleState(db, campaignId)!.encounter.id;
  const pc = listCombatants(db, encounterId).find((c) => c.kind === 'pc')!.id;
  const foe = listCombatants(db, encounterId).find((c) => c.team === 'enemy')!.id;
  await useAction(db, {
    campaign_id: campaignId,
    actor_id: foe,
    action_name: 'Fire Bolt',
    spell: 'Fire Bolt',
    target_id: pc,
    roll: { total: 15, natural: 10 },
    out_of_turn: true,
    reason: 'the test casts',
  } as never);
  const line = (tail: { kind: string; text: string }[]) => tail.find((e) => e.kind === 'attack' && e.text.includes('spell attack'))!.text;
  return {
    player: line(campaignSnapshot(db, campaignId, { forPlayer: true }).encounter!.log_tail),
    dm: line(getBattleState(db, campaignId, false)!.log_tail),
  };
}

describe('a spell attack on a party member', () => {
  it('names no AC to the player while unidentified gear is part of it, and the DM keeps it', async () => {
    addItem(db, { campaign_id: campaignId, name: '+1 Shield', unidentified: true, equipped: true });
    const { player, dm } = await bolt();
    expect(player).not.toMatch(/AC \d+/);
    expect(dm).toContain('vs AC 19');
  });

  it('still shows the AC when nothing is hidden', async () => {
    const { player } = await bolt();
    expect(player).toMatch(/vs AC 16/);
  });
});

describe('maximumDamage', () => {
  it('subtracts a negative modifier and adds a positive one', () => {
    expect(maximumDamage('1d8-1', false).total).toBe(7);
    expect(maximumDamage('2d6+3', false).total).toBe(15);
  });
});
