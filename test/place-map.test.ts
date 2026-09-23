import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { getPlaceMap, savePlaceMap } from '../src/core/place-map.js';
import { findPlace, importRegion } from '../src/core/region.js';
import { openDb, type Db } from '../src/db/connection.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

const safe = fixture('realm-safe.json');
const dangerous = fixture('realm-dangerous.json');
const cityRedham = fixture('map-city-redham.json');
const dungeonHiddenKeep = fixture('map-dungeon-hidden-keep.json');

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(name = 'The Ashfall Road'): number {
  return createCampaign(db, { name, story_shape: 'structured' }).campaign_id;
}

describe('savePlaceMap and getPlaceMap', () => {
  it('stores a city map for a settlement and replaces it on a second save', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });
    const redham = findPlace(db, campaignId, 'Redham')!;

    const stored = savePlaceMap(db, campaignId, redham.id, {
      kind: 'city',
      url: 'https://watabou.github.io/city/?seed=1',
      raw: cityRedham,
    });
    expect(stored.kind).toBe('city');
    expect(stored.url).toBe('https://watabou.github.io/city/?seed=1');
    expect((stored.raw as { type?: string }).type).toBe('FeatureCollection');
    expect(stored.fetched_at).toBeTruthy();

    const loaded = getPlaceMap(db, campaignId, redham.id)!;
    expect(loaded.raw).toEqual(cityRedham);

    savePlaceMap(db, campaignId, redham.id, {
      kind: 'village',
      url: 'https://watabou.github.io/village/?seed=2',
      raw: cityRedham,
    });
    expect(getPlaceMap(db, campaignId, redham.id)!.kind).toBe('village');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM world_place_map WHERE campaign_id = ?').get(campaignId),
    ).toEqual({ n: 1 });
  });

  it('returns null when nothing is stored or the place is another campaign\'s', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });
    const redham = findPlace(db, campaignId, 'Redham')!;
    expect(getPlaceMap(db, campaignId, redham.id)).toBeNull();

    savePlaceMap(db, campaignId, redham.id, { kind: 'city', url: 'u', raw: cityRedham });
    const other = newCampaign('Other');
    expect(getPlaceMap(db, campaignId, redham.id)).not.toBeNull();
    expect(getPlaceMap(db, other, redham.id)).toBeNull();
  });

  it('refuses a mismatched or area map and an unknown place', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });
    const redham = findPlace(db, campaignId, 'Redham')!;
    const coldwood = findPlace(db, campaignId, 'Coldwood')!;

    expect(() => savePlaceMap(db, campaignId, redham.id, { kind: 'dungeon', url: 'u', raw: {} })).toThrow(
      'cannot hold',
    );
    expect(() => savePlaceMap(db, campaignId, coldwood.id, { kind: 'city', url: 'u', raw: {} })).toThrow(
      'cannot hold',
    );
    expect(() => savePlaceMap(db, campaignId, 999999, { kind: 'city', url: 'u', raw: {} })).toThrow('No place');
  });

  it('stores a dungeon map for a danger', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, dangerous, { source: 'uploaded' });
    const hiddenKeep = findPlace(db, campaignId, 'Hidden Keep')!;

    const stored = savePlaceMap(db, campaignId, hiddenKeep.id, {
      kind: 'dungeon',
      url: 'https://watabou.github.io/one-page-dungeon/?seed=271890816',
      raw: dungeonHiddenKeep,
    });
    expect(stored.kind).toBe('dungeon');
    expect((stored.raw as { title?: string }).title).toBe('Hidden Keep');
  });
});

describe('importRegion replace', () => {
  it('clears stored place maps so the swap is not blocked and leaves none behind', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });
    const redham = findPlace(db, campaignId, 'Redham')!;
    savePlaceMap(db, campaignId, redham.id, { kind: 'city', url: 'u', raw: cityRedham });

    expect(() => importRegion(db, campaignId, dangerous, { source: 'uploaded', replace: true })).not.toThrow();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM world_place_map WHERE campaign_id = ?').get(campaignId),
    ).toEqual({ n: 0 });
  });
});
