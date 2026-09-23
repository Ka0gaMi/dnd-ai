import { describe, expect, it } from 'vitest';
import { hexCentre, regionLayout, type PlayerRegionMap } from '../src/lib/regionmap';

const SIZE = 10;
const SQRT3 = Math.sqrt(3);

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

const hex = (q: number, r: number, county: number | null = null, terrain = 'plains') => ({
  id: `q${q}_r${r}`,
  q,
  r,
  terrain,
  county,
});

/** A player-safe region map; each case overrides what it is about. */
const map = (over: Partial<PlayerRegionMap> = {}): PlayerRegionMap => ({
  name: 'Test Region',
  width: 1,
  height: 1,
  hexes: [hex(0, 0)],
  counties: [],
  realms: [],
  places: [],
  routes: [],
  party: null,
  ...over,
});

// Even-r neighbour offsets, matching the server rule.
const EVEN_OFFSETS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, -1],
  [1, -1],
  [0, 1],
  [1, 1],
];
const ODD_OFFSETS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [-1, 1],
  [0, 1],
];

describe('hexCentre', () => {
  it('shoves even rows right and leaves odd rows flush', () => {
    expect(hexCentre(0, 0)).toEqual({ x: SIZE * SQRT3 * 0.5, y: 0 });
    expect(hexCentre(0, 1)).toEqual({ x: 0, y: 15 });
  });

  it('places all six neighbours of an even and an odd hex at s·√3', () => {
    for (const [q, r] of EVEN_OFFSETS) {
      expect(distance(hexCentre(0, 0), hexCentre(q, r))).toBeCloseTo(SIZE * SQRT3, 2);
    }
    for (const [dq, dr] of ODD_OFFSETS) {
      expect(distance(hexCentre(0, 1), hexCentre(dq, 1 + dr))).toBeCloseTo(SIZE * SQRT3, 2);
    }
  });
});

describe('regionLayout borders', () => {
  it('draws one shared county edge between two counties of the same realm', () => {
    const layout = regionLayout(
      map({
        width: 2,
        hexes: [hex(0, 0, 0), hex(1, 0, 1)],
        counties: [
          { name: 'A', realm: 0 },
          { name: 'B', realm: 0 },
        ],
        realms: [{ name: 'Realm' }],
      }),
    );

    expect(layout.countyBorders).toHaveLength(1);
    expect(layout.realmBorders).toHaveLength(0);
    const [edge] = layout.countyBorders;
    for (const point of [
      { x: edge.x1, y: edge.y1 },
      { x: edge.x2, y: edge.y2 },
    ]) {
      expect(distance(point, hexCentre(0, 0))).toBeCloseTo(SIZE, 2);
      expect(distance(point, hexCentre(1, 0))).toBeCloseTo(SIZE, 2);
    }
  });

  it('draws one realm edge between two counties of different realms', () => {
    const layout = regionLayout(
      map({
        width: 2,
        hexes: [hex(0, 0, 0), hex(1, 0, 1)],
        counties: [
          { name: 'A', realm: 0 },
          { name: 'B', realm: 1 },
        ],
        realms: [{ name: 'Realm A' }, { name: 'Realm B' }],
      }),
    );

    expect(layout.realmBorders).toHaveLength(1);
    expect(layout.countyBorders).toHaveLength(0);
  });
});

describe('regionLayout routes and party', () => {
  it('threads a route through the hex centres and marks the party hex', () => {
    const layout = regionLayout(
      map({
        width: 2,
        hexes: [hex(0, 0), hex(1, 0)],
        routes: [{ kind: 'road', hexes: ['q0_r0', 'q1_r0'] }],
        party: { q: 1, r: 0 },
      }),
    );

    expect(layout.routes[0].points.split(' ')).toHaveLength(2);
    expect(layout.party).toEqual(hexCentre(1, 0));
  });
});

