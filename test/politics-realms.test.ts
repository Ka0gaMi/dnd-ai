import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { politicsInputFrom } from '../src/core/politics-input.js';
import { computeCounties } from '../src/core/politics-counties.js';
import {
  computeRealms,
  countyDistances,
  edgeWeight,
  realmDivisor,
  seatWeight,
} from '../src/core/politics-realms.js';
import { regionHexes } from '../src/core/politics-store.js';
import { getRegion, importRegion, type RegionView } from '../src/core/region.js';
import { openDb } from '../src/db/connection.js';
import type {
  ComputedCounties,
  CountyEdge,
  PoliticsHex,
  PoliticsInput,
  PoliticsSettlement,
  SeatKind,
} from '../src/core/politics-types.js';

interface Spec {
  kind: SeatKind;
  name: string;
  component?: number;
  coast?: boolean;
  population?: number;
}

function landHexes(count: number): PoliticsHex[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `h${index}`,
    q: index,
    r: 0,
    terrain: 'plains',
  }));
}

function countiesFrom(specs: Spec[], edges: CountyEdge[]): ComputedCounties {
  return {
    counties: specs.map((spec, index) => ({
      name: `County of ${spec.name}`,
      seat_place_id: index + 1,
      seat_kind: spec.kind,
      hexes: [`h${index}`],
      village_place_ids: [],
      component: spec.component ?? 0,
    })),
    edges,
  };
}

function settlementsFrom(specs: Spec[]): PoliticsSettlement[] {
  return specs.map((spec, index) => ({
    place_id: index + 1,
    name: spec.name,
    size: spec.kind === 'city' ? 'city' : spec.kind === 'town' ? 'town' : 'village',
    hex: `h${index}`,
    coast: spec.coast ?? false,
    population: spec.population,
  }));
}

function inputFrom(specs: Spec[], overrides: Partial<PoliticsInput> = {}): PoliticsInput {
  return {
    region_name: 'Testland',
    tags: [],
    hexes: landHexes(500),
    settlements: settlementsFrom(specs),
    strongholds: [],
    roads: [],
    areas: [],
    edge_hexes: [],
    ...overrides,
  };
}

function chain(length: number, cost = 1): CountyEdge[] {
  return Array.from({ length: length - 1 }, (_, index) => ({
    a: index,
    b: index + 1,
    cost,
    hard: false,
    sea: false,
  }));
}

/** Asserts the realm partition is total, keeps every capital, and holds each kingdom contiguous. */
function expectRealmInvariants(
  result: ReturnType<typeof computeRealms>,
  counties: ComputedCounties,
): void {
  expect(result.county_realm).toHaveLength(counties.counties.length);
  const byRealm = new Map<number, number[]>();
  result.county_realm.forEach((realm, county) => {
    expect(Number.isInteger(realm)).toBe(true);
    expect(realm).toBeGreaterThanOrEqual(0);
    expect(realm).toBeLessThan(result.realms.length);
    const members = byRealm.get(realm);
    if (members) members.push(county);
    else byRealm.set(realm, [county]);
  });

  // Every declared realm owns the counties mapped to it in county_realm, and no realm is left empty.
  expect(byRealm.size).toBe(result.realms.length);
  result.realms.forEach((realm, index) => {
    expect(byRealm.get(index) ?? []).not.toHaveLength(0);
    if (realm.capital_place_id === null) return;
    const capital = counties.counties.findIndex(
      (county) => county.seat_place_id === realm.capital_place_id,
    );
    expect(capital).toBeGreaterThanOrEqual(0);
    expect(result.county_realm[capital]).toBe(index);
  });

  const adjacency: number[][] = counties.counties.map(() => []);
  for (const edge of counties.edges) {
    adjacency[edge.a].push(edge.b);
    adjacency[edge.b].push(edge.a);
  }
  result.realms.forEach((realm, index) => {
    if (realm.kind !== 'kingdom' || realm.off_map) return;
    const members = new Set(byRealm.get(index) ?? []);
    const start = members.values().next().value;
    if (start === undefined) return;
    const seen = new Set<number>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const county = stack.pop()!;
      for (const neighbour of adjacency[county]) {
        if (!members.has(neighbour) || seen.has(neighbour)) continue;
        seen.add(neighbour);
        stack.push(neighbour);
      }
    }
    expect(seen.size).toBe(members.size);
  });
}

