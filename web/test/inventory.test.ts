import { describe, expect, it } from 'vitest';
import { flatItems, itemBadges, itemKey, purseLine } from '../src/lib/inventory';

describe('itemKey', () => {
  it('prefers the server id', () => {
    expect(itemKey({ name: 'Dagger', id: 'dagger-2' }, 3)).toBe('dagger-2');
  });

  it('keeps two items of the same name apart when neither has an id', () => {
    const items = [{ name: 'Dagger' }, { name: 'Dagger' }];
    expect(items.map(itemKey)).toEqual(['Dagger-0', 'Dagger-1']);
  });
});

describe('flatItems', () => {
  it('lists a container followed by what it holds, one level deeper', () => {
    const rows = flatItems([
      { name: 'Backpack', id: 'backpack', container: { contents: [{ name: 'Rations', id: 'rations' }] } },
      { name: 'Longsword', id: 'longsword' },
    ]);
    expect(rows.map((row) => [row.item.name, row.depth])).toEqual([
      ['Backpack', 0],
      ['Rations', 1],
      ['Longsword', 0],
    ]);
  });

  it('keys a nested item under its container, so the same name inside and out cannot collide', () => {
    const rows = flatItems([
      { name: 'Rations' },
      { name: 'Backpack', container: { contents: [{ name: 'Rations' }] } },
    ]);
    expect(rows.map((row) => row.key)).toEqual(['Rations-0', 'Backpack-1', 'Backpack-1/Rations-0']);
  });

  it('is empty for a sheet with no inventory', () => {
    expect(flatItems(null)).toEqual([]);
  });
});

describe('itemBadges', () => {
  it('shows rarity, bonus and attunement for a +1 attuned weapon', () => {
    const badges = itemBadges({
      name: '+1 Longsword',
      magic: { rarity: 'uncommon', attunement: true, attuned: true, bonus: 1, identified: true },
    });
    expect(badges.map((badge) => badge.text)).toEqual(['uncommon', '+1', 'attuned']);
  });

  it('asks for attunement while the item is not attuned to', () => {
    const badges = itemBadges({ name: 'Cloak', magic: { rarity: 'rare', attunement: 'by a Paladin' } });
    expect(badges.map((badge) => badge.text)).toEqual(['rare', 'needs attunement']);
  });

  it('gives an unidentified masked item no badges at all', () => {
    expect(itemBadges({ name: 'Unidentified longsword', qty: 1, id: 'longsword' })).toEqual([]);
  });

  it('shows charges as current over max with the recharge word', () => {
    const badges = itemBadges({
      name: 'Wand of Magic Missiles',
      magic: { rarity: 'uncommon', attunement: false, identified: true, charges: { current: 3, max: 7, recharge: 'dawn' } },
    });
    expect(badges.map((badge) => badge.text)).toContain('3/7 · dawn');
    expect(badges.find((badge) => badge.text === '3/7 · dawn')?.help).toBe('magic_charges');
  });

  it('spells out a rarity and a recharge written with an underscore', () => {
    const badges = itemBadges({
      name: 'Staff',
      magic: { rarity: 'very_rare', attunement: false, identified: true, charges: { current: 0, max: 5, recharge: 'long_rest' } },
    });
    expect(badges.map((badge) => badge.text)).toEqual(['very rare', '0/5 · long rest']);
  });

  it('counts what a Bag of Holding holds and marks it weightless', () => {
    const badges = itemBadges({
      name: 'Bag of Holding',
      magic: { rarity: 'uncommon', attunement: false, identified: true },
      container: { weightless_contents: true, capacity_lb: 500, contents: [{ name: 'Anvil' }, { name: 'Rope' }] },
    });
    expect(badges.map((badge) => badge.text)).toEqual(['uncommon', 'holds 2 items', 'weightless']);
  });
});

describe('purseLine', () => {
  it('lists the purse largest coin first', () => {
    expect(purseLine({ cp: 7, sp: 3, ep: 0, gp: 40, pp: 12 })).toBe('12 pp · 40 gp · 3 sp · 7 cp');
  });

  it('leaves out every denomination at zero, electrum included', () => {
    expect(purseLine({ cp: 0, sp: 0, ep: 2, gp: 5, pp: 0 })).toBe('5 gp · 2 ep');
  });

  it('says nothing for an empty purse or an older server', () => {
    expect(purseLine({ cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 })).toBeNull();
    expect(purseLine(undefined)).toBeNull();
  });
});
