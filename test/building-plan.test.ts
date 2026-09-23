import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUILDING_KINDS,
  digestPlan,
  dwellingsParams,
  dwellingsUrl,
  playerPlan,
  renderPlanDigest,
  type PlanDigest,
} from '../src/core/building-plan.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;
}

const tavern = fixture('plan-tavern');
const gothic = fixture('plan-gothic');
const house = fixture('plan-house');

const tavernDigest = digestPlan(tavern);
const gothicDigest = digestPlan(gothic);
const houseDigest = digestPlan(house);

function roomsOf(digest: PlanDigest, level: number): Array<[string, number]> {
  const floor = digest.floors.find((candidate) => candidate.level === level);
  return floor ? floor.rooms.map((room) => [room.name, room.cells]) : [];
}

describe('dwellingsParams', () => {
  it('maps every kind to a rooms style and tags', () => {
    const allowed = ['small', 'medium', 'large', 'low', 'tall', 'basement', 'stairwell', 'hallways'];
    for (const kind of BUILDING_KINDS) {
      const { rooms, tags } = dwellingsParams(kind);
      expect(['regular', 'gothic', 'tavern']).toContain(rooms);
      for (const tag of tags) expect(allowed).toContain(tag);
    }
    expect(dwellingsParams('tavern')).toEqual({ rooms: 'tavern', tags: ['medium'] });
    expect(dwellingsParams('inn')).toEqual({ rooms: 'tavern', tags: ['large'] });
    expect(dwellingsParams('house')).toEqual({ rooms: 'regular', tags: ['small'] });
    expect(dwellingsParams('warehouse')).toEqual({ rooms: 'regular', tags: ['large', 'low'] });
    expect(dwellingsParams('keep')).toEqual({ rooms: 'gothic', tags: ['large', 'tall', 'basement', 'stairwell'] });
  });
});

describe('dwellingsUrl', () => {
  it('adds a rooms parameter only when the style is not regular', () => {
    expect(dwellingsUrl(777, 'inn')).toBe('https://watabou.github.io/dwellings/?seed=777&tags=large&rooms=tavern');
    expect(dwellingsUrl(5, 'house')).toBe('https://watabou.github.io/dwellings/?seed=5&tags=small');
    expect(dwellingsUrl(5, 'house')).not.toContain('rooms=');
  });

  it('refuses a seed that is not a non-negative integer', () => {
    expect(() => dwellingsUrl(-1, 'house')).toThrow();
    expect(() => dwellingsUrl(1.5, 'house')).toThrow();
  });
});

describe('digestPlan(tavern)', () => {
  it('counts two floors with the ground floor detail in plan order', () => {
    expect(tavernDigest.floors.length).toBe(2);
    expect(tavernDigest.floors.map((floor) => floor.level)).toEqual([0, 1]);
    expect(roomsOf(tavernDigest, 0)).toEqual([
      ['Kitchen', 5],
      ['Room', 4],
      ['Office', 4],
      ['Guest room', 4],
      ['Common room', 6],
      ['Dormitory', 8],
    ]);
    const ground = tavernDigest.floors[0]!;
    expect(ground.label).toBe('ground floor');
    expect(ground.doors).toBe(3);
    expect(ground.openings).toBe(3);
    expect(ground.windows).toBe(22);
    expect(ground.stairs_up).toBe(true);
    expect(ground.stairs_down).toBe(false);

    expect(roomsOf(tavernDigest, 1)).toEqual([
      ['Dormitory', 8],
      ['Room', 8],
      ['Room', 7],
    ]);
    expect(tavernDigest.floors[1]!.stairs_down).toBe(true);
  });

  it('finds the entrance and no secret rooms', () => {
    expect(tavernDigest.entrance).toBe('Common room');
    expect(tavernDigest.secret_rooms).toEqual([]);
  });

  it('renders the first line with the entrance direction', () => {
    const text = renderPlanDigest('The Gilded Goose', 'tavern', tavernDigest);
    expect(text.split('\n')[0]).toBe(
      'The Gilded Goose (tavern, 2 floors): enter from the west into the Common room.',
    );
  });
});