describe('realm helpers', () => {
  it('scales the capital count with the region tags', () => {
    expect(realmDivisor(['civilized'])).toBe(8);
    expect(realmDivisor(['lawful'])).toBe(8);
    expect(realmDivisor(['wild'])).toBe(2);
    expect(realmDivisor(['chaotic'])).toBe(2);
    expect(realmDivisor([])).toBe(4);
  });

  it('weights seats and hard borders', () => {
    expect(seatWeight('city')).toBe(12);
    expect(seatWeight('town')).toBe(4);
    expect(seatWeight('castle')).toBe(2);
    expect(seatWeight('city', 40)).toBe(22);
    expect(seatWeight('town', 16)).toBe(6);
    expect(seatWeight('city', 20, true)).toBe(21.25);
    expect(seatWeight('castle', 0, true)).toBe(2.5);
    expect(edgeWeight({ a: 0, b: 1, cost: 2, hard: true, sea: false })).toBe(8);
    expect(edgeWeight({ a: 0, b: 1, cost: 2, hard: false, sea: true })).toBe(2);
  });

  it('measures all-pairs county distances', () => {
    const counties = countiesFrom(
      [
        { kind: 'city', name: 'A' },
        { kind: 'town', name: 'B' },
        { kind: 'castle', name: 'C' },
      ],
      chain(3, 2),
    );
    expect(countyDistances(counties)).toEqual([
      [0, 2, 4],
      [2, 0, 2],
      [4, 2, 0],
    ]);
  });
});

describe('politicsInputFrom population', () => {
  function viewWith(links: string[]): RegionView {
    return {
      campaign_id: 0,
      name: 'Shore',
      source: 'generated',
      seed: 1,
      tags: [],
      origin_url: '',
      imported_at: '',
      places: links.map((link, index) => ({
        id: index + 1,
        kind: 'settlement' as const,
        name: `P${index}`,
        q: index,
        r: 0,
        hexes: [`h${index}`],
        tags: { size: index === 0 ? 'city' : 'village', coast: index === 0 },
        info: '',
        link,
        seed: index + 1,
        known_to_party: false,
        entity_id: null,
      })),
      routes: [],
    };
  }

  it('parses the city generator size and leaves a village without one', () => {
    const input = politicsInputFrom(
      viewWith([
        'https://watabou.github.io/city-generator/?size=21&seed=7&coast=1',
        'https://watabou.github.io/city-generator/?seed=8',
      ]),
      landHexes(2),
    );
    expect(input.settlements.map((place) => place.population)).toEqual([21, undefined]);
  });

  it('ignores a size that is not a number', () => {
    const input = politicsInputFrom(
      viewWith(['https://watabou.github.io/city-generator/?size=huge&seed=7']),
      landHexes(1),
    );
    expect(input.settlements[0].population).toBeUndefined();
  });
});

describe('computeRealms capital seat weights', () => {
  it('prefers a bigger inland city over a smaller port city', () => {
    const specs: Spec[] = [
      { kind: 'city', name: 'Inland', population: 40 },
      { kind: 'city', name: 'Port', coast: true, population: 8 },
    ];
    const counties = countiesFrom(specs, chain(2));
    const result = computeRealms(inputFrom(specs), counties);
    expect(result.realms[0]!.capital_place_id).toBe(1);
    expectRealmInvariants(result, counties);
  });

  it('prefers a port city over an inland city of equal population', () => {
    const specs: Spec[] = [
      { kind: 'city', name: 'Inland', population: 20 },
      { kind: 'city', name: 'Port', coast: true, population: 20 },
    ];
    const counties = countiesFrom(specs, chain(2));
    const result = computeRealms(inputFrom(specs), counties);
    expect(result.realms[0]!.capital_place_id).toBe(2);
    expectRealmInvariants(result, counties);
  });
});

