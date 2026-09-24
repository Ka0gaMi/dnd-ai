import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { getPolitics, saveHierarchy, savePolitics } from '../src/core/politics-store.js';
import type { ComputedCounties, ComputedHierarchy, ComputedRealms } from '../src/core/politics-types.js';
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

function importSafe(campaignId: number): {
  redham: number;
  ficengwind: number;
  stormcourtby: number;
  hotfield: number;
  southernLanding: number;
} {
  importRegion(db, campaignId, safe, { source: 'generated' });
  return {
    redham: findPlace(db, campaignId, 'Redham')!.id,
    ficengwind: findPlace(db, campaignId, 'Ficengwind')!.id,
    stormcourtby: findPlace(db, campaignId, 'Stormcourtby')!.id,
    hotfield: findPlace(db, campaignId, 'Hotfield')!.id,
    southernLanding: findPlace(db, campaignId, 'Southern Landing')!.id,
  };
}

/** A handcrafted hierarchy: a kingdom, its vassal lordship, an off-map free city, duchies and claims. */
function handcrafted(places: {
  redham: number;
  ficengwind: number;
  stormcourtby: number;
  hotfield: number;
  southernLanding: number;
}): { counties: ComputedCounties; realms: ComputedRealms; hierarchy: ComputedHierarchy } {
  const counties: ComputedCounties = {
    counties: [
      {
        name: 'County of Redham',
        seat_place_id: places.redham,
        seat_kind: 'town',
        hexes: ['q6_r8', 'q5_r8'],
        village_place_ids: [places.stormcourtby],
        component: 0,
      },
      {
        name: 'County of Ficengwind',
        seat_place_id: places.ficengwind,
        seat_kind: 'city',
        hexes: ['q4_r11'],
        village_place_ids: [places.hotfield],
        component: 0,
      },
      {
        name: 'Fen March',
        seat_place_id: places.southernLanding,
        seat_kind: 'castle',
        hexes: ['q11_r14'],
        village_place_ids: [],
        component: 0,
      },
    ],
    edges: [],
  };

  const realms: ComputedRealms = {
    realms: [
      { name: 'Kingdom of Ficengwind', kind: 'kingdom', capital_place_id: places.ficengwind, off_map: false, liege: null },
      { name: 'Lordship of Redham', kind: 'lordship', capital_place_id: places.redham, off_map: false, liege: 0 },
      { name: 'Free City of Hotfield', kind: 'free_city', capital_place_id: places.hotfield, off_map: true, liege: null },
    ],
    county_realm: [1, 0, 1],
  };

  const hierarchy: ComputedHierarchy = {
    duchies: [
      {
        name: 'Redham Demesne',
        realm: 1,
        seat_place_id: places.redham,
        county_indexes: [0],
        demesne: true,
        joined_how: 'core',
      },
      {
        name: 'Fen March',
        realm: 1,
        seat_place_id: places.southernLanding,
        county_indexes: [2],
        demesne: false,
        joined_how: 'conquest',
      },
    ],
    county_duchy: [0, null, 1],
    march_counties: [2],
    claims: [
      { county: 2, claimant_realm: 0, strength: 'strong', reason: 'ancient kingdom' },
      { county: 1, claimant_realm: 2, strength: 'weak', reason: 'dowry' },
    ],
  };

  return { counties, realms, hierarchy };
}

