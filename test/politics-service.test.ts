import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { getPolitics, savePolitics } from '../src/core/politics-store.js';
import { ensurePolitics, placePolitics } from '../src/core/politics-service.js';
import { findPlace, getRegion, importRegion, type WorldPlace } from '../src/core/region.js';
import { openDb, type Db } from '../src/db/connection.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

const safe = fixture('realm-safe.json');
const dangerous = fixture('realm-dangerous.json');
const large = fixture('realm-large.json');

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(name = 'The Ashfall Road'): number {
  return createCampaign(db, { name, story_shape: 'structured' }).campaign_id;
}

function counts(campaignId: number): { realms: number; counties: number; duchies: number } {
  const row = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE campaign_id = ?`).get(campaignId) as { n: number }).n;
  return { realms: row('world_realm'), counties: row('world_county'), duchies: row('world_duchy') };
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
  it('returns null and placePolitics answers with no county, realm, duchy or march', () => {
    const campaignId = newCampaign();

    expect(ensurePolitics(db, campaignId)).toBeNull();
    expect(placePolitics(db, campaignId, stray)).toEqual({ county: null, realm: null, duchy: null, march: false });
  });
});

describe('ensurePolitics on the large realm', () => {
  it('grows fewer realms than the nine cities, with a duchy-bearing realm of four or more counties', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, large, { source: 'generated' });

    const first = ensurePolitics(db, campaignId)!;
    expect(first.realms.length).toBeGreaterThan(0);
    expect(first.realms.length).toBeLessThan(9);

    const countiesPerRealm = new Map<number, number>();
    for (const county of first.counties) {
      countiesPerRealm.set(county.realm_id, (countiesPerRealm.get(county.realm_id) ?? 0) + 1);
    }
    const bigRealmIds = [...countiesPerRealm.entries()].filter(([, count]) => count >= 4).map(([realm]) => realm);
    expect(bigRealmIds.length).toBeGreaterThan(0);
    expect(first.duchies.some((duchy) => bigRealmIds.includes(duchy.realm_id))).toBe(true);
  });

  it('reuses the stored division on a second call without writing again', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, large, { source: 'generated' });

    const first = ensurePolitics(db, campaignId)!;
    const before = counts(campaignId);
    const second = ensurePolitics(db, campaignId)!;

    expect(second.realms.map((realm) => realm.id)).toEqual(first.realms.map((realm) => realm.id));
    expect(second.counties.map((county) => county.id)).toEqual(first.counties.map((county) => county.id));
    expect(second.duchies.map((duchy) => duchy.id)).toEqual(first.duchies.map((duchy) => duchy.id));
    expect(counts(campaignId)).toEqual(before);
  });

  it('answers the county, realm, duchy and march of a county seat', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, large, { source: 'generated' });

    const az = placePolitics(db, campaignId, findPlace(db, campaignId, 'Az')!);
    expect(az.county?.name).toBe('County of Az');
    expect(az.realm?.name).toBe('Kingdom of Darkforge');
    expect(az.duchy).toMatchObject({ name: 'Crownlands of Darkforge', demesne: true });
    expect(az.march).toBe(true);

    // The crown's own seat sits in a duchy but is no march.
    const delin = placePolitics(db, campaignId, findPlace(db, campaignId, 'Delin')!);
    expect(delin.duchy?.name).toBe('Crownlands of Darkforge');
    expect(delin.march).toBe(false);

    // The balanced split leaves one city outside the kingdom, as a sovereign free city with no duchy.
    const suncore = placePolitics(db, campaignId, findPlace(db, campaignId, 'Suncore')!);
    expect(suncore.realm?.name).toBe('Free City of Suncore');
    expect(suncore.duchy).toBeNull();
    expect(suncore.march).toBe(false);
  });

  it('balances the counties: no realm exceeds its share and every kingdom holds three or more', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, large, { source: 'generated' });
    const politics = ensurePolitics(db, campaignId)!;

    const countiesPerRealm = new Map<number, number>();
    for (const county of politics.counties) {
      countiesPerRealm.set(county.realm_id, (countiesPerRealm.get(county.realm_id) ?? 0) + 1);
    }
    // This fixture is one land component grown from three capitals, so the share is ceil(25 / 3 × 1.6).
    const seeded = politics.realms.filter(
      (realm) => realm.kind === 'kingdom' || realm.name.startsWith('Principality of '),
    );
    expect(seeded).toHaveLength(3);
    const cap = Math.ceil((politics.counties.length / seeded.length) * 1.6);
    for (const realm of politics.realms) {
      expect(countiesPerRealm.get(realm.id) ?? 0).toBeLessThanOrEqual(cap);
    }

    const kingdoms = politics.realms.filter((realm) => realm.kind === 'kingdom');
    expect(kingdoms.length).toBeGreaterThan(0);
    for (const kingdom of kingdoms) {
      expect(countiesPerRealm.get(kingdom.id) ?? 0).toBeGreaterThanOrEqual(3);
    }

    const largest = [...politics.realms].sort(
      (a, b) => (countiesPerRealm.get(b.id) ?? 0) - (countiesPerRealm.get(a.id) ?? 0),
    )[0]!;
    expect(politics.duchies.some((duchy) => duchy.realm_id === largest.id)).toBe(true);

    const small = politics.realms.filter((realm) => realm.kind === 'lordship');
    expect(small.length).toBeGreaterThan(0);
    expect(small.filter((realm) => realm.liege_realm_id !== null).length).toBeGreaterThanOrEqual(
      Math.ceil(small.length / 2),
    );
  });

  it('recomputes the same realm table for the same fixture', () => {
    const first = newCampaign('First');
    const second = newCampaign('Second');
    importRegion(db, first, large, { source: 'generated' });
    importRegion(db, second, large, { source: 'generated' });
    // Row ids are global across campaigns, so the liege is compared by realm name instead.
    const table = (campaignId: number): string[] => {
      const politics = ensurePolitics(db, campaignId)!;
      const nameOf = new Map(politics.realms.map((realm) => [realm.id, realm.name]));
      return politics.realms.map(
        (realm) =>
          `${realm.name}|${realm.kind}|${realm.county_ids.length}|${realm.liege_realm_id === null ? '-' : nameOf.get(realm.liege_realm_id)}`,
      );
    };
    expect(table(first)).toEqual(table(second));
  });
});

describe('ensurePolitics on the safe realm', () => {
  it('grows three counties under one kingdom and reports no duchies', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });

    const first = ensurePolitics(db, campaignId)!;
    expect(first.counties.map((county) => county.name)).toEqual([
      'County of Redham',
      'County of Ficengwind',
      'Lordship of Southern Landing',
    ]);
    expect(first.realms.map((realm) => realm.name)).toEqual(['Kingdom of Ficengwind']);
    expect(first.duchies).toEqual([]);
    expect(counts(campaignId)).toEqual({ realms: 1, counties: 3, duchies: 0 });
  });

  it('places a village in its county and kingdom, with the capital named and no duchy', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });

    expect(placePolitics(db, campaignId, findPlace(db, campaignId, 'Stormcourtby')!)).toEqual({
      county: { id: expect.any(Number), name: 'County of Redham' },
      realm: {
        id: expect.any(Number),
        name: 'Kingdom of Ficengwind',
        capital: 'Ficengwind',
        government: null,
        off_map: false,
      },
      duchy: null,
      march: false,
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
    expect(fresh.realms.map((realm) => realm.name)).toEqual(['Lordship of Crimson Wharf']);
    expect(fresh.realms.map((realm) => realm.id)).not.toEqual(old.realms.map((realm) => realm.id));
  });
});

describe('ensurePolitics on the dangerous realm', () => {
  it('folds the whole island into one castle lordship', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, dangerous, { source: 'uploaded' });

    const division = ensurePolitics(db, campaignId)!;
    expect(division.realms).toHaveLength(1);
    expect(division.realms[0]).toMatchObject({ name: 'Lordship of Crimson Wharf', capital_place_id: expect.any(Number) });

    const frostcot = placePolitics(db, campaignId, findPlace(db, campaignId, 'Frostcot')!);
    expect(frostcot).toEqual({
      county: { id: expect.any(Number), name: 'Lordship of Crimson Wharf' },
      realm: {
        id: expect.any(Number),
        name: 'Lordship of Crimson Wharf',
        capital: 'Crimson Wharf',
        government: null,
        off_map: false,
      },
      duchy: null,
      march: false,
    });
  });

  it('seats no county at a danger place and keeps danger names out of every realm and county', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, dangerous, { source: 'uploaded' });
    const politics = ensurePolitics(db, campaignId)!;

    const dangers = getRegion(db, campaignId)!.places.filter((place) => place.kind === 'danger');
    expect(dangers.map((place) => place.name)).toContain('Hidden Keep');
    const dangerIds = new Set(dangers.map((place) => place.id));

    for (const county of politics.counties) {
      expect(dangerIds.has(county.seat_place_id)).toBe(false);
      for (const danger of dangers) expect(county.name).not.toContain(danger.name);
    }
    for (const realm of politics.realms) {
      for (const danger of dangers) expect(realm.name).not.toContain(danger.name);
    }
  });
});

describe('ensurePolitics once the world exists', () => {
  it('returns null and writes no politics when world_state exists but none is stored', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });
    db.prepare('INSERT INTO world_state (campaign_id, seed, last_tick_day, quiet_until_day) VALUES (?, ?, ?, ?)').run(
      campaignId,
      1,
      0,
      0,
    );

    expect(ensurePolitics(db, campaignId)).toBeNull();
    expect(counts(campaignId)).toEqual({ realms: 0, counties: 0, duchies: 0 });
  });
});

describe('placePolitics seat fallback', () => {
  it('uses the county seated at a settlement when no county holds its hex', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });
    const redham = findPlace(db, campaignId, 'Redham')!;
    savePolitics(db, campaignId, {
      realms: [{ name: 'Synthetic Realm', capital_place_id: null }],
      counties: [{ name: 'Far County', seat_place_id: redham.id, realm: 0, hexes: ['q99_r99'] }],
    });

    expect(placePolitics(db, campaignId, redham)).toEqual({
      county: { id: expect.any(Number), name: 'Far County' },
      realm: { id: expect.any(Number), name: 'Synthetic Realm', capital: null, government: null, off_map: false },
      duchy: null,
      march: false,
    });
  });
});
