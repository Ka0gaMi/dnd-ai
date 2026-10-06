// Control's speed-ups change nothing: one movement graph serves every seat with the same costs, and a
// derived control map is reused only while everything it was derived from is unchanged.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { buildMovement, travelCosts, travelCostsOn } from '../src/core/politics-counties.js';
import { politicsInputFromDb } from '../src/core/politics-input.js';
import { controlMap, ensurePolitics, type PlaceControl } from '../src/core/politics-service.js';
import { computeHierarchyParts } from '../src/core/politics.js';
import { importRegion } from '../src/core/region.js';
import { transferCounty } from '../src/core/world-place-state.js';
import { openDb, type Db } from '../src/db/connection.js';

const FIXTURES = ['large', 'medium', 'safe', 'dangerous'] as const;
type Fixture = (typeof FIXTURES)[number];

/** sha256 of each fixture's bounded counties and control map at 279f3d7, before the shared graph and the cache. */
const BEFORE: Record<Fixture, { bounded: string; control: string }> = {
  large: {
    bounded: '68ca47678794c91d70e54d617663313e5d19a98945999eb21086e71930fec0e2',
    control: 'ca656b814248dec3e6b808fed800925d30fd835cf100fa41a924c068060e636d',
  },
  medium: {
    bounded: '3958a921a12b9da9237a91bdbcf16a69e7dcba2bdefa6081d89ee436a10e2c8e',
    control: '3fd392ce2a965e7db338169c952424022edb7d76b2ed5f6c494abd8fe60c672e',
  },
  safe: {
    bounded: '80d6f7e7be3262a454a36a13c648d118f18d9f1dc6d3058863316b19c92d3fe2',
    control: '97f35bc305d97a4d596cc62717286f3aea7548d557886dd8d1410088c05d1b9a',
  },
  dangerous: {
    bounded: '858179ddc16a49d133d05c85855cba7e6f7fee36eaa7f879c544de361577679c',
    control: 'c6b8a9c7e4beb4bf477595a9add6a14b80b22aebfdd3aeb9038945143a85a0ab',
  },
};

