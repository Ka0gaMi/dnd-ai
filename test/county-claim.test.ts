// A county's legal claim (catchment) is stored apart from the hexes it holds; world-seed's county
// adjacency reads the claim, so a shrunken county still borders what it legally claims.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import type { ComputedCounties, ComputedHierarchy, ComputedRealms } from '../src/core/politics-types.js';
import { getPolitics, saveHierarchy, type StoredPolitics } from '../src/core/politics-store.js';
import { findPlace, importRegion } from '../src/core/region.js';
import { borderingCountyIds } from '../src/core/world-seed.js';
import { openDb, type Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(): number {
  return createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
}

/** One realm holding one county seated at Redham, with the given held hexes and optional catchment. */
function oneCounty(
  seatPlaceId: number,
  hexes: string[],
  catchment?: string[],
): { counties: ComputedCounties; realms: ComputedRealms; hierarchy: ComputedHierarchy } {
  return {
    counties: {
      counties: [
        {
          name: 'County of the Line',
          seat_place_id: seatPlaceId,
          seat_kind: 'town',
          hexes,
          ...(catchment === undefined ? {} : { catchment }),
          village_place_ids: [],
          component: 0,
        },
      ],
      edges: [],
    },
    realms: {
      realms: [
        { name: 'Kingdom of the Line', kind: 'kingdom', capital_place_id: seatPlaceId, off_map: false, liege: null },
      ],
      county_realm: [0],
    },
    hierarchy: { duchies: [], county_duchy: [null], march_counties: [], claims: [] },
  };
}

describe('migration 034_county_claim_hexes', () => {
  it('adds the claim_hexes_json column to world_county', () => {
    expect(
      db.prepare("SELECT name FROM schema_migration WHERE name = '034_county_claim_hexes.sql'").get(),
    ).toBeDefined();
    const columns = (db.prepare('PRAGMA table_info(world_county)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(columns).toContain('claim_hexes_json');
  });
});

describe('saveHierarchy stores the legal claim', () => {
  function importRedham(campaignId: number): number {
    importRegion(db, campaignId, safe, { source: 'generated' });
    return findPlace(db, campaignId, 'Redham')!.id;
  }

  it('stores the catchment when one is given, apart from the held hexes', () => {
    const campaignId = newCampaign();
    const redham = importRedham(campaignId);

    const stored = saveHierarchy(db, campaignId, oneCounty(redham, ['q6_r8'], ['q6_r8', 'q5_r8']));

    expect(stored.counties[0]).toMatchObject({ hexes: ['q6_r8'], claim_hexes: ['q6_r8', 'q5_r8'] });
    const row = db
      .prepare('SELECT claim_hexes_json FROM world_county WHERE campaign_id = ?')
      .get(campaignId) as { claim_hexes_json: string };
    expect(row.claim_hexes_json).toBe(JSON.stringify(['q6_r8', 'q5_r8']));
  });

  it('stores the held hexes as the claim when no catchment is given', () => {
    const campaignId = newCampaign();
    const redham = importRedham(campaignId);

    saveHierarchy(db, campaignId, oneCounty(redham, ['q6_r8', 'q5_r8']));

    const row = db
      .prepare('SELECT claim_hexes_json FROM world_county WHERE campaign_id = ?')
      .get(campaignId) as { claim_hexes_json: string };
    expect(row.claim_hexes_json).toBe(JSON.stringify(['q6_r8', 'q5_r8']));
    expect(getPolitics(db, campaignId)!.counties[0]!.claim_hexes).toEqual(['q6_r8', 'q5_r8']);
  });

  it('reads no claim when the stored column is null, leaving the held hexes', () => {
    const campaignId = newCampaign();
    const redham = importRedham(campaignId);
    saveHierarchy(db, campaignId, oneCounty(redham, ['q6_r8'], ['q6_r8', 'q5_r8']));

    db.prepare('UPDATE world_county SET claim_hexes_json = NULL WHERE campaign_id = ?').run(campaignId);

    const county = getPolitics(db, campaignId)!.counties[0]!;
    expect(county.hexes).toEqual(['q6_r8']);
    expect(county.claim_hexes).toBeUndefined();
  });
});

describe('county adjacency reads the legal claim', () => {
  /** A county holding only its seat hex but claiming one more hex toward its neighbour. */
  function twoCounties(claim: string[] | undefined): StoredPolitics {
    return {
      realms: [],
      counties: [
        {
          id: 1,
          realm_id: 1,
          name: 'Shrunken County',
          seat_place_id: 1,
          hexes: ['q0_r0'],
          ...(claim === undefined ? {} : { claim_hexes: claim }),
          seat_kind: 'town',
          duchy_id: null,
          is_march: false,
          village_place_ids: [],
        },
        {
          id: 2,
          realm_id: 1,
          name: 'Neighbour County',
          seat_place_id: 2,
          hexes: ['q0_r2'],
          seat_kind: 'town',
          duchy_id: null,
          is_march: false,
          village_place_ids: [],
        },
      ],
      duchies: [],
      claims: [],
    };
  }

  it('counts a county bordering when only the claim reaches the neighbour', () => {
    const politics = twoCounties(['q0_r0', 'q0_r1']);

    expect(borderingCountyIds(politics, [politics.counties[0]!])).toEqual(new Set([2]));
  });

  it('does not count the neighbour when the claim equals the held hexes', () => {
    const politics = twoCounties(undefined);

    expect(borderingCountyIds(politics, [politics.counties[0]!])).toEqual(new Set());
  });
});
