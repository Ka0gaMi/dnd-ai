import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRealm } from '../src/core/realm.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

describe('parseRealm on a safe realm', () => {
  const realm = parseRealm(safe);

  it('reads the region header', () => {
    expect(realm.name).toBe('Realm Of Poss');
    expect(realm.seed).toBe(4242);
    expect(realm.tags).toEqual(['fjord', 'civilized', 'lawful', 'safe']);
    expect(realm.origin).toContain('seed=4242');
  });

  it('lists the settlements in the order their hexes appear', () => {
    expect(realm.settlements.map((s) => s.name)).toEqual([
      'Stormcourtby',
      'Redham',
      'Ficengwind',
      'Hotfield',
      'Southern Landing',
    ]);
    const [stormcourtby, redham, ficengwind, hotfield, southern] = realm.settlements;
    expect(stormcourtby).toMatchObject({
      size: 'village',
      walled: false,
      coast: false,
      hex: 'q9_r5',
      q: 9,
      r: 5,
      terrain: 'plains',
    });
    expect(redham).toMatchObject({ size: 'town', walled: true, coast: true, hex: 'q6_r8' });
    expect(ficengwind).toMatchObject({ size: 'city', walled: true, hex: 'q4_r11', terrain: 'swamp' });
    expect(hotfield).toMatchObject({ size: 'village', coast: true, terrain: 'forest-dark' });
    expect(southern).toMatchObject({ size: 'village', coast: true });
  });

  it('has no dangers', () => {
    expect(realm.dangers).toEqual([]);
  });

  it('reads the named areas with their dominant terrain', () => {
    expect(realm.areas.map((a) => [a.name, a.hexes.length, a.terrain])).toEqual([
      ['Coldwood', 27, 'forest-dark'],
      ['Raven Marshes', 32, 'swamp'],
      ['Ironfall Fens', 2, 'swamp'],
    ]);
  });

  it('reads roads and searoutes in order', () => {
    expect(realm.routes).toHaveLength(9);
    expect(realm.routes.filter((r) => r.kind === 'road')).toHaveLength(7);
    expect(realm.routes.filter((r) => r.kind === 'searoute')).toHaveLength(2);
    expect(realm.routes[0]).toMatchObject({ kind: 'road', from_hex: 'q9_r5', to_hex: 'q6_r8' });
  });
});

describe('parseRealm on a dangerous realm', () => {
  const realm = parseRealm(dangerous);

  it('reads the header and settlements', () => {
    expect(realm.name).toBe('Ta Isle');
    expect(realm.settlements.map((s) => s.name)).toEqual(['Frostcot', 'Crimson Wharf']);
  });

  it('reads the dangers in hex order', () => {
    expect(realm.dangers.map((d) => d.name)).toEqual(['Ziggurat Of The Vampire Queen', 'Hidden Keep']);
    expect(realm.dangers.map((d) => d.hex)).toEqual(['q8_r4', 'q5_r6']);
    for (const danger of realm.dangers) {
      expect(danger.link).toContain('one-page-dungeon');
      expect(typeof danger.seed).toBe('number');
    }
  });

  it('keeps dangers out of the areas', () => {
    expect(realm.areas.map((a) => [a.name, a.terrain])).toEqual([['Shadowscale Ridge', 'mountain']]);
  });

  it('reads the single road', () => {
    expect(realm.routes).toHaveLength(1);
    expect(realm.routes[0]).toMatchObject({ kind: 'road', from_hex: 'q13_r8', to_hex: 'q10_r11' });
  });
});

describe('parseRealm refusals', () => {
  it('rejects anything that is not a region', () => {
    expect(() => parseRealm(null)).toThrow(/^Not a Perilous Shores region/);
    expect(() => parseRealm({})).toThrow(/^Not a Perilous Shores region/);
  });

  it('rejects an unsupported layout', () => {
    const odd = { ...(safe as Record<string, unknown>), layout: 'odd-q' };
    expect(() => parseRealm(odd)).toThrow('Not a Perilous Shores region: unsupported layout "odd-q"');
  });

  it('refuses two settlements with the same name instead of failing on the unique index later', () => {
    const copy = JSON.parse(JSON.stringify(safe)) as { hexes: Record<string, { town?: { name: string } }> };
    copy.hexes['q6_r8']!.town!.name = 'Stormcourtby';
    expect(() => parseRealm(copy)).toThrow('Not a Perilous Shores region: two settlements are both named "Stormcourtby"');
  });
});
