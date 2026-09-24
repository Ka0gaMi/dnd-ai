import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { politicsInputFrom } from '../src/core/politics-input.js';
import { computeCounties } from '../src/core/politics-counties.js';
import { computeRealms } from '../src/core/politics-realms.js';
import { computeTribes } from '../src/core/politics-tribes.js';
import { regionHexes } from '../src/core/politics-store.js';
import { parseHex } from '../src/core/region-graph.js';
import { getRegion, importRegion, type RegionView, type WorldPlace, type WorldRoute } from '../src/core/region.js';
import { openDb } from '../src/db/connection.js';
import type {
  ComputedCounties,
  ComputedRealms,
  PoliticsHex,
  PoliticsInput,
} from '../src/core/politics-types.js';

interface RawTown {
  name: string;
  type: 'village' | 'town' | 'city';
  walled: boolean;
  info: string;
  link: string;
  seed: number;
}

interface RawDanger {
  name: string;
  link: string;
  seed: number;
}

interface RawHex {
  q: number;
  r: number;
  terrain?: string;
  town?: RawTown;
  danger?: RawDanger;
}

interface RawRealm {
  name: string;
  layout: string;
  bp: { tags: string[]; seed: number };
  hexes: Record<string, RawHex>;
  roads: Record<string, string[]>;
  searoutes?: Record<string, string[]>;
  features: Array<{ name: string; hexes: string[] }>;
}

function fixture(name: string): RawRealm {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as RawRealm;
}

const large = fixture('realm-large.json');
const medium = fixture('realm-medium.json');

function isCoastal(link: string): boolean {
  if (!URL.canParse(link)) return false;
  const url = new URL(link);
  if (url.searchParams.get('coast') === '1') return true;
  const tags = url.searchParams.get('tags');
  return tags !== null && tags.split(',').includes('coast');
}

/** Reads a region through the real import path, which is how the app builds the engine's input. */
function inputFromDb(raw: RawRealm): PoliticsInput {
  const db = openDb(':memory:');
  const campaignId = createCampaign(db, { name: 'Tribes', story_shape: 'structured' }).campaign_id;
  importRegion(db, campaignId, raw, { source: 'generated' });
  const view = getRegion(db, campaignId)!;
  return politicsInputFrom(view, regionHexes(db, campaignId) ?? []);
}

/** realm-medium is odd-r, which parseRealm refuses, so its view is assembled by hand. */
function viewFromRaw(raw: RawRealm): RegionView {
  const places: WorldPlace[] = [];
  let id = 0;
  for (const [hex, cell] of Object.entries(raw.hexes)) {
    if (cell.town) {
      id++;
      places.push({
        id,
        kind: 'settlement',
        name: cell.town.name,
        q: cell.q,
        r: cell.r,
        hexes: [hex],
        tags: {
          size: cell.town.type,
          walled: cell.town.walled,
          coast: isCoastal(cell.town.link),
          terrain: cell.terrain ?? 'plains',
        },
        info: cell.town.info,
        link: cell.town.link,
        seed: cell.town.seed,
        known_to_party: false,
        entity_id: null,
      });
    }
    if (cell.danger) {
      id++;
      places.push({
        id,
        kind: 'danger',
        name: cell.danger.name,
        q: cell.q,
        r: cell.r,
        hexes: [hex],
        tags: { kind: 'dungeon', terrain: cell.terrain ?? 'plains' },
        info: '',
        link: cell.danger.link,
        seed: cell.danger.seed,
        known_to_party: false,
        entity_id: null,
      });
    }
  }
  const known = new Set(places.map((place) => place.name));
  for (const feature of raw.features) {
    const origin = feature.hexes[0];
    if (origin === undefined || known.has(feature.name)) continue;
    id++;
    const { q, r } = parseHex(origin);
    places.push({
      id,
      kind: 'area',
      name: feature.name,
      q,
      r,
      hexes: feature.hexes,
      tags: {},
      info: '',
      link: null,
      seed: null,
      known_to_party: false,
      entity_id: null,
    });
  }
  const routes: WorldRoute[] = [];
  let routeId = 0;
  for (const [kind, entries] of [
    ['road', raw.roads ?? {}],
    ['searoute', raw.searoutes ?? {}],
  ] as const) {
    for (const hexes of Object.values(entries)) {
      routeId++;
      routes.push({ id: routeId, kind, from_hex: hexes[0], to_hex: hexes[hexes.length - 1], hexes });
    }
  }
  return {
    campaign_id: 0,
    name: raw.name,
    source: 'generated',
    seed: raw.bp.seed,
    tags: raw.bp.tags,
    origin_url: '',
    imported_at: '',
    places,
    routes,
  };
}

