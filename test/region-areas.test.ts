import { describe, expect, it } from 'vitest';
import { parseRealm } from '../src/core/realm.js';
import { deriveAreaExtents, type ExtentArea } from '../src/core/region-areas.js';
import { hexDistance, type Hex } from '../src/core/region-graph.js';

interface Cell {
  q: number;
  r: number;
  terrain: string;
}

const id = (q: number, r: number): string => `q${q}_r${r}`;
const at = (q: number, r: number): Hex => ({ q, r });

/** A keyed map of every cell in a square for which terrain() returns a value. */
function map(terrain: (q: number, r: number) => string | null, range = 12): Record<string, Cell> {
  const hexes: Record<string, Cell> = {};
  for (let q = -range; q <= range; q++) {
    for (let r = -range; r <= range; r++) {
      const value = terrain(q, r);
      if (value !== null) hexes[id(q, r)] = { q, r, terrain: value };
    }
  }
  return hexes;
}

const area = (name: string, hexes: string[]): ExtentArea => ({ name, hexes });

describe('deriveAreaExtents terrain families', () => {
  it('grows a forest label over both forest kinds but not over other terrain', () => {
    // The two hexes at r 0 are swamp; the rest of the ring is the matching forest-light.
    const hexes = map((q, r) => {
      if (hexDistance(at(q, r), at(0, 0)) > 1) return null;
      if (q === 0 && r === 0) return 'forest-dark';
      return r === 0 ? 'swamp' : 'forest-light';
    });
    const [grown] = deriveAreaExtents(hexes, [area('Greywood', [id(0, 0)])], new Set());

    expect(grown).toHaveLength(5);
    expect(grown).toContain(id(0, 1));
    expect(grown).not.toContain(id(1, 0));
    expect(grown).not.toContain(id(-1, 0));
  });

  it('treats mountain and rocks as one family', () => {
    const hexes = map((q, r) =>
      hexDistance(at(q, r), at(0, 0)) > 1 ? null : q === 0 && r === 0 ? 'mountain' : 'rocks',
    );
    const [grown] = deriveAreaExtents(hexes, [area('Iron Ridge', [id(0, 0)])], new Set());

    expect(grown).toHaveLength(7);
  });

  it('matches every other terrain exactly', () => {
    const base = map((q, r) => (hexDistance(at(q, r), at(0, 0)) <= 1 ? 'swamp' : null));
    base[id(1, 0)] = { q: 1, r: 0, terrain: 'plains' };
    const [grown] = deriveAreaExtents(base, [area('Black Marsh', [id(0, 0)])], new Set());

    expect(grown).toHaveLength(6);
    expect(grown).not.toContain(id(1, 0));
  });
});

describe('deriveAreaExtents bounds', () => {
  it('stops the fill at six hexes from the label', () => {
    const hexes = map((q, r) => (r === 0 && q >= 0 && q <= 8 ? 'forest-dark' : null), 10);
    const [grown] = deriveAreaExtents(hexes, [area('Longwood', [id(0, 0)])], new Set());

    expect(grown).toEqual([id(0, 0), id(1, 0), id(2, 0), id(3, 0), id(4, 0), id(5, 0), id(6, 0)]);
  });

  it('caps a blob at sixty hexes, keeping the nearest', () => {
    const hexes = map((q, r) => (hexDistance(at(q, r), at(0, 0)) <= 9 ? 'forest-dark' : null));
    const [grown] = deriveAreaExtents(hexes, [area('Deepwood', [id(0, 0)])], new Set());

    expect(grown).toHaveLength(60);
    expect(grown[0]).toBe(id(0, 0));
    for (const hex of grown) {
      expect(hexDistance(at(0, 0), at(...parse(hex)))).toBeLessThanOrEqual(6);
    }
  });
});