describe('computeRealms on a civilized kingdom', () => {
  const specs: Spec[] = Array.from({ length: 12 }, (_, index) => ({
    kind: [0, 5, 11].includes(index) ? 'city' : 'castle',
    name: `P${index}`,
  }));
  specs[5] = { kind: 'city', name: 'Crownkeep' };
  const counties = countiesFrom(specs, chain(12));
  const input = inputFrom(specs, { tags: ['civilized'], hexes: landHexes(500) });
  const result = computeRealms(input, counties);

  it('found one or two kingdoms, not one per city', () => {
    expect(result.realms.length).toBe(2);
    expect(result.realms.every((realm) => realm.kind === 'kingdom')).toBe(true);
    expect(result.realms.every((realm) => realm.liege === null)).toBe(true);
    expectRealmInvariants(result, counties);
  });

  it('makes the central city the first capital, not an edge city', () => {
    expect(result.realms[0]!.capital_place_id).toBe(6);
    expect(result.realms[0]!.name).toBe('Kingdom of Crownkeep');
    expect(result.realms.map((realm) => realm.capital_place_id)).not.toContain(1);
  });

  it('gives every kingdom several counties', () => {
    const counts = new Map<number, number>();
    for (const realm of result.county_realm) counts.set(realm, (counts.get(realm) ?? 0) + 1);
    expect([...counts.values()].every((count) => count >= 2)).toBe(true);
  });
});

describe('computeRealms on a neutral region', () => {
  const specs: Spec[] = Array.from({ length: 12 }, (_, index) => ({
    kind: [2, 5, 9].includes(index) ? 'city' : 'town',
    name: `P${index}`,
  }));
  const counties = countiesFrom(specs, chain(12));
  const input = inputFrom(specs, { hexes: landHexes(500) });
  const result = computeRealms(input, counties);

  it('spreads twelve counties over about three kingdoms', () => {
    expect(result.realms).toHaveLength(3);
    expect(result.realms.every((realm) => realm.kind === 'kingdom')).toBe(true);
    expectRealmInvariants(result, counties);
    const counts = new Map<number, number>();
    for (const realm of result.county_realm) counts.set(realm, (counts.get(realm) ?? 0) + 1);
    expect([...counts.values()].every((count) => count >= 2)).toBe(true);
  });
});

describe('computeRealms on chaotic land', () => {
  const specs: Spec[] = Array.from({ length: 8 }, (_, index) => ({
    kind: index === 3 ? 'city' : 'castle',
    name: `P${index}`,
  }));
  const counties = countiesFrom(specs, chain(8, 10));
  const input = inputFrom(specs, { tags: ['chaotic'], hexes: landHexes(500) });
  const result = computeRealms(input, counties);

  it('fragments into small realms with a tribe cluster', () => {
    expect(result.realms).toHaveLength(3);
    const tribes = result.realms.filter((realm) => realm.kind === 'tribe');
    expect(tribes).toHaveLength(1);
    expect(tribes[0]!.capital_place_id).toBe(1);
    expect(tribes[0]!.name).toBe('The P0 Clans');
    const kingdoms = result.realms.filter((realm) => realm.kind === 'kingdom');
    expect(kingdoms).toHaveLength(1);
    expect(kingdoms[0]!.name).toBe('Kingdom of P3');
    // The other capital grew only two counties, so it is a lordship owing fealty to the kingdom.
    const lordship = result.realms.find((realm) => realm.name === 'Lordship of P7');
    expect(lordship).toBeDefined();
    expect(lordship!.liege).toBe(result.realms.indexOf(kingdoms[0]!));
    expectRealmInvariants(result, counties);
  });
});

describe('computeRealms on a small map', () => {
  const specs: Spec[] = [
    { kind: 'castle', name: 'Northkeep' },
    { kind: 'castle', name: 'Southkeep' },
  ];
  const counties = countiesFrom(specs, chain(2));
  const input = inputFrom(specs, { tags: ['civilized'], hexes: landHexes(50) });
  const result = computeRealms(input, counties);

  it('folds every county into one kingdom beyond the map', () => {
    expect(result.realms).toEqual([
      {
        name: 'The Kingdom beyond Testland',
        kind: 'kingdom',
        capital_place_id: null,
        off_map: true,
        liege: null,
      },
    ]);
    expect(result.county_realm).toEqual([0, 0]);
    expectRealmInvariants(result, counties);
  });
});