function hexesFromRaw(raw: RawRealm): PoliticsHex[] {
  return Object.entries(raw.hexes).map(([id, cell]) => ({
    id,
    q: cell.q,
    r: cell.r,
    terrain: cell.terrain ?? 'plains',
  }));
}

function inputFromRaw(raw: RawRealm): PoliticsInput {
  return politicsInputFrom(viewFromRaw(raw), hexesFromRaw(raw));
}

function row(length: number, terrain: (q: number) => string): PoliticsHex[] {
  return Array.from({ length }, (_, q) => ({ id: `q${q}_r0`, q, r: 0, terrain: terrain(q) }));
}

function makeInput(overrides: Partial<PoliticsInput> & { hexes: PoliticsHex[] }): PoliticsInput {
  return {
    region_name: 'Testland',
    tags: [],
    settlements: [],
    strongholds: [],
    roads: [],
    areas: [],
    edge_hexes: [],
    ...overrides,
  };
}

const ids = (hexes: PoliticsHex[], from: number, to: number): string[] =>
  hexes.slice(from, to + 1).map((hex) => hex.id);

/** The engine sorts hex ids as strings, so expectations are compared in that same order. */
const sorted = (hexes: string[]): string[] => [...hexes].sort();

function capFor(tags: string[]): number {
  if (tags.includes('civilized') || tags.includes('lawful')) return 1;
  if (tags.includes('wild') || tags.includes('chaotic')) return 3;
  return 2;
}

/** A land must name a tribe realm, and a carved county must keep its seat and six hexes. */
function expectTribalInvariants(
  input: PoliticsInput,
  counties: ComputedCounties,
  realms: ComputedRealms,
  result: ReturnType<typeof computeTribes>,
): void {
  expect(result.realms.slice(0, realms.realms.length)).toEqual(realms.realms);
  expect(result.lands.filter((land) => land.frontier).length).toBeLessThanOrEqual(capFor(input.tags));

  const seatHexes = new Set<string>();
  const placeHex = new Map<number, string>();
  for (const place of input.settlements) placeHex.set(place.place_id, place.hex);
  for (const place of input.strongholds) placeHex.set(place.place_id, place.hex);
  for (const county of counties.counties) {
    const hex = placeHex.get(county.seat_place_id);
    if (hex !== undefined) seatHexes.add(hex);
  }

  const holders = new Map<string, number>();
  for (const land of result.lands) {
    expect(land.hexes.length).toBeGreaterThan(0);
    expect(land.realm_index).toBeGreaterThanOrEqual(0);
    expect(land.realm_index).toBeLessThan(result.realms.length);
    expect(result.realms[land.realm_index]!.kind).toBe('tribe');
    for (const id of land.hexes) holders.set(id, (holders.get(id) ?? 0) + 1);
  }
  for (const count of holders.values()) expect(count).toBe(1);

  const carvedHexes = new Set<string>();
  for (const entry of result.carved) {
    expect(entry.county).toBeGreaterThanOrEqual(0);
    expect(entry.county).toBeLessThan(counties.counties.length);
    const county = counties.counties[entry.county]!;
    expect(county.hexes.length - entry.hexes.length).toBeGreaterThanOrEqual(6);
    for (const id of entry.hexes) {
      expect(county.hexes).toContain(id);
      expect(seatHexes.has(id)).toBe(false);
      expect(carvedHexes.has(id)).toBe(false);
      carvedHexes.add(id);
    }
  }

  expect(computeTribes(input, counties, realms)).toEqual(result);
}

