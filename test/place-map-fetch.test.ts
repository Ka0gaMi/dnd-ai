import { describe, expect, it } from 'vitest';
import { PlaceMapFetchError, fetchPlaceMap, placeMapKind } from '../src/core/place-map-fetch.js';

const CITY_LINK =
  'https://watabou.github.io/city-generator/?size=16&seed=1081863920&name=Redham&citadel=0&urban_castle=0&walls=1&shantytown=1&gates=1&plaza=0&temple=1&river=0&coast=1&sea=-0.6025368523640575&from=perilous';
const VILLAGE_LINK =
  'https://watabou.github.io/village-generator/?seed=78732595&name=Hotfield&tags=coast&from=perilous';
const DUNGEON_LINK = 'https://watabou.github.io/one-page-dungeon/?seed=271890816&name=Hidden%20Keep&from=perilous';

describe('placeMapKind', () => {
  it('recognises the three Watabou generators from their links', () => {
    expect(placeMapKind(CITY_LINK)).toBe('city');
    expect(placeMapKind(VILLAGE_LINK)).toBe('village');
    expect(placeMapKind(DUNGEON_LINK)).toBe('dungeon');
  });

  it('returns null for a perilous-shores link', () => {
    expect(placeMapKind('https://watabou.github.io/perilous-shores/?seed=42')).toBeNull();
  });

  it('returns null for another host and for text that is not a URL', () => {
    expect(placeMapKind('https://example.com/city-generator/')).toBeNull();
    expect(placeMapKind('not a url')).toBeNull();
  });
});

describe('fetchPlaceMap', () => {
  it('rejects a link that is not a Watabou place map before launching a browser', async () => {
    await expect(fetchPlaceMap('https://example.com/x')).rejects.toBeInstanceOf(PlaceMapFetchError);
  });
});

describe.skipIf(!process.env.REGION_LIVE)('live place map fetch', () => {
  it(
    'fetches the village export',
    async () => {
      const result = await fetchPlaceMap(VILLAGE_LINK);
      expect(result.kind).toBe('village');
      expect((result.raw as any).features.map((feature: any) => feature.id)).toContain('buildings');
    },
    120_000,
  );

  it(
    'fetches the city export',
    async () => {
      const result = await fetchPlaceMap(CITY_LINK);
      expect(result.kind).toBe('city');
      expect((result.raw as any).features.map((feature: any) => feature.id)).toContain('districts');
    },
    120_000,
  );

  it(
    'fetches the dungeon export',
    async () => {
      const result = await fetchPlaceMap(DUNGEON_LINK);
      expect(result.kind).toBe('dungeon');
      expect((result.raw as any).title).toBe('Hidden Keep');
      expect((result.raw as any).rects.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