describe('computeRealms off-map naming', () => {
  const specs: Spec[] = [
    { kind: 'castle', name: 'Northkeep' },
    { kind: 'castle', name: 'Southkeep' },
  ];
  const counties = countiesFrom(specs, chain(2));

  it('strips one leading realm word from the region name beyond the map', () => {
    const expected: Array<[string, string]> = [
      ['Kingdom Of Pank', 'The Kingdom beyond Pank'],
      ['Realm of Ash', 'The Kingdom beyond Ash'],
      ['Lands of the Sun', 'The Kingdom beyond the Sun'],
      ['The Eastern Marches', 'The Kingdom beyond Eastern Marches'],
    ];
    for (const [region, name] of expected) {
      const input = inputFrom(specs, { tags: ['civilized'], region_name: region, hexes: landHexes(50) });
      const result = computeRealms(input, counties);
      const realm = result.realms[0]!;
      expect(realm.name).toBe(name);
      expect(realm.off_map).toBe(true);
      expectRealmInvariants(result, counties);
    }
  });
});

describe('computeRealms across the sea', () => {
  const specs: Spec[] = [
    { kind: 'city', name: 'Haven' },
    { kind: 'town', name: 'Port' },
    { kind: 'town', name: 'Mill' },
    { kind: 'castle', name: 'Watch' },
    { kind: 'castle', name: 'Isle', component: 1 },
  ];
  const edges: CountyEdge[] = [
    ...chain(4),
    { a: 4, b: 0, cost: 10, hard: false, sea: true },
  ];
  const counties = countiesFrom(specs, edges);
  const input = inputFrom(specs, { tags: ['civilized'], hexes: landHexes(500) });
  const result = computeRealms(input, counties);

  it('joins a one-county island to the larger realm overseas', () => {
    expect(result.realms).toHaveLength(1);
    expect(result.realms[0]!.kind).toBe('kingdom');
    expect(result.county_realm).toEqual([0, 0, 0, 0, 0]);
    expectRealmInvariants(result, counties);
  });
});

describe('computeRealms with a sea lane into a settled island', () => {
  const specs: Spec[] = [
    { kind: 'castle', name: 'S0' },
    { kind: 'castle', name: 'S1' },
    { kind: 'city', name: 'S2' },
    { kind: 'castle', name: 'S3' },
    { kind: 'castle', name: 'S4' },
    { kind: 'city', name: 'S5', component: 1, coast: true },
    { kind: 'castle', name: 'S6', component: 1 },
    { kind: 'castle', name: 'S7', component: 1 },
  ];
  const edges: CountyEdge[] = [
    ...chain(5),
    { a: 5, b: 6, cost: 1, hard: false, sea: false },
    { a: 6, b: 7, cost: 1, hard: false, sea: false },
    { a: 5, b: 2, cost: 3, hard: false, sea: true },
  ];
  const counties = countiesFrom(specs, edges);
  const input = inputFrom(specs, { tags: ['civilized'], hexes: landHexes(500) });
  const result = computeRealms(input, counties);

  it('keeps the first island whole and lets the second found its own realm', () => {
    const home = result.realms.findIndex((realm) => realm.name === 'Kingdom of S2');
    const isle = result.realms.findIndex((realm) => realm.name === 'Kingdom of S5');
    expect(home).toBeGreaterThanOrEqual(0);
    expect(isle).toBeGreaterThanOrEqual(0);
    const countiesOf = (realm: number): number[] =>
      result.county_realm.flatMap((owner, county) => (owner === realm ? [county] : []));
    expect(countiesOf(home)).toEqual([0, 1, 2, 3, 4]);
    expect(countiesOf(isle)).toEqual([5, 6, 7]);
    expectRealmInvariants(result, counties);
  });
});

