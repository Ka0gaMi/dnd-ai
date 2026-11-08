// A2a-2 fix round 2: the level-up panel answers with the player's sheet, an item's once-a-turn mark is
// opaque in the player's battle state, the salt is a registered secret, and a worn form drops species resistances.
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attack, startEncounter } from '../src/combat/engine.js';
import { opaqueIndex } from '../src/combat/homebrew.js';
import { playerKeySalt } from '../src/combat/log-view.js';
import type { BattleMap } from '../src/combat/map.js';
import { getBattleState, listCombatants } from '../src/combat/state.js';
import { campaignSnapshot, createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import { addItem, awardXp, createCharacter, spendFeatureResource } from '../src/core/character.js';
import { clausesSchema } from '../src/core/mechanics.js';
import { DM_ONLY_FIELDS } from '../src/core/secret-fields.js';
import { openDb, type Db } from '../src/db/connection.js';
import registerProgressionRoutes from '../src/transport/routes/progression.js';

let db: Db;
let campaignId: number;
let pcId: number;
let base: string;
let close: () => Promise<void>;

beforeEach(async () => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Emberford', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  pcId = createCharacter(db, {
    campaign_id: campaignId,
    name: 'Bram',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  }).character!.id;
  db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run('[]', pcId);

  const app = express();
  app.use(express.json());
  registerProgressionRoutes(app, db);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await close();
  db.close();
});

const RATIONED = clausesSchema.parse([
  { when: 'hit', do: [{ kind: 'extra_damage', dice: '1d4', type: 'fire' }], uses: { per: 'long', count: 1 } },
]);
const ONCE_A_TURN = clausesSchema.parse([
  { when: 'hit', if: { weapon: { melee: true } }, do: [{ kind: 'extra_damage', dice: '1d4', type: 'fire' }], uses: 'once_per_turn' },
]);

/** Hilde's reforged greatsword on Bram, as the homebrew playtest seeds it. */
function cinderbrand(unidentified: boolean, clauses = RATIONED): void {
  addItem(db, {
    campaign_id: campaignId,
    character_id: pcId,
    name: 'Cinderbrand',
    equipped: true,
    magic: { rarity: 'uncommon', attunement: false, base: 'Greatsword', mechanics: { clauses } },
    ...(unidentified ? { unidentified: true } : {}),
  });
}

/** Puts the fight on Bram's turn, beside a goblin too healthy for one swing to fell. */
async function ambush(): Promise<{ pc: number; foe: number }> {
  await startEncounter(db, { campaign_id: campaignId, seed: 7, terrain: 'road', size: 'small', enemies: [{ creature: 'Goblin Warrior' }] });
  const encounterId = getBattleState(db, campaignId)!.encounter.id;
  const map: BattleMap = { w: 20, h: 10, rows: Array.from({ length: 10 }, () => '.'.repeat(20)), features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), encounterId);
  const pc = listCombatants(db, encounterId).find((c) => c.kind === 'pc')!.id;
  const foe = listCombatants(db, encounterId).find((c) => c.team === 'enemy')!.id;
  db.prepare('UPDATE combatant SET x = 3, y = 5, action_used = 0, bonus_used = 0, reaction_used = 0 WHERE id = ?').run(pc);
  db.prepare('UPDATE combatant SET x = 4, y = 5, hp_max = 200, hp_current = 200 WHERE id = ?').run(foe);
  const index = getBattleState(db, campaignId)!.combatants.findIndex((c) => c.id === pc);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, encounterId);
  return { pc, foe };
}

describe('the level-up panel', () => {
  it("answers with the player's copy of the sheet, never the DM's", async () => {
    cinderbrand(true);
    // A use spent while the item was unidentified leaves its counter row, true key and all, on the sheet.
    spendFeatureResource(db, {
      campaign_id: campaignId,
      character_id: pcId,
      resource: 'homebrew:cinderbrand:0',
      label: 'Unidentified greatsword',
      max: 1,
      per: 'long',
    });
    // The DM's copy carries both, which is what the route used to send.
    expect(JSON.stringify(getCharacterSheet(db, campaignId))).toMatch(/"true_name":"Cinderbrand"/);
    expect(JSON.stringify(getCharacterSheet(db, campaignId))).toContain('"resource":"homebrew:cinderbrand:0"');
    awardXp(db, { campaign_id: campaignId, amount: 300 });

    const res = await fetch(`${base}/api/characters/${pcId}/level-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choices: { hp: 'average' } }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const body = JSON.parse(text) as { level: number; character: { inventory: Array<{ name: string }> } };
    expect(body.level).toBe(2);
    expect(text).not.toMatch(/cinderbrand/i);
    expect(text).not.toContain('true_name');
    expect(body.character.inventory.map((item) => item.name)).toContain('Unidentified greatsword');
    expect(text).toMatch(/"resource":"homebrew:item_[0-9a-f]{12}:0"/);
  });
});

describe("an identified item's once-a-turn mark", () => {
  it("reads opaque in the player's battle state and snapshot, and true in the DM's", async () => {
    cinderbrand(false, ONCE_A_TURN);
    const { pc, foe } = await ambush();
    const swung = await attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: foe, action_name: 'Cinderbrand', roll: { total: 30, natural: 12 } });
    expect(swung.hit).toBe(true);

    const opaque = `${opaqueIndex('homebrew:cinderbrand', playerKeySalt(db, campaignId))}:0`;
    const marks = (combatants: Array<{ id: number; flags: { homebrew_used?: string[] } }>): string[] | undefined =>
      combatants.find((c) => c.id === pc)!.flags.homebrew_used;
    expect(marks(getBattleState(db, campaignId)!.combatants)).toEqual([opaque]);
    expect(marks(campaignSnapshot(db, campaignId, { forPlayer: true }).encounter!.combatants)).toEqual([opaque]);
    expect(marks(getBattleState(db, campaignId, false)!.combatants)).toEqual(['homebrew:cinderbrand:0']);
  });
});

describe("the campaign's key salt", () => {
  it('is registered as DM-only, so the standing leak test plants it on every player surface', () => {
    expect(DM_ONLY_FIELDS).toContainEqual({ id: 'campaign_key_salt', source: 'campaign_secret.key_salt', secret_while: 'always' });
  });
});

describe('a Wild Shape form on the sheet', () => {
  it("leaves the species' resistances out while the form is worn, and gives them back after", async () => {
    const resistances = (): string[] => getCharacterSheet(db, campaignId)!.resistances;
    // Dwarven Resilience: the species row's poison resistance.
    expect(resistances()).toContain('poison');
    const { pc } = await ambush();
    const flags = (form: object | null): void => {
      const row = db.prepare('SELECT flags_json FROM combatant WHERE id = ?').get(pc) as { flags_json: string | null };
      const current = JSON.parse(row.flags_json ?? '{}') as Record<string, unknown>;
      if (form) current.wild_shape = form;
      else delete current.wild_shape;
      db.prepare('UPDATE combatant SET flags_json = ? WHERE id = ?').run(JSON.stringify(current), pc);
    };

    flags({ form: 'Wolf', base_ac: 16, base_speed: 25, rounds_left: 600 });
    expect(resistances()).not.toContain('poison');
    expect(getCharacterSheet(db, campaignId, undefined, { for_player: true })!.resistances).not.toContain('poison');
    flags(null);
    expect(resistances()).toContain('poison');
  });
});
