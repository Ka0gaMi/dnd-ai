import { describe, expect, it } from 'vitest';
import { computeHierarchy } from '../src/core/politics-duchies.js';
import type {
  ComputedCounties,
  ComputedCounty,
  ComputedRealm,
  ComputedRealms,
  CountyEdge,
  PoliticsInput,
  PoliticsSettlement,
  SeatKind,
} from '../src/core/politics-types.js';

function county(seat: number, kind: SeatKind, hexes: string[] = [], component = 0): ComputedCounty {
  return {
    name: `County ${seat}`,
    seat_place_id: seat,
    seat_kind: kind,
    hexes,
    village_place_ids: [],
    component,
  };
}

function edges(...list: Array<[number, number, number?, boolean?, boolean?]>): CountyEdge[] {
  return list.map(([a, b, cost = 1, hard = false, sea = false]) => ({ a, b, cost, hard, sea }));
}

function realm(
  name: string,
  kind: ComputedRealm['kind'],
  capital_place_id: number | null,
  off_map = false,
): ComputedRealm {
  return { name, kind, capital_place_id, off_map, liege: null };
}

function input(
  region_name: string,
  places: Array<[number, string, boolean?]>,
  areas: Array<{ name: string; hexes: string[] }> = [],
): PoliticsInput {
  const settlements: PoliticsSettlement[] = places.map(([place_id, name, coast = false]) => ({
    place_id,
    name,
    size: 'town',
    hex: `q${place_id}_r0`,
    coast,
  }));
  return { region_name, tags: [], hexes: [], settlements, strongholds: [], roads: [], areas, edge_hexes: [] };
}

