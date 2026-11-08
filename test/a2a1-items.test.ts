// A2a-1 items: SRD-priced magic items, the last-charge d20, a figurine's days recharge and a masked equip event.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus, type GameEvent } from '../src/core/bus.js';
import { advanceTime } from '../src/core/calendar.js';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import { addItem, createCharacter, equipItem, listInventory, sellItem, useItem } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Satchel', story_shape: 'sandbox' }).campaign_id;
  // Borg the Soldier: Chain Mail for AC 16, 18 gp in the purse.
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

const items = () => listInventory(db, { campaign_id: campaignId }).items;
const carried = (name: string) => items().find((i) => i.name === name || i.true_name === name);
/** Everything the campaign logged, text and payload, which the bus and the player feed both carry. */
const written = (): string =>
  (db.prepare('SELECT text, payload_json FROM event WHERE campaign_id = ?').all(campaignId) as Array<{
    text: string;
    payload_json: string | null;
  }>)
    .map((e) => `${e.text} ${e.payload_json ?? ''}`)
    .join('\n');
const playerFeed = (): string =>
  campaignSnapshot(db, campaignId, { forPlayer: true })
    .recent_events.map((e) => e.text)
    .join('\n');
const rolls = () =>
  db.prepare('SELECT purpose, total FROM roll WHERE campaign_id = ? ORDER BY id').all(campaignId) as Array<{
    purpose: string;
    total: number;
  }>;
/** rpg-dice-roller reads Math.random: 0 rolls every die a 1, 0.041 a d20 a 20, 0.5 a d20 a 9. */
const pinDice = (value: number) => vi.spyOn(Math, 'random').mockReturnValue(value);

describe('selling a magic item the SRD equipment list prices', () => {
  it('sells a Potion of Healing at half its 50 gp list price', () => {
    addItem(db, { campaign_id: campaignId, name: 'Potion of Healing', qty: 2 });
    const sold = sellItem(db, { campaign_id: campaignId, item: 'Potion of Healing', qty: 2 });
    expect(sold).toMatchObject({
      sold: 2,
      price_gp: 50,
      rule: 'half the SRD price of 50 gp (2024 rule of thumb for selling)',
      gold: 68,
    });
    expect(carried('Potion of Healing')).toBeUndefined();
  });

  it('still refuses a +1 weapon without price_gp, and the refusal costs nothing', () => {
    addItem(db, { campaign_id: campaignId, name: '+1 Longsword' });
    expect(() => sellItem(db, { campaign_id: campaignId, item: '+1 Longsword' })).toThrow(
      /a magic item has no SRD price.*Pass price_gp/s,
    );
    expect(carried('+1 Longsword')).toMatchObject({ qty: 1 });
    expect(listInventory(db, { campaign_id: campaignId }).gold).toBe(18);
    expect(sellItem(db, { campaign_id: campaignId, item: '+1 Longsword', price_gp: 500 }).price_gp).toBe(500);

    // An invented +1 named for its base is no more the plain Sickle than "+1 Longsword" is a Longsword.
    addItem(db, { campaign_id: campaignId, name: 'Sickle', magic: { rarity: 'uncommon', bonus: 1 } });
    expect(() => sellItem(db, { campaign_id: campaignId, item: 'Sickle' })).toThrow(/a magic item has no SRD price/);
  });

  it('never prices an unidentified potion off the SRD, so the sale cannot name it', () => {
    addItem(db, { campaign_id: campaignId, name: 'Potion of Healing', unidentified: true });
    expect(() => sellItem(db, { campaign_id: campaignId, item: 'Unidentified potion' })).toThrow(
      /is unidentified.*Pass price_gp/s,
    );
    expect(carried('Potion of Healing')).toMatchObject({ qty: 1 });

    const sold = sellItem(db, { campaign_id: campaignId, item: 'Unidentified potion', price_gp: 30 });
    expect(sold).toMatchObject({ price_gp: 30, rule: 'the price you named' });
    const log = written();
    expect(log).toMatch(/sells 1x Unidentified potion for 3 pp at the price you named/);
    for (const leak of ['Potion of Healing', '50 gp', 'SRD price']) {
      expect(log, leak).not.toContain(leak);
      expect(playerFeed(), leak).not.toContain(leak);
    }
  });
});

