import { describe, expect, it } from 'vitest';
import { magicItems } from '../src/srd/data.js';
import { findMagicItem, namesMagicBonus } from '../src/srd/lookup.js';

/** The bundled entry itself, so every expectation is read off the data rather than invented. */
const item = (name: string) => magicItems().find((i) => i.name === name)!;
const rechargeOf = (name: string) => findMagicItem(name)!.charges!.recharge;

describe('audit: what the item lookup reads out of the bundled SRD data', () => {
  it('reads an item destroyed with its last charge as never recharging, not unknown', () => {
    for (const name of ['Talisman of Pure Good', 'Talisman of Ultimate Evil', 'Scarab of Protection']) {
      const desc = item(name).desc;
      expect(desc).toMatch(/last charge/i);
      expect(desc).toMatch(/destroyed|crumbles into powder/i);
      expect(rechargeOf(name)).toBe('never');
    }
  });

  it('still says unknown where the bundled text carries charges but no readable recharge', () => {
    for (const name of ['Wand of Fear', 'Staff of Power']) {
      const desc = item(name).desc;
      expect(desc).toMatch(/\b(?:has|have) \d+ charges/i);
      expect(desc).not.toMatch(/daily at (?:dawn|dusk)/i);
      expect(rechargeOf(name)).toBe('unknown');
    }
  });

  it('takes a weapon +N from its own text when the name carries none', () => {
    const name = 'Holy Avenger';
    const stated = /\+(\d) bonus to attack rolls and damage rolls/.exec(item(name).desc);
    expect(stated).not.toBeNull();
    expect(namesMagicBonus(name)).toBe(false);
    expect(findMagicItem(name)!.bonus).toBe(Number(stated![1]));
  });

  it('takes an armour +N from its own text when the name carries none', () => {
    const name = 'Dwarven Plate';
    const stated = /\+(\d) bonus to Armor Class/.exec(item(name).desc);
    expect(stated).not.toBeNull();
    expect(namesMagicBonus(name)).toBe(false);
    expect(findMagicItem(name)!.bonus).toBe(Number(stated![1]));
  });

  it('leaves a bonus the single bonus field cannot carry truthfully to the DM', () => {
    // A saving throw, a spell attack, an ability check, or a conditional AC bonus: none is the
    // weapon-or-armour +N the field means, so the reader must not apply it to the wrong roll.
    for (const name of [
      'Ring of Protection',
      'Cloak of Protection',
      'Talisman of Pure Good',
      'Stone of Good Luck (Luckstone)',
      'Arrow-Catching Shield',
    ]) {
      expect(item(name).desc).toMatch(/\+(\d) bonus to /i);
      expect(findMagicItem(name)!.bonus).toBeUndefined();
    }
  });

  it('reports each Figurine of Wondrous Power statuette with its own days recharge', () => {
    const desc = item('Figurine of Wondrous Power').desc;
    const waits: Record<string, number> = {
      'Bronze Griffon': 5,
      'Ebony Fly': 2,
      'Golden Lion': 7,
      'Goat of Terror': 15,
      'Goat of Traveling': 7,
      'Goat of Travail': 30,
      'Marble Elephant': 7,
      'Obsidian Steed': 5,
      'Onyx Dog': 7,
      'Serpentine Owl': 2,
      'Silver Raven': 2,
    };
    for (const [statuette, days] of Object.entries(waits)) {
      // Each statuette's own paragraph states its wait.
      const paragraph = desc.slice(desc.indexOf(statuette));
      expect(/until (\d+) days have passed/.exec(paragraph)?.[1], statuette).toBe(String(days));
      const match = findMagicItem(`Figurine of Wondrous Power (${statuette})`)!;
      expect(match.name).toBe(`Figurine of Wondrous Power (${statuette})`);
      const max = statuette === 'Goat of Traveling' ? 24 : 1;
      expect(match.charges, statuette).toEqual({ current: max, max, recharge: 'days', days });
    }
    expect(findMagicItem('Figurine of Wondrous Power (Golden Lions)')!.name).toBe('Figurine of Wondrous Power (Golden Lion)');
    expect(findMagicItem('Figurine of Wondrous Power, Silver Raven')!.rarity).toBe('uncommon');
    expect(findMagicItem('Figurine of Wondrous Power (Obsidian Steed)')!.rarity).toBe('very_rare');
    expect(findMagicItem('Figurine of Wondrous Power (Goat of Terror)')!.rarity).toBe('rare');
    expect(findMagicItem('Figurine of Wondrous Power (Brass Horse)')).toBeUndefined();
    // The entry on its own names no statuette, so it cannot say how long to wait.
    expect(rechargeOf('Figurine of Wondrous Power')).toBe('unknown');
  });

  it('reads the d20 every wand and staff rolls as its last charge goes', () => {
    const destroyed = [
      'Staff of Charming',
      'Staff of Fire',
      'Staff of Frost',
      'Staff of Healing',
      'Staff of Swarming Insects',
      'Wand of Binding',
      'Wand of Enemy Detection',
      'Wand of Fireballs',
      'Wand of Lightning Bolts',
      'Wand of Magic Missiles',
      'Wand of Paralysis',
      'Wand of Polymorph',
      'Wand of Web',
      'Wand of Wonder',
    ];
    const expected: Record<string, unknown> = {
      ...Object.fromEntries(destroyed.map((name) => [name, { on_1: 'destroyed' }])),
      'Staff of Striking': { on_1: 'quarterstaff' },
      'Staff of the Woodlands': { on_1: 'quarterstaff' },
      'Staff of Power': { on_1: 'drained', on_20: '1d8+2' },
      'Staff of the Magi': { on_20: '1d12+1' },
    };
    const rolling = magicItems().filter((entry) => /last charge, roll 1d20/i.test(entry.desc));
    expect(rolling.map((entry) => entry.name).sort()).toEqual(Object.keys(expected).sort());
    for (const entry of rolling) {
      expect(findMagicItem(entry.name)!.charges!.last_charge, entry.name).toEqual(expected[entry.name]);
    }
    // The Staff of the Magi rolls for a 20 only: nothing in its text happens on a 1.
    expect(item('Staff of the Magi').desc).toMatch(/roll 1d20\. On a 20, the staff regains 1d12 \+ 1 charges\./);
    expect(item('Staff of the Magi').desc).not.toMatch(/On a 1,/);
    // The Talismans and the Scarab go with their last charge outright, with no roll.
    expect(findMagicItem('Scarab of Protection')!.charges!.last_charge).toBeUndefined();
  });
});
