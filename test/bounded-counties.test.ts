// Bounded counties: a county holds only the land its realm's seats really control, its legal claim is
// kept apart, and control bands are derived on read for the DM, including for campaigns stored before claims.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { computeCounties } from '../src/core/politics-counties.js';
import { computeHierarchy } from '../src/core/politics-duchies.js';
import { politicsInputFromDb } from '../src/core/politics-input.js';
import { computeRealms } from '../src/core/politics-realms.js';
import { controlMap, ensurePolitics, placeControl, placePolitics, type PlaceControl } from '../src/core/politics-service.js';
import { getPolitics, regionHexes, type StoredPolitics } from '../src/core/politics-store.js';
import { computeHierarchyParts, hexNeighbours } from '../src/core/politics.js';
import { findPlace, getRegion, importRegion } from '../src/core/region.js';
import { playerRegionMap } from '../src/core/region-view.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';

const FIXTURES = ['large', 'medium', 'safe', 'dangerous'] as const;
type Fixture = (typeof FIXTURES)[number];

const fixture = (name: Fixture): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/realm-${name}.json`, import.meta.url), 'utf8')) as unknown;

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function campaignWith(name: Fixture): number {
  const campaignId = createCampaign(db, { name: `Bounded ${name}`, story_shape: 'structured' }).campaign_id;
  importRegion(db, campaignId, fixture(name), { source: 'generated' });
  return campaignId;
}

const claimOf = (county: StoredPolitics['counties'][number]): string[] => county.claim_hexes ?? county.hexes;

/** The largest connected patch of land outside every county that is unclaimed or claimed wild. */
function largestWildPatch(campaignId: number, politics: StoredPolitics, control: Map<string, PlaceControl>): number {
  const held = new Set(politics.counties.flatMap((county) => county.hexes));
  const coords = new Map(regionHexes(db, campaignId)!.map((hex) => [hex.id, hex]));
  const wild = new Set(
    [...control]
      .filter(([hex, entry]) => !held.has(hex) && (entry.band === 'wild' || entry.band === 'claimed wild'))
      .map(([hex]) => hex),
  );
  const seen = new Set<string>();
  let largest = 0;
  for (const start of wild) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack = [start];
    let size = 0;
    while (stack.length > 0) {
      const { q, r } = coords.get(stack.pop()!)!;
      size++;
      for (const step of hexNeighbours(q, r)) {
        const id = `q${step.q}_r${step.r}`;
        if (wild.has(id) && !seen.has(id)) {
          seen.add(id);
          stack.push(id);
        }
      }
    }
    largest = Math.max(largest, size);
  }
  return largest;
}

describe('the fourth stage of computeHierarchyParts', () => {
  it('keeps the county list, edges, realms, duchies and claims exactly as computed on the claim', () => {
    const campaignId = campaignWith('large');
    const input = politicsInputFromDb(db, campaignId)!;
    const claimed = computeCounties(input);
    const realms = computeRealms(input, claimed);
    const parts = computeHierarchyParts(input);

    expect(parts.realms).toEqual(realms);
    expect(parts.hierarchy).toEqual(computeHierarchy(input, claimed, realms));
    expect(parts.counties.edges).toEqual(claimed.edges);
    expect(parts.counties.counties.map(({ hexes, catchment, ...rest }) => rest)).toEqual(
      claimed.counties.map(({ hexes, ...rest }) => rest),
    );
    expect(parts.counties.counties.map((county) => county.catchment)).toEqual(
      claimed.counties.map((county) => county.hexes),
    );
  });

  it('stores the bounded hexes and the claim side by side', () => {
    const campaignId = campaignWith('safe');
    const politics = ensurePolitics(db, campaignId)!;

    for (const county of politics.counties) {
      expect(county.claim_hexes).toBeDefined();
      expect(county.hexes.length).toBeLessThan(county.claim_hexes!.length);
      const claim = new Set(county.claim_hexes);
      expect(county.hexes.every((hex) => claim.has(hex))).toBe(true);
    }
  });
});

describe.each(FIXTURES)('bounded counties on realm-%s', (name) => {
  it("keeps every county's hexes within its realm's held reach, and all of that reach", () => {
    const campaignId = campaignWith(name);
    const politics = ensurePolitics(db, campaignId)!;
    const control = controlMap(db, campaignId)!;
    const view = getRegion(db, campaignId)!;
    const anchor = new Map(view.places.map((place) => [place.id, place.hexes[0]]));

    for (const county of politics.counties) {
      const pinned = new Set(
        [county.seat_place_id, ...county.village_place_ids].map((id) => anchor.get(id)),
      );
      const held = new Set(county.hexes);
      for (const hex of claimOf(county)) {
        const entry = control.get(hex)!;
        expect(entry.county_id).toBe(county.id);
        expect(entry.realm_id).toBe(county.realm_id);
        const reach = entry.control >= 40 && ['core', 'held', 'contested'].includes(entry.band);
        expect(held.has(hex)).toBe(reach || pinned.has(hex));
      }
    }
  });

  it('keeps bound villages in their county', () => {
    const campaignId = campaignWith(name);
    const politics = ensurePolitics(db, campaignId)!;

    for (const county of politics.counties) {
      for (const villageId of county.village_place_ids) {
        const village = findPlace(db, campaignId, villageId)!;
        expect(county.hexes).toContain(village.hexes[0]);
        expect(placePolitics(db, campaignId, village).county?.id).toBe(county.id);
      }
    }
  });
});

describe('wilderness left between counties', () => {
  it.each(['large', 'dangerous'] as const)('realm-%s keeps a wild patch of at least 10 hexes', (name) => {
    const campaignId = campaignWith(name);
    const politics = ensurePolitics(db, campaignId)!;

    expect(largestWildPatch(campaignId, politics, controlMap(db, campaignId)!)).toBeGreaterThanOrEqual(10);
  });

  it('leaves part of every fixture outside all counties', () => {
    for (const name of FIXTURES) {
      const campaignId = campaignWith(name);
      const politics = ensurePolitics(db, campaignId)!;
      const land = controlMap(db, campaignId)!.size;
      const held = politics.counties.reduce((sum, county) => sum + county.hexes.length, 0);
      expect(held / land).toBeLessThan(0.6);
    }
  });
});

describe('bands derived on read', () => {
  it('reads claimed land under 20 as claimed wild and a place by its anchor hex', () => {
    const campaignId = campaignWith('dangerous');
    const keep = findPlace(db, campaignId, 'Hidden Keep')!;
    const crimsonWharf = findPlace(db, campaignId, 'Crimson Wharf')!;
    const map = controlMap(db, campaignId)!;

    expect(placeControl(db, campaignId, keep)).toMatchObject({ band: 'claimed wild', control: 0, rival_realm_id: null });
    expect(placeControl(db, campaignId, crimsonWharf, map)).toMatchObject({ band: 'core', control: 90 });
    expect([...map.values()].some((entry) => entry.band === 'wild')).toBe(false);
    // The keep lies outside held land but still inside the lordship's legal claim.
    expect(placePolitics(db, campaignId, keep).county?.name).toBe('Lordship of Crimson Wharf');
  });

  it('never stores a band', () => {
    const columns = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
    for (const table of ['world_county', 'world_realm', 'world_region']) {
      expect(columns(table).some((column) => column.includes('band') || column.includes('control'))).toBe(false);
    }
  });

  it('still derives bands for counties stored before claims, without recomputing them', () => {
    const fresh = campaignWith('safe');
    const old = campaignWith('safe');
    ensurePolitics(db, old);
    // A pre-034 campaign: each county holds its whole claim and has no claim column.
    db.prepare('UPDATE world_county SET hexes_json = claim_hexes_json, claim_hexes_json = NULL WHERE campaign_id = ?').run(old);
    const before = getPolitics(db, old)!;
    expect(before.counties.every((county) => county.claim_hexes === undefined)).toBe(true);

    const oldBands = controlMap(db, old)!;
    const freshBands = controlMap(db, fresh)!;
    const strip = (map: Map<string, PlaceControl>): Array<[string, string, number]> =>
      [...map].map(([hex, entry]) => [hex, entry.band, entry.control]);
    expect(strip(oldBands)).toEqual(strip(freshBands));
    expect([...oldBands.values()].some((entry) => entry.band === 'claimed wild')).toBe(true);
    expect(getPolitics(db, old)).toEqual(before);
  });
});

describe('the player map', () => {
  it('shows wilderness gaps between counties without naming anything hidden', () => {
    const campaignId = campaignWith('safe');
    db.prepare('UPDATE world_place SET known_to_party = 1 WHERE campaign_id = ? AND name = ?').run(campaignId, 'Redham');
    const politics = ensurePolitics(db, campaignId)!;
    const map = playerRegionMap({
      view: getRegion(db, campaignId)!,
      hexes: regionHexes(db, campaignId)!,
      politics,
      partyPlace: null,
    });

    const claimed = new Set(politics.counties.flatMap(claimOf));
    const gaps = map.hexes.filter((hex) => hex.county === null && claimed.has(hex.id));
    expect(gaps.length).toBeGreaterThan(0);
    expect(map.hexes.some((hex) => hex.county !== null)).toBe(true);

    const text = JSON.stringify(map);
    for (const hidden of ['Stormcourtby', 'Ficengwind', 'Hotfield', 'Southern Landing', 'Coldwood', 'Ironfall', 'Raven']) {
      if (hidden === 'Ficengwind') {
        expect(text.replaceAll('Kingdom of Ficengwind', '')).not.toContain(hidden);
      } else {
        expect(text).not.toContain(hidden);
      }
    }
    expect(text).not.toContain('claim');
    expect(text).not.toContain('wild');
  });
});

describe('the region tool for the DM', () => {
  async function connect(): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  const textOf = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]!.text;

  it('gives held and claimed hexes per county and the band of a place', async () => {
    const client = await connect();
    const campaignId = campaignWith('dangerous');

    const whole = await client.callTool({ name: 'region', arguments: { campaign_id: campaignId, op: 'get' } });
    const counties = (whole.structuredContent as { realms: Array<{ counties: Array<Record<string, unknown>> }> })
      .realms[0]!.counties;
    expect(counties).toEqual([
      expect.objectContaining({ name: 'Lordship of Crimson Wharf', hexes: 39, claimed_hexes: 79 }),
    ]);
    expect(textOf(whole)).toContain('County land (held/claimed hexes): Lordship of Crimson Wharf 39/79');

    const keep = await client.callTool({
      name: 'region',
      arguments: { campaign_id: campaignId, op: 'get', place: 'Hidden Keep' },
    });
    expect((keep.structuredContent as { control: unknown }).control).toEqual({
      band: 'claimed wild',
      control: 0,
      rival: null,
    });
    expect(textOf(keep).split('\n')[0]).toContain('— Lordship of Crimson Wharf, Lordship of Crimson Wharf; claimed wild land');

    const wharf = await client.callTool({
      name: 'region',
      arguments: { campaign_id: campaignId, op: 'get', place: 'Crimson Wharf' },
    });
    expect(textOf(wharf).split('\n')[0]).toContain('; core land');
    await client.close();
  });
});