describe('the d20 an item rolls as its last charge goes', () => {
  it('destroys a wand on a 1, recording the roll and naming it only as the player knows it', () => {
    addItem(db, { campaign_id: campaignId, name: 'Wand of Magic Missiles', unidentified: true });
    pinDice(0);
    const spent = useItem(db, { campaign_id: campaignId, item: 'Unidentified wand', charges: 7 });

    expect(spent).toMatchObject({ remaining: 0, last_charge: { rolled: 1, result: 'it is destroyed' } });
    expect(carried('Wand of Magic Missiles')).toBeUndefined();
    expect(rolls()).toEqual([{ purpose: 'Unidentified wand: its last charge is spent', total: 1 }]);
    const log = written();
    expect(log).toMatch(/Borg's Unidentified wand rolled a 1 as its last charge went: it is destroyed\./);
    expect(log).not.toContain('Magic Missiles');
    expect(playerFeed()).toMatch(/Unidentified wand rolled a 1/);
    expect(playerFeed()).not.toContain('Magic Missiles');
  });

  it('keeps the wand, empty, on any other roll', () => {
    addItem(db, { campaign_id: campaignId, name: 'Wand of Magic Missiles' });
    pinDice(0.5);
    useItem(db, { campaign_id: campaignId, item: 'Wand of Magic Missiles', charges: 6 });
    // Spending down to one charge rolls nothing.
    expect(rolls()).toEqual([]);
    const last = useItem(db, { campaign_id: campaignId, item: 'Wand of Magic Missiles' });

    expect(last.last_charge).toEqual({ rolled: 9, result: 'nothing happens' });
    expect(carried('Wand of Magic Missiles')!.magic!.charges!.current).toBe(0);
    expect(rolls()).toEqual([{ purpose: 'Wand of Magic Missiles: its last charge is spent', total: 9 }]);
    expect(written()).not.toMatch(/is destroyed/);
  });

  it('gives the Staff of the Magi 1d12 + 1 charges back on a 20 and does nothing on a 1', () => {
    addItem(db, { campaign_id: campaignId, name: 'Staff of the Magi' });
    pinDice(0);
    expect(useItem(db, { campaign_id: campaignId, item: 'Staff of the Magi', charges: 50 }).last_charge).toEqual({
      rolled: 1,
      result: 'nothing happens',
    });
    expect(carried('Staff of the Magi')!.magic!.charges!.current).toBe(0);

    useItem(db, { campaign_id: campaignId, item: 'Staff of the Magi', restore: 1 });
    pinDice(0.041);
    const twenty = useItem(db, { campaign_id: campaignId, item: 'Staff of the Magi' });
    const regained = rolls().at(-1)!;
    expect(regained.purpose).toBe('Staff of the Magi regains charges on a 20');
    expect(twenty).toMatchObject({ remaining: regained.total, last_charge: { rolled: 20 } });
    expect(carried('Staff of the Magi')!.magic!.charges!.current).toBe(regained.total);
    expect(written()).toMatch(/Staff of the Magi rolled a 20 as its last charge went: it regains \d+ charges/);
  });

  it('turns a Staff of Striking into a plain Quarterstaff on a 1', () => {
    addItem(db, { campaign_id: campaignId, name: 'Staff of Striking' });
    pinDice(0);
    const spent = useItem(db, { campaign_id: campaignId, item: 'Staff of Striking', charges: 10 });
    expect(spent.last_charge).toEqual({ rolled: 1, result: 'it becomes a nonmagical Quarterstaff' });
    expect(carried('Staff of Striking')).toBeUndefined();
    const staff = carried('Quarterstaff')!;
    expect(staff.magic).toBeUndefined();
    expect(staff.qty).toBe(1);
  });

  it('drains a Staff of Power of its charges on a 1', () => {
    addItem(db, { campaign_id: campaignId, name: 'Staff of Power' });
    pinDice(0);
    useItem(db, { campaign_id: campaignId, item: 'Staff of Power', charges: 20 });
    const staff = carried('Staff of Power')!;
    expect(staff.magic!.charges).toBeUndefined();
    expect(staff.notes).toMatch(/drained by its last charge/);
    expect(() => useItem(db, { campaign_id: campaignId, item: 'Staff of Power' })).toThrow(/has no charges/);
  });
});

describe('a Figurine of Wondrous Power recharges in days', () => {
  it('comes back once its 5 days have passed since it was used, and not before', () => {
    addItem(db, { campaign_id: campaignId, name: 'Figurine of Wondrous Power (Bronze Griffon)' });
    const used = useItem(db, { campaign_id: campaignId, item: 'Figurine of Wondrous Power (Bronze Griffon)' });
    expect(used).toMatchObject({ remaining: 0, recharges: '5 days after the last one goes' });
    expect(rolls()).toEqual([]);

    advanceTime(db, campaignId, { days: 4, hours: 23 });
    const griffon = () => carried('Figurine of Wondrous Power (Bronze Griffon)')!.magic!.charges!;
    expect(griffon().current).toBe(0);
    expect(() => useItem(db, { campaign_id: campaignId, item: 'Figurine of Wondrous Power (Bronze Griffon)' })).toThrow(
      /no charges left; it recharges 5 days after the last one goes/,
    );

    advanceTime(db, campaignId, { hours: 1 });
    expect(griffon()).toMatchObject({ current: 1, max: 1 });
    expect(griffon().empty_since).toBeUndefined();
    expect(written()).toMatch(/charged items recharge: Figurine of Wondrous Power \(Bronze Griffon\) regains 1 \(1\/1\)/);
  });

  it('refuses a days recharge the DM sets without its days, costing nothing', () => {
    expect(() =>
      addItem(db, {
        campaign_id: campaignId,
        name: 'Jade Toad',
        cost_gp: 5,
        magic: { rarity: 'rare', charges: { current: 1, max: 1, recharge: 'days' } },
      }),
    ).toThrow(/recharges in days: pass magic\.charges\.days/);
    expect(carried('Jade Toad')).toBeUndefined();
    expect(listInventory(db, { campaign_id: campaignId }).gold).toBe(18);
  });
});

describe('the equip event of an unidentified shield', () => {
  it('shows the AC without the hidden +1 and "+?", while the DM reply stays true', () => {
    const seen: GameEvent[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event));
    try {
      addItem(db, { campaign_id: campaignId, name: '+1 Shield', unidentified: true });
      const dm = equipItem(db, { campaign_id: campaignId, name: 'Unidentified shield', equipped: true });
      expect(dm.ac).toBe(19);
      expect(dm.ac_breakdown.total).toBe(19);

      const event = seen.filter((e) => e.kind === 'inventory').at(-1)!;
      expect(event.text).toBe('Borg equips Unidentified shield (AC 18 +?).');
      expect(event.payload).toMatchObject({ ac: 18, ac_unknown: true });
      expect(JSON.stringify(event)).not.toMatch(/AC 19|"ac":19|\+1 Shield/);
      const feed = playerFeed();
      expect(feed).toContain('Borg equips Unidentified shield (AC 18 +?).');
      expect(feed).not.toMatch(/AC 19/);
    } finally {
      unsubscribe();
    }
  });

  it('shows the true AC once nothing worn is hidden', () => {
    addItem(db, { campaign_id: campaignId, name: '+1 Shield' });
    equipItem(db, { campaign_id: campaignId, name: '+1 Shield', equipped: true });
    expect(written()).toMatch(/Borg equips \+1 Shield \(AC 19\)\. \{[^}]*"ac":19/);
    expect(written()).not.toContain('+?');
  });
});
