import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { addItem, createCharacter, listInventory, sellItem } from '../src/core/character.js';
import { COIN_CP, coinsCp, type Coin, type Coins } from '../src/core/rules.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { equipment, pdfEquipment, type EquipmentData, type PdfEquipmentRow } from '../src/srd/data.js';
import { findEquipment, itemPrice, srdSearch } from '../src/srd/lookup.js';
import { replyData } from './helpers/reply.js';

// Names the PDF prints differently from the item, beyond the case, hyphens and trailing notes the lookup ignores.
const ALIASES: Record<string, string> = {
  'Spell Scroll (Cantrip)': 'Spell Scroll, Cantrip',
  'Spell Scroll (Level 1)': 'Spell Scroll, Level 1',
  'Wooden staff (also a Quarterstaff)': 'Staff',
  'Feed per day': 'Feed',
  'Stabling per day': 'Stabling',
};
// Priced only by the PDF: each becomes an item of its own, named "Saddle, Exotic" for a row under a group.
const PDF_ONLY_TABLES = [
  'Mounts and Other Animals',
  'Tack, Harness, and Drawn Vehicles',
  'Airborne and Waterborne Vehicles',
  'Food, Drink, and Lodging',
];

const rows = pdfEquipment();
const itemName = (row: PdfEquipmentRow): string =>
  ALIASES[row.name] ??
  (row.group && PDF_ONLY_TABLES.includes(row.table) ? `${row.group.replace(/ per day$| \(\w+\)$/i, '')}, ${row.name}` : row.name);
const costCp = (cost: { quantity: number; unit: string }): number => cost.quantity * COIN_CP[cost.unit as Coin];
const withoutUrls = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value, (key, v: unknown) => (key === 'url' ? undefined : v)));

describe('SRD 5.2.1 equipment prices', () => {
  it('reads every priced row of the PDF Equipment chapter', () => {
    expect(rows).toHaveLength(224);
    expect(rows.filter((row) => PDF_ONLY_TABLES.includes(row.table))).toHaveLength(42);
  });

  it('resolves every item the PDF prices to the PDF price, with every other field the PDF prints', () => {
    for (const row of rows) {
      const item = findEquipment(itemName(row));
      expect(item, row.name).toBeDefined();
      expect(costCp(item!.cost!), row.name).toBe(costCp(row.cost!));
      expect(itemPrice(item!.name), row.name).toEqual({ cp: costCp(row.cost!), per: row.quantity ?? 1 });
      const { name: _name, table: _table, group, details: _details, ...printed } = row;
      for (const [field, value] of Object.entries(printed)) {
        expect(withoutUrls(item![field as keyof EquipmentData]), `${row.name}: ${field}`).toEqual(value);
      }
      // 5e-bits already agrees with the Weapons table's category headings, so they are checked, not overlaid.
      if (row.table === 'Weapons') {
        expect(item!.equipment_categories.map((c) => c.index), row.name).toContain(group!.toLowerCase().replace(/ /g, '-'));
      }
    }
  });

  it('prices the three weapons a playtest shop skipped as the PDF does', () => {
    expect(findEquipment('Javelin')!.cost).toEqual({ quantity: 5, unit: 'sp' });
    expect(itemPrice('Javelin')).toEqual({ cp: 50, per: 1 });
    expect(itemPrice('Longbow')).toEqual({ cp: 5000, per: 1 });
    expect(itemPrice('Spear')).toEqual({ cp: 100, per: 1 });
  });

  it('files Hide Armor under Medium Armor, where the PDF Armor table lists it', () => {
    const categories = findEquipment('Hide Armor')!.equipment_categories.map((c) => c.index);
    expect(categories).toContain('medium-armor');
    expect(categories).not.toContain('light-armor');
  });

  it('adds the mounts, vehicles, food and lodging only the PDF prices, labelling a per-day price', () => {
    const horse = findEquipment('Horse, Riding')!;
    expect(horse).toMatchObject({ index: 'horse-riding', cost: { quantity: 75, unit: 'gp' } });
    expect(horse.equipment_categories.map((c) => c.name)).toEqual(['Mounts and Vehicles', 'Mounts and Other Animals']);
    expect(horse.description).toBe('Carrying Capacity: 480 lb.');
    expect(findEquipment('Saddle, Exotic')).toMatchObject({ cost: { quantity: 60, unit: 'gp' }, weight: 40 });
    expect(findEquipment('Airship')!.description).toMatch(/^Speed: 8 mph\. Crew: 10\./);
    for (const name of ['Feed', 'Stabling', 'Inn Stay, Squalid', 'Inn Stay, Aristocratic']) {
      expect(findEquipment(name)!.description, name).toMatch(/^Priced per day\./);
    }
    expect(findEquipment('Ale (mug)')).toMatchObject({ name: 'Ale', description: 'Priced per mug.' });
    expect(findEquipment('Wine, Fine')!.equipment_categories.map((c) => c.index)).toEqual(['food-drink-and-lodging']);

    const indexes = equipment().map((item) => item.index);
    expect(new Set(indexes).size).toBe(indexes.length);
    const matched = new Set(rows.map((row) => findEquipment(itemName(row))!.index));
    expect(equipment().filter((item) => !matched.has(item.index)).map((item) => item.name)).toEqual(['Spellbook']);
    expect(itemPrice('Spellbook')).toEqual({ cp: 5000, per: 1 });
  });

  it('shows a bundle price with its size in the SRD search', () => {
    const [arrows] = srdSearch('item', 'Arrows', 1).results as Array<{ name: string; cost: string }>;
    expect(arrows).toMatchObject({ name: 'Arrows', cost: '1 gp for 20' });
  });
});