describe('migration 030', () => {
  it('adds the hierarchy columns and tables', () => {
    expect(db.prepare("SELECT name FROM schema_migration WHERE name = '030_political_hierarchy.sql'").get()).toBeDefined();

    const realmColumns = (db.prepare('PRAGMA table_info(world_realm)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(realmColumns).toEqual(expect.arrayContaining(['kind', 'off_map', 'liege_realm_id']));

    const countyColumns = (db.prepare('PRAGMA table_info(world_county)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(countyColumns).toEqual(
      expect.arrayContaining(['seat_kind', 'duchy_id', 'is_march', 'village_ids_json']),
    );

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (table) => table.name,
    );
    expect(tables).toEqual(expect.arrayContaining(['world_duchy', 'world_claim']));
  });
});

describe('saveHierarchy', () => {
  it('round-trips realms, duchies, counties and claims through getPolitics', () => {
    const campaignId = newCampaign();
    const places = importSafe(campaignId);

    const stored = saveHierarchy(db, campaignId, handcrafted(places));
    expect(getPolitics(db, campaignId)).toEqual(stored);

    expect(stored.realms).toHaveLength(3);
    const kingdom = stored.realms.find((realm) => realm.name === 'Kingdom of Ficengwind')!;
    const lordship = stored.realms.find((realm) => realm.name === 'Lordship of Redham')!;
    const freeCity = stored.realms.find((realm) => realm.name === 'Free City of Hotfield')!;
    expect(kingdom).toMatchObject({ kind: 'kingdom', off_map: false, liege_realm_id: null });
    expect(lordship).toMatchObject({ kind: 'lordship', off_map: false, liege_realm_id: kingdom.id });
    expect(freeCity).toMatchObject({ kind: 'free_city', off_map: true, liege_realm_id: null });
    expect(kingdom.county_ids).toEqual([stored.counties[1]!.id]);
    expect(lordship.county_ids).toEqual([stored.counties[0]!.id, stored.counties[2]!.id]);

    const redham = stored.counties.find((county) => county.name === 'County of Redham')!;
    expect(redham).toMatchObject({
      realm_id: lordship.id,
      seat_kind: 'town',
      is_march: false,
      village_place_ids: [places.stormcourtby],
    });
    const march = stored.counties.find((county) => county.name === 'Fen March')!;
    expect(march).toMatchObject({ seat_kind: 'castle', is_march: true, village_place_ids: [] });

    expect(stored.duchies).toHaveLength(2);
    const demesne = stored.duchies.find((duchy) => duchy.name === 'Redham Demesne')!;
    const fen = stored.duchies.find((duchy) => duchy.name === 'Fen March')!;
    expect(demesne).toMatchObject({
      realm_id: lordship.id,
      seat_place_id: places.redham,
      demesne: true,
      joined_how: 'core',
    });
    expect(demesne.county_ids).toEqual([redham.id]);
    expect(fen).toMatchObject({ demesne: false, joined_how: 'conquest', county_ids: [march.id] });
    expect(redham.duchy_id).toBe(demesne.id);
    expect(march.duchy_id).toBe(fen.id);

    expect(stored.claims).toHaveLength(2);
    expect(stored.claims).toEqual(
      expect.arrayContaining([
        { county_id: march.id, claimant_realm_id: kingdom.id, strength: 'strong', reason: 'ancient kingdom' },
        { county_id: stored.counties[1]!.id, claimant_realm_id: freeCity.id, strength: 'weak', reason: 'dowry' },
      ]),
    );
  });

  it('replaces the previous hierarchy instead of accumulating rows', () => {
    const campaignId = newCampaign();
    const places = importSafe(campaignId);
    saveHierarchy(db, campaignId, handcrafted(places));

    const replaced = saveHierarchy(db, campaignId, {
      counties: {
        counties: [
          {
            name: 'Only County',
            seat_place_id: places.redham,
            seat_kind: 'castle',
            hexes: ['q6_r8'],
            village_place_ids: [],
            component: 0,
          },
        ],
        edges: [],
      },
      realms: {
        realms: [
          { name: 'Solo Realm', kind: 'tribe', capital_place_id: null, off_map: false, liege: null },
        ],
        county_realm: [0],
      },
      hierarchy: { duchies: [], county_duchy: [null], march_counties: [], claims: [] },
    });

    expect(replaced.realms).toHaveLength(1);
    expect(replaced.counties).toHaveLength(1);
    expect(replaced.duchies).toEqual([]);
    expect(replaced.claims).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_realm WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_county WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_duchy WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_claim WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 0 });
  });

  it('refuses to recompute once the living world has started', () => {
    const campaignId = newCampaign();
    const places = importSafe(campaignId);
    db.prepare('INSERT INTO world_state (campaign_id, seed, last_tick_day, quiet_until_day) VALUES (?, ?, ?, ?)').run(
      campaignId,
      7,
      1,
      0,
    );

    expect(() => saveHierarchy(db, campaignId, handcrafted(places))).toThrow(
      'Politics cannot be recomputed after the living world has started.',
    );
    expect(getPolitics(db, campaignId)).toBeNull();
  });
});

describe('importRegion replace after saveHierarchy', () => {
  it('clears the hierarchy child-first with no foreign-key failure', () => {
    const campaignId = newCampaign();
    const places = importSafe(campaignId);
    saveHierarchy(db, campaignId, handcrafted(places));

    expect(() => importRegion(db, campaignId, dangerous, { source: 'uploaded', replace: true })).not.toThrow();
    expect(getPolitics(db, campaignId)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_duchy WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_claim WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 0 });
  });
});

describe('savePolitics on old-style input', () => {
  it('still stores realms and counties and reads back the new columns as defaults', () => {
    const campaignId = newCampaign();
    const places = importSafe(campaignId);

    const stored = savePolitics(db, campaignId, {
      realms: [{ name: 'Old Realm', capital_place_id: places.redham }],
      counties: [{ name: 'Old County', seat_place_id: places.redham, realm: 0, hexes: ['q6_r8'] }],
    });

    expect(stored.realms[0]).toMatchObject({ kind: 'kingdom', off_map: false, liege_realm_id: null });
    expect(stored.counties[0]).toMatchObject({
      seat_kind: 'town',
      duchy_id: null,
      is_march: false,
      village_place_ids: [],
    });
    expect(stored.duchies).toEqual([]);
    expect(stored.claims).toEqual([]);
    expect(getPolitics(db, campaignId)).toEqual(stored);
  });
});
