// Audit P6b: an item nobody has identified must not tell the player what it is, in the fight feed included.
import { beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import {
  addItem,
  createCharacter,
  type CreateCharacterInput,
  type DmItem,
  type InventoryItem,
} from '../src/core/character.js';
import { attack, startEncounter } from '../src/combat/engine.js';
import { getBattleState, listCombatants } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, {
    name: 'Audit P6b',
    story_shape: 'sandbox',
    settings: { player_rolls: 'none' },
  }).campaign_id;
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
const playerItems = (): InventoryItem[] => playerSnapshot().pc!.inventory as InventoryItem[];
const dmSheetItems = (): DmItem[] => dmSnapshot().pc!.inventory as DmItem[];

/** Puts the fight on the PC's turn, beside a goblin too healthy for one swing to fell. */
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

describe('P6b an unidentified item tells the player nothing', () => {
  it("keeps an unidentified weapon's true name out of the player payload, the fight feed included", async () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true, equipped: true });

    const { pcId, foeId } = await ambush();
    const before = playerSnapshot();
    const attackAction = before.encounter!.legal_actions.find((a) => a.id.toLowerCase().includes('longsword'))!;
    expect(attackAction.label).toBe('Attack: Unidentified longsword');
    // The masked name still names a real weapon: the longsword's own property survives the mask.
    expect(attackAction.hint).toContain('Versatile');
    expect(JSON.stringify(before)).not.toContain('+1 Longsword');

    await attack(db, {
      campaign_id: campaignId,
      attacker_id: pcId,
      target_id: foeId,
      action_name: attackAction.id.slice('attack:'.length),
      roll: { total: 30, natural: 12 },
    });

    const after = playerSnapshot();
    expect(after.encounter!.log_tail.map((e) => e.text).join('\n')).toContain('Unidentified longsword');
    expect(JSON.stringify(after)).not.toContain('+1 Longsword');

    // The DM still sees what it really is.
    expect(dmSheetItems().find((i) => i.true_name === '+1 Longsword')).toBeDefined();
  });

  it("keeps an unidentified container's capacity and weightlessness out of the player payload", () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: 'Bag of Holding', unidentified: true });

    const playerBag = playerItems().find((i) => i.name.startsWith('Unidentified'))!;
    expect(playerBag.container?.capacity_lb).toBeUndefined();
    expect(playerBag.container?.weightless_contents).toBeUndefined();
    expect(JSON.stringify(playerSnapshot())).not.toContain('weightless_contents');

    const dmBag = dmSheetItems().find((i) => i.true_name === 'Bag of Holding')!;
    expect(dmBag.container).toMatchObject({ capacity_lb: 500, weightless_contents: true });
  });
});

describe('two unidentified weapons of a kind stay separately usable', () => {
  it('numbers the repeated masked name so each keeps its own action', async () => {
    fighter();
    for (const name of ['+1 Longsword', '+2 Longsword']) {
      addItem(db, { campaign_id: campaignId, name, unidentified: true, equipped: true });
    }

    const { pcId, foeId } = await ambush();
    const swings = playerSnapshot().encounter!.legal_actions.filter((a) => a.id.toLowerCase().includes('longsword'));
    expect(swings).toHaveLength(2);
    // Distinct ids, or the second weapon is unreachable for the DM and dropped by the window.
    expect(new Set(swings.map((a) => a.id)).size).toBe(2);
    expect(swings.map((a) => `${a.id} ${a.label} ${a.hint}`).join(' ')).not.toMatch(/\+1 Longsword|\+2 Longsword/);

    // Each id resolves to its own weapon, so the better one can actually be swung.
    for (const swing of swings) {
      const result = await attack(db, {
        campaign_id: campaignId,
        attacker_id: pcId,
        target_id: foeId,
        action_name: swing.id.slice('attack:'.length),
        roll: { total: 30, natural: 12 },
      });
      expect(result.hit).toBe(true);
      db.prepare("UPDATE combatant SET action_used = 0, flags_json = '{}' WHERE id = ?").run(pcId);
    }
  });
});
