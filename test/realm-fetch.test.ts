import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REALM_BASE_URL, RealmFetchError, fetchRealm, realmUrl } from '../src/core/realm-fetch.js';

describe('realmUrl', () => {
  it('defaults to the medium map size and appends its w and h', () => {
    expect(realmUrl(4242, [])).toBe(`${REALM_BASE_URL}?seed=4242&w=2400&h=2400`);
  });

  it('appends the tags in order, comma separated, then the size', () => {
    expect(realmUrl(4242, ['fjord', 'civilized'])).toBe(
      `${REALM_BASE_URL}?seed=4242&tags=fjord,civilized&w=2400&h=2400`,
    );
  });

  it('appends the side length for each size', () => {
    expect(realmUrl(1, [], 'small')).toContain('w=1200&h=1200');
    expect(realmUrl(1, [], 'medium')).toContain('w=2400&h=2400');
    expect(realmUrl(1, [], 'large')).toContain('w=3600&h=3600');
  });

  it('encodes a tag that contains a space', () => {
    expect(realmUrl(7, ['ice field'])).toBe(`${REALM_BASE_URL}?seed=7&tags=ice%20field&w=2400&h=2400`);
  });

  it('refuses a negative or fractional seed', () => {
    expect(() => realmUrl(-1, [])).toThrow(RealmFetchError);
    expect(() => realmUrl(1.5, [])).toThrow(RealmFetchError);
  });
});

describe.skipIf(!process.env.REGION_LIVE)('live region fetch', () => {
  it(
    'fetches seed 4242 and matches the saved fixture in everything but the generated names',
    async () => {
      const result = await fetchRealm(4242, ['fjord', 'civilized', 'lawful', 'safe'], { size: 'small' });
      const fixture = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8'));
      // Perilous Shores names places from a PRNG the seed does not reset, so only the geography is compared.
      const geography = (realm: any) => ({
        bp: realm.bp,
        layout: realm.layout,
        hexes: Object.fromEntries(
          Object.entries(realm.hexes).map(([id, hex]: [string, any]) => [id, [hex.terrain ?? null, hex.town?.type ?? null, hex.town?.seed ?? null]]),
        ),
        rivers: realm.rivers,
        roads: realm.roads,
        searoutes: realm.searoutes,
        features: realm.features.map((feature: any) => feature.hexes),
      });
      expect(geography(result.raw)).toEqual(geography(fixture));
      expect(result.url).toContain('seed=4242');
    },
    120_000,
  );
});