const fixture = (name: Fixture): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/realm-${name}.json`, import.meta.url), 'utf8')) as unknown;

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A database of its own, so nothing has been derived or cached for it yet. */
function campaignOn(region: unknown, name: string): { db: Db; campaignId: number } {
  const db = openDb(':memory:');
  const campaignId = createCampaign(db, { name: `Control ${name}`, story_shape: 'structured' }).campaign_id;
  importRegion(db, campaignId, region, { source: 'generated' });
  return { db, campaignId };
}

/** Band and control per hex, without the stored ids that a re-import renumbers. */
const strip = (map: Map<string, PlaceControl>): Array<[string, string, number]> =>
  [...map].map(([hex, entry]) => [hex, entry.band, entry.control]);

describe.each(FIXTURES)('control on realm-%s after the speed-up', (name) => {
  it('costs every seat the same on one shared graph as on a graph of its own', () => {
    const { db, campaignId } = campaignOn(fixture(name), name);
    const input = politicsInputFromDb(db, campaignId)!;
    const move = buildMovement(input);

    expect(input.settlements.length).toBeGreaterThan(0);
    for (const place of input.settlements) {
      expect([...travelCostsOn(move, place.hex, 1)]).toEqual([...travelCosts(input, place.hex, 1)]);
    }
  });

  it('keeps the bounded counties and the control map byte-for-byte as before', () => {
    const { db, campaignId } = campaignOn(fixture(name), name);
    const parts = computeHierarchyParts(politicsInputFromDb(db, campaignId)!);

    expect(digest(parts.counties.counties.map((county) => [county.seat_place_id, county.hexes]))).toBe(
      BEFORE[name].bounded,
    );
    expect(digest([...controlMap(db, campaignId)!])).toBe(BEFORE[name].control);
    expect(digest([...controlMap(db, campaignId)!])).toBe(BEFORE[name].control);
  });
});

describe('the cached control map', () => {
  it('reuses one derivation while nothing it reads has changed', () => {
    const { db, campaignId } = campaignOn(fixture('large'), 'large');
    const first = controlMap(db, campaignId)!;
    const second = controlMap(db, campaignId)!;

    expect(second).not.toBe(first);
    expect([...second].every(([hex, entry]) => first.get(hex) === entry)).toBe(true);
    expect([...second.values()].every((entry) => Object.isFrozen(entry))).toBe(true);
    first.clear();
    expect(controlMap(db, campaignId)!.size).toBe(second.size);
  });

  it('never serves a stale map after a county changes hands', () => {
    const transfer = (db: Db, campaignId: number): number => {
      const politics = ensurePolitics(db, campaignId)!;
      const county = politics.counties.find((entry) => entry.name === 'County of Northern Point')!;
      const darkforge = politics.realms.find((realm) => realm.name === 'Kingdom of Darkforge')!;
      expect(county.realm_id).not.toBe(darkforge.id);
      transferCounty(db, campaignId, county.id, darkforge.id);
      return darkforge.id;
    };
    const { db, campaignId } = campaignOn(fixture('large'), 'large');
    const before = controlMap(db, campaignId)!;
    const darkforge = transfer(db, campaignId);
    const after = controlMap(db, campaignId)!;

    const claim = ensurePolitics(db, campaignId)!.counties.find((entry) => entry.name === 'County of Northern Point')!
      .claim_hexes!;
    expect(claim.some((hex) => before.get(hex)!.realm_id === darkforge)).toBe(false);
    expect(claim.every((hex) => after.get(hex)!.realm_id === darkforge)).toBe(true);

    const fresh = campaignOn(fixture('large'), 'large');
    transfer(fresh.db, fresh.campaignId);
    expect([...after]).toEqual([...controlMap(fresh.db, fresh.campaignId)!]);
  });

  it('never serves a stale map after the claims change', () => {
    const dropClaims = (db: Db, campaignId: number): void => {
      ensurePolitics(db, campaignId);
      db.prepare('DELETE FROM world_claim WHERE campaign_id = ?').run(campaignId);
    };
    const { db, campaignId } = campaignOn(fixture('large'), 'large');
    const before = controlMap(db, campaignId)!;
    dropClaims(db, campaignId);
    const after = controlMap(db, campaignId)!;

    expect(digest([...after])).not.toBe(digest([...before]));
    const fresh = campaignOn(fixture('large'), 'large');
    dropClaims(fresh.db, fresh.campaignId);
    expect([...after]).toEqual([...controlMap(fresh.db, fresh.campaignId)!]);
  });

  it('never serves a stale map after the region is re-imported', () => {
    const { db, campaignId } = campaignOn(fixture('safe'), 'safe');
    const safe = controlMap(db, campaignId)!;

    importRegion(db, campaignId, fixture('dangerous'), { source: 'generated', replace: true });
    const dangerous = controlMap(db, campaignId)!;
    expect(strip(dangerous)).not.toEqual(strip(safe));
    const fresh = campaignOn(fixture('dangerous'), 'dangerous');
    expect(strip(dangerous)).toEqual(strip(controlMap(fresh.db, fresh.campaignId)!));
  });

  it('never serves a stale map when only the region changes under the same counties', () => {
    // The stored counties keep their ids, so only the region part of the key can notice the wild tag.
    const wilden = (db: Db, campaignId: number): void => {
      ensurePolitics(db, campaignId);
      db.prepare(`UPDATE world_region SET tags_json = '["wild"]' WHERE campaign_id = ?`).run(campaignId);
    };
    const { db, campaignId } = campaignOn(fixture('safe'), 'safe');
    const before = controlMap(db, campaignId)!;
    wilden(db, campaignId);
    const after = controlMap(db, campaignId)!;

    expect(strip(after)).not.toEqual(strip(before));
    const fresh = campaignOn(fixture('safe'), 'safe');
    wilden(fresh.db, fresh.campaignId);
    expect([...after]).toEqual([...controlMap(fresh.db, fresh.campaignId)!]);
  });
});