describe('regionLayout labels', () => {
  it('labels a named county and skips an unnamed one', () => {
    const named = regionLayout(
      map({ hexes: [hex(0, 0, 0)], counties: [{ name: 'County of A', realm: 0 }], realms: [{ name: null }] }),
    );
    const countyLabels = named.labels.filter((label) => label.kind === 'county');
    expect(countyLabels).toHaveLength(1);
    expect(countyLabels[0].text).toBe('County of A');

    const unnamed = regionLayout(
      map({ hexes: [hex(0, 0, 0)], counties: [{ name: null, realm: 0 }], realms: [{ name: null }] }),
    );
    expect(unnamed.labels.filter((label) => label.kind === 'county')).toHaveLength(0);
  });

  it('drops the realm label when it would pile on the only county label', () => {
    const flower = [
      hex(0, 0, 0),
      hex(1, 0, 0),
      hex(-1, 0, 0),
      hex(0, -1, 0),
      hex(1, -1, 0),
      hex(0, 1, 0),
      hex(1, 1, 0),
    ];
    const layout = regionLayout(
      map({
        hexes: flower,
        counties: [{ name: 'County of A', realm: 0 }],
        realms: [{ name: 'Realm A' }],
      }),
    );

    expect(layout.labels).toHaveLength(1);
    expect(layout.labels[0].kind).toBe('county');
    expect(layout.labels[0].text).toBe('County of A');
  });

  it('keeps a realm label whose centre is clear of every county label', () => {
    const layout = regionLayout(
      map({
        hexes: [hex(0, 0, 0), hex(1, 0, 0), hex(30, 0, 1), hex(31, 0, 1)],
        counties: [
          { name: 'West', realm: 0 },
          { name: 'East', realm: 0 },
        ],
        realms: [{ name: 'Realm A' }],
      }),
    );

    expect(layout.labels.map((label) => label.kind).sort()).toEqual(['county', 'county', 'realm']);
  });

  it('anchors a county label on a visible hex when its patches are far apart', () => {
    const hexes = [hex(0, 0, 0), hex(1, 0, 0), hex(2, 0, 0), hex(30, 0, 0)];
    const layout = regionLayout(
      map({ hexes, counties: [{ name: 'Split', realm: 0 }], realms: [{ name: null }] }),
    );

    const [label] = layout.labels.filter((candidate) => candidate.kind === 'county');
    const centres = hexes.map((spot) => hexCentre(spot.q, spot.r));
    expect(centres.some((centre) => centre.x === label.x && centre.y === label.y)).toBe(true);
  });
});

describe('regionLayout viewBox', () => {
  it('frames the known hexes and the party with a margin', () => {
    const layout = regionLayout(
      map({ width: 30, height: 30, hexes: [{ id: 'q10_r10', q: 10, r: 10, terrain: 'plains', county: null }], party: { q: 12, r: 10 } }),
    );
    const [minX, minY, width, height] = layout.viewBox.split(' ').map(Number);
    for (const [q, r] of [[10, 10], [12, 10]] as const) {
      const centre = hexCentre(q, r);
      expect(centre.x).toBeGreaterThan(minX);
      expect(centre.x).toBeLessThan(minX + width);
      expect(centre.y).toBeGreaterThan(minY);
      expect(centre.y).toBeLessThan(minY + height);
    }
    // Far corners of the 30×30 region stay out of frame: the map zooms to what is known.
    expect(hexCentre(29, 29).x).toBeGreaterThan(minX + width);
  });

  it('never frames less than eight hexes a side', () => {
    const layout = regionLayout(map({ width: 3, height: 2, hexes: [{ id: 'q0_r0', q: 0, r: 0, terrain: 'plains', county: null }] }));
    const [, , width, height] = layout.viewBox.split(' ').map(Number);
    expect(width).toBeGreaterThanOrEqual(8 * 10 * Math.sqrt(3) - 0.2);
    expect(height).toBeGreaterThanOrEqual(8 * 10 * 1.5 - 0.2);
  });
});