describe('ammunition sold and bought by the piece', () => {
  let db: Db;
  let campaignId: number;

  beforeEach(() => {
    db = openDb(':memory:');
    campaignId = createCampaign(db, { name: 'Quiver', story_shape: 'sandbox' }).campaign_id;
    createCharacter(db, {
      campaign_id: campaignId,
      name: 'Borg',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier', // brings 20 Arrows
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    });
  });

  it('sells 20 Arrows for half the 1 gp the SRD asks for 20, not half of 1 gp each', () => {
    expect(sellItem(db, { campaign_id: campaignId, item: 'Arrows', qty: 20 })).toMatchObject({
      price_gp: 0.5,
      paid: '5 sp',
      rule: 'half the SRD price of 1 gp for 20 (2024 rule of thumb for selling)',
    });
  });

  it('weighs a piece at its share of the bundle: 20 Arrows weigh 1 lb', () => {
    const before = listInventory(db, { campaign_id: campaignId });
    expect(before.items.find((item) => item.name === 'Arrows')).toMatchObject({ qty: 20, weight_lb: 0.05 });
    const bolts = addItem(db, { campaign_id: campaignId, name: 'Bolts', qty: 20 }).item;
    expect(bolts).toMatchObject({ weight_lb: 0.075, notes: 'Ammunition; 1.5 lb per 20' });
    expect(listInventory(db, { campaign_id: campaignId }).carried_lb).toBe(before.carried_lb + 1.5);
  });

  it('rounds a part bundle down once for the lot', () => {
    addItem(db, { campaign_id: campaignId, name: 'Bullets, Sling', qty: 20 });
    expect(sellItem(db, { campaign_id: campaignId, item: 'Arrows', qty: 1 }).price_gp).toBe(0.02);
    expect(sellItem(db, { campaign_id: campaignId, item: 'Bullets, Sling', qty: 20 }).price_gp).toBe(0.02);
    expect(sellItem(db, { campaign_id: campaignId, item: 'Arrows', qty: 3 }).price_gp).toBe(0.07);
  });

  it('pays a price below a gold piece in copper, so the purse never holds part of a coin', () => {
    const before = coinsCp(addItem(db, { campaign_id: campaignId, name: 'Rope' }).coins as Coins);
    const bought = addItem(db, { campaign_id: campaignId, name: 'Arrows', qty: 7, cost_gp: 0.35 });
    expect(coinsCp(bought.coins as Coins)).toBe(before - 35);
    expect(Object.values(bought.coins).every(Number.isInteger)).toBe(true);
  });

  it('accepts that price through the inventory tool', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({
      name: 'inventory',
      arguments: { campaign_id: campaignId, op: 'add', name: 'Inn Stay, Modest', qty: 2, cost_gp: 1 },
    });
    expect(result.isError).toBeFalsy();
    const ale = await client.callTool({
      name: 'inventory',
      arguments: { campaign_id: campaignId, op: 'add', name: 'Ale', qty: 3, cost_gp: 0.12 },
    });
    expect(ale.isError).toBeFalsy();
    const { coins } = replyData<{ coins: Coins }>(ale);
    expect(coinsCp(coins)).toBe(1800 - 100 - 12);
    await client.close();
  });
});
