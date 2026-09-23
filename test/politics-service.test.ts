import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { getPolitics } from '../src/core/politics-store.js';
import { ensurePolitics, placePolitics } from '../src/core/politics-service.js';
import { findPlace, importRegion, type WorldPlace } from '../src/core/region.js';
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

function counts(campaignId: number): { realms: number; counties: number } {
  const realms = db.prepare('SELECT COUNT(*) AS n FROM world_realm WHERE campaign_id = ?').get(campaignId) as {
    n: number;
  };
  const counties = db.prepare('SELECT COUNT(*) AS n FROM world_county WHERE campaign_id = ?').get(campaignId) as {
    n: number;
  };
  return { realms: realms.n, counties: counties.n };
}

const stray: WorldPlace = {
  id: 1,
  kind: 'settlement',
  name: 'Nowhere',
  q: 0,
  r: 0,
  hexes: ['q0_r0'],
  tags: {},
  info: '',
  link: null,
  seed: null,
  known_to_party: false,
  entity_id: null,
};

describe('ensurePolitics without a region', () => {
  it('returns null and placePolitics answers with no county or realm', () => {
    const campaignId = newCampaign();

    expect(ensurePolitics(db, campaignId)).toBeNull();
    expect(placePolitics(db, campaignId, stray)).toEqual({ county: null, realm: null });
  });
});

describe('ensurePolitics on the safe realm', () => {
  it('computes the division once and reuses the stored one', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });

    const first = ensurePolitics(db, campaignId)!;
    expect(first.counties.map((county) => county.name)).toEqual(['County of Redham', 'County of Ficengwind']);
    expect(first.realms.map((realm) => realm.name)).toEqual(['Kingdom of Ficengwind']);
    expect(counts(campaignId)).toEqual({ realms: 1, counties: 2 });

    const before = counts(campaignId);
    const second = ensurePolitics(db, campaignId)!;
    expect(second.realms.map((realm) => realm.id)).toEqual(first.realms.map((realm) => realm.id));
    expect(second.counties.map((county) => county.id)).toEqual(first.counties.map((county) => county.id));
    expect(counts(campaignId)).toEqual(before);
  });

  it('places a village in its county and kingdom, with the capital named', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });

    const stormcourtby = findPlace(db, campaignId, 'Stormcourtby')!;
    expect(placePolitics(db, campaignId, stormcourtby)).toEqual({
      county: { id: expect.any(Number), name: 'County of Redham' },
      realm: { id: expect.any(Number), name: 'Kingdom of Ficengwind', capital: 'Ficengwind' },
    });

    const hotfield = findPlace(db, campaignId, 'Hotfield')!;
    expect(placePolitics(db, campaignId, hotfield).county).toEqual({
      id: expect.any(Number),
      name: 'County of Ficengwind',
    });
  });
});

describe('ensurePolitics on the dangerous realm', () => {
  it('names the realm after the region with no capital', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, dangerous, { source: 'uploaded' });

    const division = ensurePolitics(db, campaignId)!;
    expect(division.realms).toHaveLength(1);
    expect(division.realms[0]).toMatchObject({ name: 'Ta Isle', capital_place_id: null });

    const frostcot = findPlace(db, campaignId, 'Frostcot')!;
    expect(placePolitics(db, campaignId, frostcot)).toEqual({
      county: { id: expect.any(Number), name: 'County of Frostcot' },
      realm: { id: expect.any(Number), name: 'Ta Isle', capital: null },
    });
  });
});

describe('ensurePolitics after a region replace', () => {
  it('drops the old division and recomputes for the new region', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });
    const old = ensurePolitics(db, campaignId)!;

    importRegion(db, campaignId, dangerous, { source: 'uploaded', replace: true });
    expect(getPolitics(db, campaignId)).toBeNull();

    const fresh = ensurePolitics(db, campaignId)!;
    expect(fresh.realms.map((realm) => realm.name)).toEqual(['Ta Isle']);
    expect(fresh.realms.map((realm) => realm.id)).not.toEqual(old.realms.map((realm) => realm.id));
  });
});