describe('digestPlan(gothic)', () => {
  it('sorts floors cellars first and labels them', () => {
    expect(gothicDigest.floors.map((floor) => floor.level)).toEqual([-1, 0, 1, 2, 3, 4]);
    expect(gothicDigest.floors.map((floor) => floor.label)).toEqual([
      'cellar',
      'ground floor',
      'first floor',
      'second floor',
      'third floor',
      'floor 4',
    ]);
    expect(roomsOf(gothicDigest, -1)).toEqual([
      ['Menagerie', 5],
      ['Dungeon', 6],
      ['Ritual room', 4],
    ]);
  });

  it('finds the entrance and the secret passage', () => {
    expect(gothicDigest.entrance).toBe('Banquet hall');
    expect(gothicDigest.secret_rooms).toEqual([{ name: 'Secret passage', level: 1 }]);
  });

  it('renders the cellar count and the hidden-room line', () => {
    const text = renderPlanDigest('The Crypt of Saint Aleth', 'gothic', gothicDigest);
    const lines = text.split('\n');
    expect(lines[0]).toContain('6 floors, with a cellar');
    expect(lines[0]).toBe(
      'The Crypt of Saint Aleth (gothic, 6 floors, with a cellar): enter from the north into the Banquet hall.',
    );
    expect(lines.at(-1)).toBe("Hidden from the player's plan: Secret passage (first floor)");
  });
});

describe('digestPlan(house)', () => {
  it('reads the cellar and ground floor', () => {
    expect(houseDigest.entrance).toBe('Hall');
    expect(roomsOf(houseDigest, -1)).toEqual([
      ['Cellar', 9],
      ['Storage', 4],
    ]);
    expect(roomsOf(houseDigest, 0)).toEqual([
      ['Hall', 4],
      ['Kitchen', 4],
      ['Stairhall', 5],
    ]);
  });
});

describe('digestPlan validation', () => {
  it('refuses something that is not a floor plan', () => {
    expect(() => digestPlan({})).toThrow('Not a floor plan');
    expect(() => digestPlan({ floors: 'nope', exit: {} })).toThrow('Not a floor plan');
  });
});

describe('playerPlan', () => {
  it('strips the secret passage and the doors that touch it, leaving the rest', () => {
    const safe = playerPlan(gothic) as {
      floors: Array<{
        level: number;
        rooms: Array<{ name?: string | null }>;
        doors: Array<{ edge: { cell: { i: number; j: number }; dir: string } }>;
      }>;
    };
    const names = safe.floors.flatMap((floor) => floor.rooms.map((room) => room.name));
    expect(names).not.toContain('Secret passage');

    const first = safe.floors.find((floor) => floor.level === 1)!;
    expect(first.rooms.map((room) => room.name)).toEqual(['Lounge', 'Theater', 'Stairhall']);
    expect(first.doors.map((door) => door.edge)).toEqual([{ cell: { i: 3, j: 3 }, dir: 's' }]);
  });

  it('drops windows and stairs inside a secret room, keeping the rest', () => {
    const plan = {
      floors: [
        {
          level: 0,
          rooms: [
            { name: 'Hall', cells: [{ i: 0, j: 0 }] },
            { name: 'Secret chamber', cells: [{ i: 1, j: 1 }] },
          ],
          doors: [],
          windows: [
            { cell: { i: 0, j: 0 }, dir: 'n' },
            { cell: { i: 1, j: 1 }, dir: 'n' },
          ],
          stairs: [{ cell: { i: 1, j: 1 }, dir: 'n', up: true }],
        },
      ],
      exit: { cell: { i: 0, j: 0 }, dir: 'n' },
    };
    const safe = playerPlan(plan) as { floors: Array<{ windows: unknown[]; stairs: unknown[] }> };
    expect(safe.floors[0]!.windows).toEqual([{ cell: { i: 0, j: 0 }, dir: 'n' }]);
    expect(safe.floors[0]!.stairs).toEqual([]);
  });

  it('removes a door whose neighbour cell is secret but keeps one whose neighbour is not', () => {
    const plan = {
      floors: [
        {
          level: 0,
          rooms: [
            { name: 'Hall', cells: [{ i: 0, j: 0 }, { i: 0, j: 1 }] },
            { name: 'Secret vault', cells: [{ i: 1, j: 1 }] },
          ],
          doors: [
            { edge: { cell: { i: 0, j: 1 }, dir: 's' } },
            { edge: { cell: { i: 0, j: 0 }, dir: 's' } },
          ],
          windows: [],
          stairs: [],
        },
      ],
      exit: { cell: { i: 0, j: 0 }, dir: 'n' },
    };
    const safe = playerPlan(plan) as { floors: Array<{ doors: Array<{ edge: unknown }> }> };
    expect(safe.floors[0]!.doors).toEqual([{ edge: { cell: { i: 0, j: 0 }, dir: 's' } }]);
  });

  it('does not mutate the input and copies a plan with no secrets unchanged', () => {
    const before = JSON.stringify(gothic);
    playerPlan(gothic);
    expect(JSON.stringify(gothic)).toBe(before);

    expect(JSON.stringify(playerPlan(tavern))).toBe(JSON.stringify(tavern));
  });

  it('validates like digestPlan', () => {
    expect(() => playerPlan({})).toThrow('Not a floor plan');
  });
});