describe('wild lands', () => {
  it('turns an unseated twelve-hex patch into one tribal land and realm', () => {
    const hexes = row(12, () => 'plains');
    const input = makeInput({ hexes });
    const counties = computeCounties(input);
    const realms = computeRealms(input, counties);
    const result = computeTribes(input, counties, realms);

    expect(counties.counties).toHaveLength(0);
    expect(result.lands).toHaveLength(1);
    const land = result.lands[0]!;
    expect(land.frontier).toBe(false);
    expect(land.hexes).toEqual(sorted(hexes.map((hex) => hex.id)));
    expect(land.component).toBe(0);
    expect(land.name).toBe('The Island Clans of Testland');
    expect(result.realms).toEqual([
      {
        name: 'The Island Clans of Testland',
        kind: 'tribe',
        capital_place_id: null,
        off_map: false,
        liege: null,
      },
    ]);
    expect(result.carved).toEqual([]);
    expectTribalInvariants(input, counties, realms, result);
  });

  it('ignores a patch smaller than ten hexes', () => {
    const input = makeInput({ hexes: row(9, () => 'plains') });
    const counties = computeCounties(input);
    const realms = computeRealms(input, counties);
    expect(computeTribes(input, counties, realms).lands).toEqual([]);
  });
});

describe('frontier peoples', () => {
  it('carves a far rough area out of a civilized county and keeps its seat', () => {
    const hexes = row(22, (q) => (q >= 10 ? 'forest-dark' : 'plains'));
    const area = { name: 'Grimwood', hexes: ids(hexes, 10, 21) };
    const input = makeInput({
      tags: ['civilized'],
      hexes,
      settlements: [{ place_id: 1, name: 'Farhold', size: 'town', hex: 'q0_r0', coast: false }],
      areas: [area],
    });
    const counties = computeCounties(input);
    const realms = computeRealms(input, counties);
    const result = computeTribes(input, counties, realms);

    expect(counties.counties).toHaveLength(1);
    expect(result.lands).toHaveLength(1);
    const land = result.lands[0]!;
    expect(land.frontier).toBe(true);
    expect(land.name).toBe('The Forest Tribes of Grimwood');
    expect(land.hexes).toEqual(sorted(area.hexes));
    expect(result.carved).toEqual([{ county: 0, hexes: sorted(area.hexes) }]);
    expect(result.carved[0]!.hexes).not.toContain('q0_r0');
    expect(result.realms).toHaveLength(realms.realms.length + 1);
    expect(result.realms[land.realm_index]).toEqual({
      name: 'The Forest Tribes of Grimwood',
      kind: 'tribe',
      capital_place_id: null,
      off_map: false,
      liege: null,
    });
    expectTribalInvariants(input, counties, realms, result);
  });

  it('caps frontier peoples at one civilized and three chaotic', () => {
    const hexes = row(43, (q) => {
      if ((q >= 5 && q <= 16) || (q >= 18 && q <= 29) || (q >= 31 && q <= 42)) return 'forest-dark';
      return 'plains';
    });
    const areas = [
      { name: 'A', hexes: ids(hexes, 5, 16) },
      { name: 'B', hexes: ids(hexes, 18, 29) },
      { name: 'C', hexes: ids(hexes, 31, 42) },
    ];
    const settlements = [
      { place_id: 1, name: 'Town', size: 'town' as const, hex: 'q0_r0', coast: false },
    ];
    const counties = computeCounties(makeInput({ hexes, settlements, areas }));

    const civilized = makeInput({ tags: ['civilized'], hexes, settlements, areas });
    const chaotic = makeInput({ tags: ['chaotic'], hexes, settlements, areas });
    const civilizedResult = computeTribes(civilized, counties, computeRealms(civilized, counties));
    const chaoticResult = computeTribes(chaotic, counties, computeRealms(chaotic, counties));

    expect(civilizedResult.lands).toHaveLength(1);
    expect(civilizedResult.lands[0]!.hexes).toEqual(sorted(areas[0]!.hexes));
    expect(chaoticResult.lands).toHaveLength(3);
    expect(chaoticResult.lands.every((land) => land.frontier)).toBe(true);
  });

  it('joins a wild land to an adjacent existing tribe realm', () => {
    const hexes = row(17, () => 'plains');
    const input = makeInput({
      hexes,
      settlements: [{ place_id: 1, name: 'Keep', size: 'town', hex: 'q0_r0', coast: false }],
    });
    const counties: ComputedCounties = {
      counties: [
        {
          name: 'County of Keep',
          seat_place_id: 1,
          seat_kind: 'town',
          hexes: ids(hexes, 0, 4),
          village_place_ids: [],
          component: 0,
        },
      ],
      edges: [],
    };
    const realms: ComputedRealms = {
      realms: [
        { name: 'The Old Clans', kind: 'tribe', capital_place_id: null, off_map: false, liege: null },
      ],
      county_realm: [0],
    };
    const result = computeTribes(input, counties, realms);

    expect(result.lands).toHaveLength(1);
    expect(result.lands[0]!.realm_index).toBe(0);
    expect(result.lands[0]!.hexes).toEqual(sorted(ids(hexes, 5, 16)));
    expect(result.realms).toEqual(realms.realms);
    expectTribalInvariants(input, counties, realms, result);
  });
});

