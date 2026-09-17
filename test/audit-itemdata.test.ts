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

  // The Figurine's charge pool regains all charges after 7 days. ChargeRecharge has no multi-day bucket
  // and widening it reaches into src/core/character.ts, which this package does not own, so the reader
  // still reports unknown. Reported as a dependency rather than fixed here.
  it.todo('reports the Figurine of Wondrous Power 7-day recharge once a days bucket exists');
});
