import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { ensurePolitics } from '../src/core/politics-service.js';
import { regionHexes } from '../src/core/politics-store.js';
import { findPlace, getRegion, importRegion, type WorldPlace } from '../src/core/region.js';
import { playerRegionMap, type PlayerRegionMap } from '../src/core/region-view.js';
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

function withSafeRegion(): number {
  const campaignId = newCampaign();
  importRegion(db, campaignId, safe, { source: 'generated' });
  return campaignId;
}

function withDangerousRegion(): number {
  const campaignId = newCampaign();
  importRegion(db, campaignId, dangerous, { source: 'uploaded' });
  return campaignId;
}

function markKnown(name: string): void {
  db.prepare('UPDATE world_place SET known_to_party = 1 WHERE name = ?').run(name);
}

function build(campaignId: number, partyPlace: WorldPlace | null = null): PlayerRegionMap {
  return playerRegionMap({
    view: getRegion(db, campaignId)!,
    hexes: regionHexes(db, campaignId)!,
    politics: ensurePolitics(db, campaignId),
    partyPlace,
  });
}

describe('playerRegionMap with nothing known', () => {
  it('shows no hexes, places, routes or party, but the full extent', () => {
    const map = build(withSafeRegion());

    expect(map.hexes).toEqual([]);
    expect(map.places).toEqual([]);
    expect(map.routes).toEqual([]);
    expect(map.party).toBeNull();
    expect(map.counties).toEqual([]);
    expect(map.realms).toEqual([]);
    expect(map.width).toBe(18);
    expect(map.height).toBe(21);
  });
});

describe('playerRegionMap around a known settlement', () => {
  it('reveals Redham and its surroundings, and nothing the party does not know', () => {
    const campaignId = withSafeRegion();
    markKnown('Redham');
    const map = build(campaignId);

    expect(map.hexes).toHaveLength(19);
    expect(map.places).toEqual([{ name: 'Redham', kind: 'settlement', size: 'town', q: 6, r: 8 }]);
    expect(map.routes).toEqual([]);
    expect(map.counties).toContainEqual({ name: 'County of Redham', realm: 0 });
    expect(map.realms).toEqual([{ name: 'Kingdom of Ficengwind' }]);
    expect(map.places.every((place) => place.name === 'Redham')).toBe(true);
    expect(JSON.stringify(map)).not.toContain('Stormcourtby');
  });

  it('hides a county whose seat the party does not know', () => {
    const campaignId = withSafeRegion();
    markKnown('Redham');
    const map = build(campaignId);

    const hex = map.hexes.find((entry) => entry.id === 'q4_r8');
    expect(hex).toBeDefined();
    expect(hex!.county).not.toBeNull();
    expect(map.counties[hex!.county!]!.name).toBeNull();
    expect(map.places.some((place) => place.name === 'Ficengwind')).toBe(false);
  });

  it('shows the road once both its settlements are known', () => {
    const campaignId = withSafeRegion();
    markKnown('Redham');
    markKnown('Stormcourtby');
    const map = build(campaignId);

    expect(map.hexes).toHaveLength(36);
    expect(map.routes).toHaveLength(1);
    expect(map.routes[0]).toEqual({
      kind: 'road',
      hexes: ['q9_r5', 'q8_r5', 'q7_r6', 'q7_r7', 'q6_r8'],
    });
  });
});

describe('playerRegionMap with dangers', () => {
  it('never lists a danger the party has not met', () => {
    const map = build(withDangerousRegion());

    expect(map.places).toEqual([]);
    expect(map.hexes).toEqual([]);
  });

  it('lists a danger once the party knows it, with no size', () => {
    const campaignId = withDangerousRegion();
    markKnown('Hidden Keep');
    const map = build(campaignId);

    expect(map.places).toEqual([{ name: 'Hidden Keep', kind: 'danger', size: null, q: 5, r: 6 }]);
  });
});

describe('playerRegionMap and the party position', () => {
  it('marks the party position without revealing the place', () => {
    const campaignId = withSafeRegion();
    const redham = findPlace(db, campaignId, 'Redham')!;
    const map = build(campaignId, redham);

    expect(map.party).toEqual({ q: 6, r: 8 });
    expect(map.hexes).toHaveLength(7);
    expect(map.places).toEqual([]);
  });
});

describe('playerRegionMap without politics', () => {
  it('omits every county and realm', () => {
    const campaignId = withSafeRegion();
    markKnown('Redham');
    const map = playerRegionMap({
      view: getRegion(db, campaignId)!,
      hexes: regionHexes(db, campaignId)!,
      politics: null,
      partyPlace: null,
    });

    expect(map.counties).toEqual([]);
    expect(map.realms).toEqual([]);
    expect(map.hexes.every((hex) => hex.county === null)).toBe(true);
  });
});