describe('tribal land names', () => {
  function wildName(terrain: string, area?: { name: string; hexes: string[] }): string {
    const hexes = row(13, (q) => (q === 0 ? 'plains' : terrain));
    const input = makeInput({
      hexes,
      settlements: [{ place_id: 1, name: 'Keep', size: 'town', hex: 'q0_r0', coast: false }],
      areas: area ? [area] : [],
    });
    const counties: ComputedCounties = {
      counties: [
        {
          name: 'County of Keep',
          seat_place_id: 1,
          seat_kind: 'town',
          hexes: ['q0_r0'],
          village_place_ids: [],
          component: 0,
        },
      ],
      edges: [],
    };
    const realms: ComputedRealms = {
      realms: [
        { name: 'Kingdom of Keep', kind: 'kingdom', capital_place_id: 1, off_map: false, liege: null },
      ],
      county_realm: [0],
    };
    const result = computeTribes(input, counties, realms);
    expect(result.lands).toHaveLength(1);
    return result.lands[0]!.name;
  }

  const cover = (): string[] => {
    const hexes = row(13, () => 'plains');
    return ids(hexes, 1, 6);
  };

  it('names a land after its dominant terrain', () => {
    expect(wildName('forest-dark')).toBe('The Forest Tribes');
    expect(wildName('forest-light')).toBe('The Forest Tribes');
    expect(wildName('swamp')).toBe('The Marsh Folk');
    expect(wildName('mountain')).toBe('The Hill Clans');
    expect(wildName('rocks')).toBe('The Hill Clans');
    expect(wildName('plains')).toBe('The Plains Riders');
  });

  it('appends a covering area name at forty percent', () => {
    const hexes = cover();
    expect(wildName('forest-dark', { name: 'Grimwood', hexes })).toBe('The Forest Tribes of Grimwood');
    expect(wildName('swamp', { name: 'Mirefen', hexes })).toBe('The Marsh Folk of Mirefen');
    expect(wildName('mountain', { name: 'The Crags', hexes })).toBe('The Hill Clans of The Crags');
    expect(wildName('plains', { name: 'Wide Steppe', hexes })).toBe('The Plains Riders of Wide Steppe');
  });

  it('calls a whole-component land an island', () => {
    const hexes = row(12, () => 'forest-dark');
    const area = { name: 'Palmwood', hexes: ids(hexes, 0, 5) };
    const input = makeInput({ hexes, areas: [area] });
    const counties = computeCounties(input);
    const realms = computeRealms(input, counties);
    const result = computeTribes(input, counties, realms);
    expect(result.lands[0]!.name).toBe('The Island Clans of Palmwood');
  });
});

describe('computeTribes on the stored fixtures', () => {
  const cases: Array<[string, PoliticsInput]> = [
    ['realm-large.json', inputFromDb(large)],
    ['realm-medium.json', inputFromRaw(medium)],
  ];
  for (const [name, input] of cases) {
    it(`${name} keeps tribal invariants and stays deterministic`, () => {
      const counties = computeCounties(input);
      const realms = computeRealms(input, counties);
      const result = computeTribes(input, counties, realms);
      expectTribalInvariants(input, counties, realms, result);
    });
  }
});

describe('computeTribes determinism', () => {
  it('is stable across repeated runs', () => {
    const hexes = row(22, (q) => (q >= 10 ? 'forest-dark' : 'plains'));
    const input = makeInput({
      tags: ['civilized'],
      hexes,
      settlements: [{ place_id: 1, name: 'Farhold', size: 'town', hex: 'q0_r0', coast: false }],
      areas: [{ name: 'Grimwood', hexes: ids(hexes, 10, 21) }],
    });
    const counties = computeCounties(input);
    const realms = computeRealms(input, counties);
    expect(computeTribes(input, counties, realms)).toEqual(computeTribes(input, counties, realms));
  });
});
