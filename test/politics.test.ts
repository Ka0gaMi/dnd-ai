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

/** Land components of an input: connected groups of non-water hexes under the even-r neighbour rule. */
function landComponents(input: PoliticsInput): { groups: string[][]; of: Map<string, number> } {
  const byId = new Map(input.hexes.map((hex) => [hex.id, hex]));
  const isLand = (id: string): boolean => {
    const hex = byId.get(id);
    return hex !== undefined && hex.terrain !== 'water';
  };
  const groups: string[][] = [];
  const of = new Map<string, number>();
  const seen = new Set<string>();
  for (const hex of input.hexes) {
    if (!isLand(hex.id) || seen.has(hex.id)) continue;
    const group: string[] = [];
    const stack = [hex.id];
    seen.add(hex.id);
    while (stack.length > 0) {
      const current = stack.pop()!;
      group.push(current);
      const { q, r } = byId.get(current)!;
      for (const neighbour of hexNeighbours(q, r)) {
        const id = `q${neighbour.q}_r${neighbour.r}`;
        if (!isLand(id) || seen.has(id)) continue;
        seen.add(id);
        stack.push(id);
      }
    }
    groups.push(group);
  }
  groups.forEach((group, index) => {
    for (const id of group) of.set(id, index);
  });
  return { groups, of };
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

describe('county coverage', () => {
  for (const name of ['realm-safe.json', 'realm-dangerous.json', 'realm-medium.json', 'realm-large.json']) {
    it(`gives every land hex in a settled component exactly one county (${name})`, () => {
      const input = inputFrom(name);
      const parts = computeHierarchyParts(input);
      const { groups, of } = landComponents(input);

      // A component with no settlement is wild: no seat grows there and no county claims its land.
      const settled = new Set(
        input.settlements
          .map((place) => of.get(place.hex))
          .filter((index): index is number => index !== undefined),
      );
      const held = new Map<string, number>();
      for (const county of parts.counties.counties) {
        for (const id of county.hexes) held.set(id, (held.get(id) ?? 0) + 1);
      }

      const wrong: string[] = [];
      let checked = 0;
      for (const group of groups) {
        const index = of.get(group[0]!)!;
        if (!settled.has(index)) continue;
        for (const id of group) {
          checked++;
          if (held.get(id) !== 1) wrong.push(id);
        }
      }
      expect(checked).toBeGreaterThan(0);
      expect(wrong).toEqual([]);
    });
  }
});