/** A ten-county realm on a line, three cities, one kingdom around the capital city. */
function tenCountyMap(): { counties: ComputedCounties; realms: ComputedRealms } {
  const counties: ComputedCounties = {
    counties: [
      county(100, 'city', ['n0a', 'n0b']),
      county(101, 'town', ['n1a', 'n1b']),
      county(102, 'town', ['n2a', 'n2b']),
      county(103, 'city', ['n3a', 'n3b']),
      county(104, 'town', ['n4a', 'n4b']),
      county(105, 'town', ['n5a', 'n5b']),
      county(106, 'city', ['n6a', 'n6b']),
      county(107, 'castle', ['n7a', 'n7b']),
      county(108, 'castle', ['n8a', 'n8b']),
      county(109, 'castle', ['n9a', 'n9b']),
    ],
    edges: edges([0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9]),
  };
  const realms: ComputedRealms = {
    realms: [realm('Aldenmark', 'kingdom', 100)],
    county_realm: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
  return { counties, realms };
}

const TEN_PLACES: Array<[number, string]> = [
  [100, 'Alden'],
  [101, 'Bram'],
  [102, 'Cedd'],
  [103, 'Dun'],
  [104, 'Esk'],
  [105, 'Fen'],
  [106, 'Garth'],
  [107, 'Holt'],
  [108, 'Ivor'],
  [109, 'Jarl'],
];

describe('computeHierarchy duchies', () => {
  it('gives a ten-county realm a small demesne and 2-5 county ducal duchies at the other cities', () => {
    const { counties, realms } = tenCountyMap();
    const hierarchy = computeHierarchy(input('Aldenmark', TEN_PLACES), counties, realms);

    expect(hierarchy.duchies).toHaveLength(4);

    const demesne = hierarchy.duchies.filter((duchy) => duchy.demesne);
    expect(demesne).toHaveLength(1);
    expect(demesne[0].name).toBe('Crownlands of Alden');
    expect(demesne[0].county_indexes.length).toBeLessThanOrEqual(3);
    expect(demesne[0].joined_how).toBe('core');

    const ducal = hierarchy.duchies.filter((duchy) => !duchy.demesne);
    expect(ducal.some((duchy) => duchy.seat_place_id === 103)).toBe(true);
    expect(ducal.some((duchy) => duchy.seat_place_id === 106)).toBe(true);

    for (const duchy of hierarchy.duchies) {
      expect(duchy.county_indexes.length).toBeGreaterThanOrEqual(2);
      expect(duchy.county_indexes.length).toBeLessThanOrEqual(5);
    }
    for (const duchy of hierarchy.duchies) {
      expect(duchy.county_indexes).toEqual([...duchy.county_indexes].sort((a, b) => a - b));
    }
    expect(hierarchy.county_duchy.every((index) => index !== null)).toBe(true);
  });

  it('gets no duchies from a realm with fewer than four counties', () => {
    const counties: ComputedCounties = {
      counties: [county(1, 'city'), county(2, 'town'), county(3, 'town')],
      edges: edges([0, 1], [1, 2]),
    };
    const realms: ComputedRealms = { realms: [realm('Small', 'kingdom', 1)], county_realm: [0, 0, 0] };

    const hierarchy = computeHierarchy(input('Small', [[1, 'A'], [2, 'B'], [3, 'C']]), counties, realms);

    expect(hierarchy.duchies).toEqual([]);
    expect(hierarchy.county_duchy).toEqual([null, null, null]);
  });

  it('makes one region-named duchy of an off-map realm', () => {
    const counties: ComputedCounties = {
      counties: [county(5, 'castle'), county(9, 'city'), county(3, 'town')],
      edges: edges([0, 1], [1, 2]),
    };
    const realms: ComputedRealms = { realms: [realm('The Reach', 'kingdom', null, true)], county_realm: [0, 0, 0] };

    const hierarchy = computeHierarchy(
      input('The Reach', [[5, 'Keep'], [9, 'Port'], [3, 'Vale']]),
      counties,
      realms,
    );

    expect(hierarchy.duchies).toHaveLength(1);
    expect(hierarchy.duchies[0]).toMatchObject({
      name: 'Duchy of The Reach',
      seat_place_id: 9,
      county_indexes: [0, 1, 2],
      demesne: false,
      joined_how: 'core',
    });
    expect(hierarchy.county_duchy).toEqual([0, 0, 0]);
  });

  it('names a duchy after the area covering most of its hexes', () => {
    const { counties, realms } = tenCountyMap();
    const hierarchy = computeHierarchy(
      input('Aldenmark', TEN_PLACES, [{ name: 'Greenwood', hexes: ['n3a', 'n3b', 'n4a', 'n4b'] }]),
      counties,
      realms,
    );

    expect(hierarchy.duchies.map((duchy) => duchy.name)).toContain('Duchy of Greenwood');
  });

  it('merges a duchy left with a single county into its cheapest neighbour', () => {
    const counties: ComputedCounties = {
      counties: [
        county(400, 'city'),
        county(401, 'town'),
        county(402, 'town'),
        county(403, 'town'),
        county(404, 'town'),
        county(405, 'city'),
      ],
      edges: edges([0, 1], [1, 2], [2, 3], [3, 4], [4, 5, 10]),
    };
    const realms: ComputedRealms = { realms: [realm('Sparse', 'kingdom', 400)], county_realm: [0, 0, 0, 0, 0, 0] };

    const hierarchy = computeHierarchy(
      input('Sparse', [[400, 'A'], [401, 'B'], [402, 'C'], [403, 'D'], [404, 'E'], [405, 'F']]),
      counties,
      realms,
    );

    expect(hierarchy.duchies).toHaveLength(2);
    expect(hierarchy.duchies.some((duchy) => duchy.county_indexes.length === 1)).toBe(false);
    const ducal = hierarchy.duchies.find((duchy) => !duchy.demesne)!;
    expect(ducal.seat_place_id).toBe(402);
    expect(ducal.county_indexes).toEqual([2, 3, 4, 5]);
    expect(hierarchy.county_duchy).toEqual([0, 0, 1, 1, 1, 1]);
  });

  it('is deterministic', () => {
    const { counties, realms } = tenCountyMap();
    const first = computeHierarchy(input('Aldenmark', TEN_PLACES, [{ name: 'Greenwood', hexes: ['n3a', 'n3b', 'n4a', 'n4b'] }]), counties, realms);
    const second = computeHierarchy(input('Aldenmark', TEN_PLACES, [{ name: 'Greenwood', hexes: ['n3a', 'n3b', 'n4a', 'n4b'] }]), counties, realms);
    expect(first).toEqual(second);
  });
});

describe('computeHierarchy seat weights', () => {
  it('prefers a port town over an inland town of equal population for a ducal seat', () => {
    const counties: ComputedCounties = {
      counties: [
        county(300, 'city'),
        county(301, 'town'),
        county(302, 'town'),
        county(303, 'town'),
        county(304, 'town'),
        county(305, 'town'),
      ],
      edges: edges([0, 1], [1, 2], [2, 3], [3, 4], [4, 5]),
    };
    const realms: ComputedRealms = {
      realms: [realm('Coast', 'kingdom', 300)],
      county_realm: [0, 0, 0, 0, 0, 0],
    };

    const hierarchy = computeHierarchy(
      input('Coast', [[300, 'A'], [301, 'B'], [302, 'C'], [303, 'D'], [304, 'E', true], [305, 'F']]),
      counties,
      realms,
    );

    // The port at place 304 outranks the equal inland town at 303, despite the higher place id.
    const ducal = hierarchy.duchies.filter((duchy) => !duchy.demesne);
    expect(ducal.map((duchy) => duchy.seat_place_id)).toEqual([304]);
    expect(hierarchy.county_duchy).toEqual([0, 0, 0, 1, 1, 1]);
  });
});

describe('computeHierarchy marches', () => {
  it('marks a kingdom county border-heavy against other realms, sea edges excluded', () => {
    const counties: ComputedCounties = {
      counties: [
        county(10, 'city'),
        county(11, 'town'),
        county(12, 'town'),
        county(13, 'castle'),
        county(20, 'city'),
        county(21, 'town'),
      ],
      edges: edges([0, 1], [1, 2], [2, 3], [3, 1], [3, 4], [3, 5], [2, 4, 2, false, true]),
    };
    const realms: ComputedRealms = {
      realms: [realm('Kingdom', 'kingdom', 10), realm('Harbour', 'free_city', 20)],
      county_realm: [0, 0, 0, 0, 1, 1],
    };

    const hierarchy = computeHierarchy(
      input('Borderland', [[10, 'Kingston'], [11, 'B'], [12, 'C'], [13, 'D'], [20, 'Port'], [21, 'E']]),
      counties,
      realms,
    );

    // County 3 has two of four land edges foreign; county 2's foreign edge is by sea.
    expect(hierarchy.march_counties).toEqual([3]);
    // Six counties give a global cap of one claim, so the lowest-ratio candidate wins.
    expect(hierarchy.claims).toEqual([
      { county: 3, claimant_realm: 1, strength: 'strong', reason: 'ancient kingdom' },
    ]);
  });
});

describe('computeHierarchy claims', () => {
  it('claims a county nearly equidistant between two capitals, strong within 1.05', () => {
    const counties: ComputedCounties = {
      counties: [
        county(200, 'city'),
        county(201, 'town'),
        county(202, 'town'),
        county(300, 'city'),
        county(301, 'town'),
        county(302, 'town'),
      ],
      edges: edges([0, 1], [1, 2], [2, 3, 2], [3, 4], [4, 5]),
    };
    const realms: ComputedRealms = {
      realms: [realm('League A', 'free_city', 200), realm('League B', 'free_city', 300)],
      county_realm: [0, 0, 0, 1, 1, 1],
    };

    const hierarchy = computeHierarchy(
      input('Two Crowns', [[200, 'A'], [201, 'B'], [202, 'C'], [300, 'D'], [301, 'E'], [302, 'F']]),
      counties,
      realms,
    );

    expect(hierarchy.claims).toEqual([{ county: 2, claimant_realm: 1, strength: 'strong', reason: 'inheritance' }]);
  });

  it('keeps at most the global max(1, round(counties/8)) lowest-ratio claims', () => {
    const counties: ComputedCounties = {
      counties: [
        county(100, 'city'),
        county(101, 'city'),
        county(102, 'city'),
        county(103, 'castle'),
        county(104, 'city'),
        county(105, 'city'),
        county(106, 'city'),
        county(107, 'castle'),
      ],
      edges: edges([0, 7], [7, 1], [7, 2, 1.1], [7, 3, 1.2]),
    };
    const realms: ComputedRealms = {
      realms: [
        realm('R0', 'free_city', 100),
        realm('R1', 'free_city', 101),
        realm('R2', 'free_city', 102),
        realm('R3', 'free_city', 103),
        realm('R4', 'free_city', 104),
        realm('R5', 'free_city', 105),
        realm('R6', 'free_city', 106),
      ],
      county_realm: [0, 1, 2, 3, 4, 5, 6, 0],
    };

    const hierarchy = computeHierarchy(
      input('Cap', [[100, 'A'], [101, 'B'], [102, 'C'], [103, 'D'], [104, 'E'], [105, 'F'], [106, 'G'], [107, 'H']]),
      counties,
      realms,
    );

    // Eight counties cap at one claim in total; county 7 has two candidates but keeps the closest.
    expect(hierarchy.claims).toEqual([{ county: 7, claimant_realm: 1, strength: 'strong', reason: 'dowry' }]);
  });

  it('holds the global cap across a sixteen-county map, keeping only the two lowest ratios', () => {
    const seats: SeatKind[] = ['city', 'town', 'town', 'town', 'town', 'city', 'town', 'town', 'town', 'town', 'city', 'town', 'town', 'town', 'town', 'city'];
    const counties: ComputedCounties = {
      counties: seats.map((kind, index) => county(200 + index, kind)),
      edges: edges(...Array.from({ length: 15 }, (_, index) => [index, index + 1] as [number, number])),
    };
    const realms: ComputedRealms = {
      realms: [
        realm('Crown', 'kingdom', 200),
        realm('Port Five', 'free_city', 205),
        realm('Port Ten', 'free_city', 210),
        realm('Port Fifteen', 'free_city', 215),
      ],
      county_realm: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3],
    };

    const hierarchy = computeHierarchy(
      input('Cap', seats.map((_, index) => [200 + index, `P${index}`])),
      counties,
      realms,
    );

    // Sixteen counties cap at two claims: county 14 to the fifteenth capital and county 11 to the tenth.
    expect(hierarchy.claims.map((claim) => claim.county)).toEqual([11, 14]);
    expect(hierarchy.claims.every((claim) => claim.strength === 'strong')).toBe(true);
  });
});
