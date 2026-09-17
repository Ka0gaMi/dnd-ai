import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import {
  addItem,
  createCharacter,
  equipItem,
  listInventory,
  rest,
  sheetExtras,
  type InventoryItem,
} from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Ashfall', story_shape: 'sandbox' }).campaign_id;
});

function fighter() {
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
  });
}

function wizard() {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Zel',
    species: 'Human',
    class: 'Wizard',
    background: 'Sage',
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    ability_bonuses: { int: 2, con: 1 },
    skill_choices: ['arcana', 'investigation', 'perception'],
    cantrips: ['Light', 'Mage Hand', 'Ray of Frost'],
    spells: ['Magic Missile', 'Shield', 'Sleep', 'Identify'],
    spellbook: ['Magic Missile', 'Shield', 'Sleep', 'Identify', 'Alarm', 'Feather Fall'],
  });
}

const breakdown = () => sheetExtras(db, campaignId).ac_breakdown;
const carried = (name: string) =>
  (listInventory(db, { campaign_id: campaignId }).items as InventoryItem[]).find((i) => i.name === name);

describe('what contributes to armour class', () => {
  it('counts one shield when a second equipped shield is also worn', () => {
    fighter(); // chain mail 16, DEX 0
    addItem(db, { campaign_id: campaignId, name: '+2 Shield', equipped: true });
    addItem(db, { campaign_id: campaignId, name: '+1 Shield', equipped: true });

    const ac = breakdown();
    expect(ac.shield).toBe(true);
    // The first shield worn is the one in use: the second adds neither its base +2 nor its +1.
    expect(ac.magic_bonus).toBe(2);
    expect(ac.total).toBe(20); // 16 chain mail + 2 for the shield + its +2
    expect(ac.notes.filter((line) => /Shield: \+\d AC/.test(line))).toEqual(['+2 Shield: +2 AC']);
  });

  it('refuses to put an item into a container and equip it in one call', () => {
    fighter();
    const before = breakdown().total;
    addItem(db, { campaign_id: campaignId, name: 'Backpack' });

    expect(() =>
      addItem(db, { campaign_id: campaignId, name: '+1 Shield', into: 'Backpack', equipped: true }),
    ).toThrow(/cannot be put in it and equipped at once/);
    // A refused call costs nothing: nothing is added and the AC does not move.
    expect(carried('+1 Shield')).toBeUndefined();
    expect(breakdown().total).toBe(before);

    // The honest path: stow it, then equip_item takes it out of the pack and the AC moves.
    addItem(db, { campaign_id: campaignId, name: '+1 Shield', into: 'Backpack' });
    expect(breakdown().total).toBe(before);
    expect(equipItem(db, { campaign_id: campaignId, name: '+1 Shield', equipped: true }).ac).toBe(before + 3);
    expect(carried('Backpack')!.container!.contents).toEqual([]);
  });

  it("adds a worn item's own mechanics.ac_bonus, armour or not, once it is attuned", () => {
    wizard(); // no armour: the base is 10 + DEX
    const bare = breakdown();
    expect(bare.armor).toBeNull();

    addItem(db, {
      campaign_id: campaignId,
      name: 'Band of Warding',
      equipped: true,
      magic: { rarity: 'uncommon', attunement: false, mechanics: { ac_bonus: 1 } },
    });
    const ac = breakdown();
    expect(ac.total).toBe(bare.total + 1);
    expect(ac.magic_bonus).toBe(1);
    expect(ac.notes).toContain('Band of Warding: +1 AC');

    // A magic item's own numbers wait for the attunement it asks for, as its clauses do.
    addItem(db, {
      campaign_id: campaignId,
      name: 'Cloak of Warding',
      equipped: true,
      magic: { rarity: 'rare', attunement: true, mechanics: { ac_bonus: 1 } },
    });
    expect(breakdown().total).toBe(bare.total + 1);
    rest(db, { campaign_id: campaignId, kind: 'short', attune: ['Cloak of Warding'] });
    expect(breakdown().total).toBe(bare.total + 2);
  });
});