describe('deriveAreaExtents sharing and protection', () => {
  it('splits one shared blob between the two nearest labels', () => {
    const hexes = map((q, r) => (hexDistance(at(q, r), at(0, 0)) <= 9 ? 'forest-dark' : null));
    const [west, east] = deriveAreaExtents(
      hexes,
      [area('Westwood', [id(0, 0)]), area('Eastwood', [id(4, 0)])],
      new Set(),
    );
    const setWest = new Set(west);
    const setEast = new Set(east);

    expect(west.length).toBeGreaterThan(1);
    expect(east.length).toBeGreaterThan(1);
    for (const hex of west) {
      expect(setEast.has(hex)).toBe(false);
      expect(hexDistance(at(0, 0), at(...parse(hex)))).toBeLessThanOrEqual(hexDistance(at(4, 0), at(...parse(hex))));
    }
    for (const hex of east) {
      expect(hexDistance(at(4, 0), at(...parse(hex)))).toBeLessThanOrEqual(hexDistance(at(0, 0), at(...parse(hex))));
    }
    expect(setWest.has(id(1, 0))).toBe(true);
    expect(setWest.has(id(2, 0))).toBe(true);
    expect(setEast.has(id(3, 0))).toBe(true);
  });

  it('leaves hexes listed by another area untouched and unclaimed', () => {
    const hexes = map((q, r) => (hexDistance(at(q, r), at(0, 0)) <= 3 ? 'forest-dark' : null));
    const [grown, ridge] = deriveAreaExtents(
      hexes,
      [area('Greywood', [id(0, 0)]), area('Ridge', [id(1, 0), id(2, 0)])],
      new Set(),
    );

    expect(grown).not.toContain(id(1, 0));
    expect(grown).not.toContain(id(2, 0));
    expect(ridge).toEqual([id(1, 0), id(2, 0)]);
  });

  it('leaves protected settlement and danger hexes alone', () => {
    const hexes = map((q, r) => (hexDistance(at(q, r), at(0, 0)) <= 2 ? 'forest-dark' : null));
    const [grown] = deriveAreaExtents(hexes, [area('Greywood', [id(0, 0)])], new Set([id(1, 0)]));

    expect(grown).not.toContain(id(1, 0));
    expect(grown).toContain(id(0, 1));
  });

  it('returns a multi-hex area unchanged even with no terrain around it', () => {
    const areas = [area('Ridge', [id(0, 0), id(1, 0), id(2, 0)])];
    expect(deriveAreaExtents({}, areas, new Set())).toEqual([areas[0]!.hexes]);
  });

  it('is deterministic', () => {
    const hexes = map((q, r) => (hexDistance(at(q, r), at(0, 0)) <= 9 ? 'forest-dark' : null));
    const areas = [area('Westwood', [id(0, 0)]), area('Eastwood', [id(4, 0)])];
    const first = deriveAreaExtents(hexes, areas, new Set());
    const second = deriveAreaExtents(hexes, areas, new Set());
    expect(second).toEqual(first);
  });
});

describe('parseRealm area growth', () => {
  it('grows a single-hex area at import but leaves a settlement hex alone', () => {
    const cells: Record<string, unknown> = map((q, r) => (hexDistance(at(q, r), at(0, 0)) <= 2 ? 'forest-light' : null), 4);
    cells[id(0, 0)] = { q: 0, r: 0, terrain: 'forest-dark' };
    cells[id(1, 0)] = {
      q: 1,
      r: 0,
      terrain: 'forest-light',
      town: { name: 'Hollow', type: 'village', walled: false, info: '', link: '', seed: 1 },
    };
    const realm = parseRealm({
      name: 'Synthetic Wood',
      origin: 'https://watabou.github.io/perilous-shores/?seed=1',
      bp: { width: 10, height: 10, tags: ['land'], seed: 1 },
      layout: 'even-r',
      hexes: cells,
      roads: {},
      searoutes: {},
      features: [
        { name: 'Hollow', hexes: [id(1, 0)] },
        { name: 'Greywood', hexes: [id(0, 0)] },
      ],
    });

    expect(realm.settlements.map((s) => s.name)).toEqual(['Hollow']);
    expect(realm.areas).toHaveLength(1);
    const [wood] = realm.areas;
    expect(wood!.hexes[0]).toBe(id(0, 0));
    expect(wood!.hexes).not.toContain(id(1, 0));
    expect(wood!.hexes.length).toBeGreaterThan(1);
  });
});

/** The q and r of a hex id, for distance assertions. */
function parse(hex: string): [number, number] {
  const [, q, r] = /q(-?\d+)_r(-?\d+)/.exec(hex)!;
  return [Number(q), Number(r)];
}