describe('computeRealms with an unreached city', () => {
  const specs: Spec[] = [
    { kind: 'city', name: 'A' },
    { kind: 'city', name: 'B' },
    { kind: 'town', name: 'C' },
    { kind: 'city', name: 'D' },
  ];
  const edges: CountyEdge[] = [
    { a: 0, b: 1, cost: 1, hard: false, sea: false },
    { a: 1, b: 2, cost: 1, hard: false, sea: false },
    { a: 2, b: 3, cost: 30, hard: false, sea: false },
  ];
  const counties = countiesFrom(specs, edges);
  const input = inputFrom(specs, { hexes: landHexes(500) });
  const result = computeRealms(input, counties);

  it('turns the cut-off city into a free city', () => {
    expect(result.realms).toHaveLength(2);
    const free = result.realms.find((realm) => realm.kind === 'free_city');
    expect(free).toBeDefined();
    expect(free!.capital_place_id).toBe(4);
    expect(free!.name).toBe('Free City of D');
    expect(result.county_realm[3]).toBe(result.realms.indexOf(free!));
    expect(result.realms.some((realm) => realm.kind === 'kingdom')).toBe(true);
    expectRealmInvariants(result, counties);
  });
});

describe('computeRealms with a free city between two realms', () => {
  const specs: Spec[] = Array.from({ length: 18 }, (_, index) => ({
    kind: index === 0 || index === 16 || index === 17 ? 'city' : 'castle',
    name: `P${index}`,
  }));
  const edges: CountyEdge[] = [
    ...chain(17),
    { a: 6, b: 17, cost: 22, hard: false, sea: false },
    { a: 10, b: 17, cost: 22, hard: false, sea: false },
  ];
  const counties = countiesFrom(specs, edges);
  const input = inputFrom(specs, { tags: ['civilized'], hexes: landHexes(500) });
  const result = computeRealms(input, counties);

  it('keeps a free city that borders two realms sovereign', () => {
    expect(result.realms).toHaveLength(3);
    const free = result.realms.find((realm) => realm.kind === 'free_city');
    expect(free).toBeDefined();
    expect(free!.capital_place_id).toBe(18);
    expect(free!.liege).toBeNull();
    expect(result.county_realm[17]).toBe(result.realms.indexOf(free!));
    expectRealmInvariants(result, counties);
  });
});

describe('computeRealms with a tiny realm beside a big one', () => {
  const specs: Spec[] = [
    { kind: 'city', name: 'Crown' },
    { kind: 'town', name: 'B1' },
    { kind: 'castle', name: 'B2' },
    { kind: 'town', name: 'B3' },
    { kind: 'castle', name: 'Outpost' },
  ];
  const edges: CountyEdge[] = [
    { a: 0, b: 1, cost: 1, hard: false, sea: false },
    { a: 1, b: 2, cost: 1, hard: false, sea: false },
    { a: 2, b: 3, cost: 1, hard: false, sea: false },
    { a: 3, b: 4, cost: 20, hard: false, sea: false },
  ];
  const counties = countiesFrom(specs, edges);
  const input = inputFrom(specs, { tags: ['civilized'], hexes: landHexes(500) });
  const result = computeRealms(input, counties);

  it('makes the tiny lordship a vassal of the larger kingdom', () => {
    const kingdom = result.realms.find((realm) => realm.kind === 'kingdom');
    const lordship = result.realms.find((realm) => realm.kind === 'lordship');
    expect(kingdom).toBeDefined();
    expect(lordship).toBeDefined();
    expect(lordship!.capital_place_id).toBe(5);
    expect(kingdom!.liege).toBeNull();
    expect(lordship!.liege).toBe(result.realms.indexOf(kingdom!));
    expectRealmInvariants(result, counties);
  });
});

