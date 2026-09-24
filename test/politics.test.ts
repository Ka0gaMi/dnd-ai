import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { politicsInputFromDb } from '../src/core/politics-input.js';
import { computeHierarchyParts, countyOfHex, hexNeighbours } from '../src/core/politics.js';
import type { PoliticsInput } from '../src/core/politics-types.js';
import { hexDistance } from '../src/core/region-graph.js';
import { importRegion } from '../src/core/region.js';
import { openDb } from '../src/db/connection.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

/** Reads a fixture through the real import path and the engine's own input builder. */
function inputFrom(name: string): PoliticsInput {
  const db = openDb(':memory:');
  const campaignId = createCampaign(db, { name: 'Hierarchy', story_shape: 'structured' }).campaign_id;
  importRegion(db, campaignId, fixture(name), { source: 'generated' });
  return politicsInputFromDb(db, campaignId)!;
}

describe('hexNeighbours', () => {
  it('returns six neighbours one step away on an even row', () => {
    const centre = { q: 4, r: 4 };
    const neighbours = hexNeighbours(centre.q, centre.r);

    expect(neighbours).toHaveLength(6);
    for (const neighbour of neighbours) {
      expect(hexDistance(centre, neighbour)).toBe(1);
    }
  });

  it('returns six neighbours one step away on an odd row', () => {
    const centre = { q: 4, r: 5 };
    const neighbours = hexNeighbours(centre.q, centre.r);

    expect(neighbours).toHaveLength(6);
    for (const neighbour of neighbours) {
      expect(hexDistance(centre, neighbour)).toBe(1);
    }
  });
});

describe('computeHierarchyParts on the large realm', () => {
  const input = inputFrom('realm-large.json');
  const parts = computeHierarchyParts(input);

  it('grows fewer realms than the nine cities', () => {
    expect(input.settlements.filter((place) => place.size === 'city')).toHaveLength(9);
    expect(parts.realms.realms.length).toBeGreaterThan(0);
    expect(parts.realms.realms.length).toBeLessThan(9);
  });

  it('assigns every county to a realm', () => {
    expect(parts.counties.counties.length).toBeGreaterThan(0);
    for (const realm of parts.realms.county_realm) {
      expect(realm).toBeGreaterThanOrEqual(0);
      expect(realm).toBeLessThan(parts.realms.realms.length);
    }
  });

  it('gives at least one realm of four or more counties a duchy', () => {
    const countiesPerRealm = new Map<number, number>();
    for (const realm of parts.realms.county_realm) {
      countiesPerRealm.set(realm, (countiesPerRealm.get(realm) ?? 0) + 1);
    }
    const bigRealms = [...countiesPerRealm.entries()]
      .filter(([, count]) => count >= 4)
      .map(([realm]) => realm);
    expect(bigRealms.length).toBeGreaterThan(0);
    expect(parts.hierarchy.duchies.some((duchy) => bigRealms.includes(duchy.realm))).toBe(true);
    expect(parts.hierarchy.county_duchy).toHaveLength(parts.counties.counties.length);
  });

  it('is deterministic', () => {
    expect(computeHierarchyParts(input)).toEqual(parts);
  });
});

describe('computeHierarchyParts on the safe realm', () => {
  const input = inputFrom('realm-safe.json');
  const parts = computeHierarchyParts(input);

  it('grows three counties under one kingdom', () => {
    expect(parts.counties.counties.map((county) => county.name)).toEqual([
      'County of Redham',
      'County of Ficengwind',
      'Lordship of Southern Landing',
    ]);
    expect(parts.realms.realms.map((realm) => realm.name)).toEqual(['Kingdom of Ficengwind']);
  });

  it('gives every county a realm and leaves the small kingdom without duchies', () => {
    for (const realm of parts.realms.county_realm) expect(realm).toBe(0);
    expect(parts.hierarchy.duchies).toEqual([]);
  });
});

describe('countyOfHex', () => {
  it('finds the county holding a hex, and null for an unheld hex', () => {
    const input = inputFrom('realm-safe.json');
    const parts = computeHierarchyParts(input);
    const redham = parts.counties.counties.findIndex((county) => county.name === 'County of Redham');
    const ficengwind = parts.counties.counties.findIndex((county) => county.name === 'County of Ficengwind');
    const ficengwindSeat = input.settlements.find((place) => place.name === 'Ficengwind')!.hex;

    expect(countyOfHex(parts.counties, 'q6_r8')).toBe(redham);
    expect(countyOfHex(parts.counties, ficengwindSeat)).toBe(ficengwind);
    expect(countyOfHex(parts.counties, 'q999_r999')).toBeNull();
  });
});
