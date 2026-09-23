import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { getPolitics, regionHexes, savePolitics } from '../src/core/politics-store.js';
import { findPlace, importRegion } from '../src/core/region.js';
import { openDb, type Db } from '../src/db/connection.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

const safe = fixture('realm-safe.json');
const dangerous = fixture('realm-dangerous.json');

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(name = 'The Ashfall Road'): number {
  return createCampaign(db, { name, story_shape: 'structured' }).campaign_id;
}

function importSafe(campaignId: number): { redham: number; ficengwind: number; stormcourtby: number } {
  importRegion(db, campaignId, safe, { source: 'generated' });
  return {
    redham: findPlace(db, campaignId, 'Redham')!.id,
    ficengwind: findPlace(db, campaignId, 'Ficengwind')!.id,
    stormcourtby: findPlace(db, campaignId, 'Stormcourtby')!.id,
  };
}

function twoRealms(places: { redham: number; ficengwind: number; stormcourtby: number }) {
  return {
    realms: [
      { name: 'Redham Realm', capital_place_id: places.redham },
      { name: 'Ficengwind Realm', capital_place_id: places.ficengwind },
    ],
    counties: [
      { name: 'North March', seat_place_id: places.redham, realm: 0, hexes: ['q6_r8', 'q5_r8'] },
      { name: 'South March', seat_place_id: places.stormcourtby, realm: 0, hexes: ['q9_r5'] },
      { name: 'Fen County', seat_place_id: places.ficengwind, realm: 1, hexes: ['q4_r11', 'q3_r11'] },
    ],
  };
}

describe('regionHexes', () => {
  it('returns every hex of the region with its terrain', () => {
    const campaignId = newCampaign();
    importSafe(campaignId);

    const hexes = regionHexes(db, campaignId)!;
    expect(hexes).toHaveLength(265);
    expect(hexes[0]).toEqual({ id: 'q3_r0', q: 3, r: 0, terrain: 'plains' });
    expect(hexes.find((hex) => hex.id === 'q6_r8')).toEqual({ id: 'q6_r8', q: 6, r: 8, terrain: 'plains' });
    expect(hexes.find((hex) => hex.id === 'q4_r11')).toEqual({ id: 'q4_r11', q: 4, r: 11, terrain: 'swamp' });
  });

  it('returns null without a region', () => {
    expect(regionHexes(db, newCampaign())).toBeNull();
  });
});

describe('savePolitics and getPolitics', () => {
  it('stores realms and counties and reads them back grouped', () => {
    const campaignId = newCampaign();
    const places = importSafe(campaignId);

    const stored = savePolitics(db, campaignId, twoRealms(places));
    expect(stored.realms).toHaveLength(2);
    expect(stored.counties).toHaveLength(3);
    expect(stored.realms[0]).toMatchObject({
      name: 'Redham Realm',
      capital_place_id: places.redham,
      county_ids: [stored.counties[0]!.id, stored.counties[1]!.id],
    });
    expect(stored.realms[1]).toMatchObject({
      name: 'Ficengwind Realm',
      capital_place_id: places.ficengwind,
      county_ids: [stored.counties[2]!.id],
    });
    expect(stored.counties[0]).toMatchObject({
      realm_id: stored.realms[0]!.id,
      name: 'North March',
      seat_place_id: places.redham,
      hexes: ['q6_r8', 'q5_r8'],
    });
    expect(stored.counties[2]).toMatchObject({
      realm_id: stored.realms[1]!.id,
      name: 'Fen County',
      hexes: ['q4_r11', 'q3_r11'],
    });

    expect(getPolitics(db, campaignId)).toEqual(stored);
  });

  it('replaces everything on a second save', () => {
    const campaignId = newCampaign();
    const places = importSafe(campaignId);
    savePolitics(db, campaignId, twoRealms(places));

    const replaced = savePolitics(db, campaignId, {
      realms: [{ name: 'Solo Realm', capital_place_id: null }],
      counties: [{ name: 'Only County', seat_place_id: places.redham, realm: 0, hexes: ['q1_r1'] }],
    });

    expect(replaced.realms).toHaveLength(1);
    expect(replaced.realms[0]).toMatchObject({ name: 'Solo Realm', capital_place_id: null });
    expect(replaced.counties).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_realm WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_county WHERE campaign_id = ?').get(campaignId)).toEqual({
      n: 1,
    });
  });

  it('refuses an out-of-range realm index and leaves the previous politics untouched', () => {
    const campaignId = newCampaign();
    const places = importSafe(campaignId);
    const before = savePolitics(db, campaignId, twoRealms(places));

    expect(() =>
      savePolitics(db, campaignId, {
        realms: [{ name: 'Lonely Realm', capital_place_id: null }],
        counties: [{ name: 'Broken County', seat_place_id: places.redham, realm: 5, hexes: [] }],
      }),
    ).toThrow('County "Broken County" names realm 5, which does not exist.');

    expect(getPolitics(db, campaignId)).toEqual(before);
  });

  it('returns null for a campaign with no politics', () => {
    expect(getPolitics(db, newCampaign())).toBeNull();
  });
});

describe('importRegion replace', () => {
  it('clears saved politics so the swap is not blocked and leaves none behind', () => {
    const campaignId = newCampaign();
    const places = importSafe(campaignId);
    savePolitics(db, campaignId, twoRealms(places));

    expect(() => importRegion(db, campaignId, dangerous, { source: 'uploaded', replace: true })).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_realm WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_county WHERE campaign_id = ?').get(campaignId)).toEqual({
      n: 0,
    });
  });
});