describe('computeRealms invariants', () => {
  const scenarios: Array<{ name: string; input: PoliticsInput; counties: ComputedCounties }> = [];
  const add = (name: string, specs: Spec[], edges: CountyEdge[], overrides: Partial<PoliticsInput>) => {
    scenarios.push({ name, input: inputFrom(specs, overrides), counties: countiesFrom(specs, edges) });
  };
  add(
    'civilized',
    Array.from({ length: 12 }, (_, i) => ({ kind: [0, 5, 11].includes(i) ? 'city' : 'castle', name: `P${i}` })),
    chain(12),
    { tags: ['civilized'] },
  );
  add(
    'chaotic',
    Array.from({ length: 8 }, (_, i) => ({ kind: i === 3 ? 'city' : 'castle', name: `P${i}` })),
    chain(8, 10),
    { tags: ['chaotic'] },
  );
  add('offmap', [{ kind: 'castle', name: 'A' }, { kind: 'castle', name: 'B' }], [], { tags: ['lawful'], hexes: landHexes(20) });

  it('gives every county exactly one realm', () => {
    for (const scenario of scenarios) {
      const result = computeRealms(scenario.input, scenario.counties);
      expectRealmInvariants(result, scenario.counties);
      expect(new Set(result.county_realm).size).toBe(result.realms.length);
    }
  });

  it('is deterministic', () => {
    for (const scenario of scenarios) {
      expect(computeRealms(scenario.input, scenario.counties)).toEqual(
        computeRealms(scenario.input, scenario.counties),
      );
    }
  });
});

interface RawHex {
  q: number;
  r: number;
  terrain?: string;
  town?: { name: string; type: 'village' | 'town' | 'city' };
}

interface RawRealm {
  name: string;
  bp?: { tags?: string[] };
  hexes: Record<string, RawHex>;
}

describe('computeRealms from the medium fixture seats', () => {
  const raw = JSON.parse(
    readFileSync(new URL('./fixtures/realm-medium.json', import.meta.url), 'utf8'),
  ) as RawRealm;
  const seats = Object.entries(raw.hexes)
    .flatMap(([id, hex]) =>
      hex.town && hex.town.type !== 'village' ? [{ id, name: hex.town.name, kind: hex.town.type }] : [],
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const specs: Spec[] = seats.map((seat) => ({ kind: seat.kind, name: seat.name }));
  const counties = countiesFrom(specs, chain(seats.length));
  const input: PoliticsInput = {
    region_name: raw.name,
    tags: raw.bp?.tags ?? [],
    hexes: Object.entries(raw.hexes).map(([id, hex]) => ({
      id,
      q: hex.q,
      r: hex.r,
      terrain: hex.terrain ?? 'plains',
    })),
    settlements: seats.map((seat, index) => ({
      place_id: index + 1,
      name: seat.name,
      size: seat.kind,
      hex: seat.id,
      coast: false,
    })),
    strongholds: [],
    roads: [],
    areas: [],
    edge_hexes: [],
  };

  it('grows a handful of kingdoms from the fixture seats', () => {
    const result = computeRealms(input, counties);
    expect(result.realms.length).toBeGreaterThanOrEqual(1);
    expect(result.realms.every((realm) => realm.kind === 'kingdom')).toBe(true);
    expectRealmInvariants(result, counties);
    const citySeatIndexes = new Set(
      seats.flatMap((seat, index) => (seat.kind === 'city' ? [index] : [])),
    );
    expect(result.realms.some((realm) => citySeatIndexes.has(realm.capital_place_id! - 1))).toBe(true);
    expect(computeRealms(input, counties)).toEqual(result);
  });
});

/** Reads a fixture through the real import path, the way the app builds the engine's input. */
function fixtureInput(name: string): PoliticsInput {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
  const db = openDb(':memory:');
  const campaignId = createCampaign(db, { name: 'Realms', story_shape: 'structured' }).campaign_id;
  importRegion(db, campaignId, raw, { source: 'generated' });
  return politicsInputFrom(getRegion(db, campaignId)!, regionHexes(db, campaignId) ?? []);
}

describe('computeRealms invariants on the stored fixtures', () => {
  for (const name of ['realm-safe.json', 'realm-dangerous.json', 'realm-medium.json', 'realm-large.json']) {
    it(`${name} keeps its realm partition consistent`, () => {
      const input = fixtureInput(name);
      const counties = computeCounties(input);
      const result = computeRealms(input, counties);
      expectRealmInvariants(result, counties);
      expect(computeRealms(input, counties)).toEqual(result);
    });
  }
});
