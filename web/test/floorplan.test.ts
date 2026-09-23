import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import BuildingPlan from '../src/components/BuildingPlan.svelte';
import { floorLayouts, type FloorLayout, type Segment } from '../src/lib/floorplan';

// Real Watabou Dwellings exports, imported as JSON so the web type check needs no Node types.
import tavern from '../../test/fixtures/plan-tavern.json';
import gothic from '../../test/fixtures/plan-gothic.json';

const edgeKey = (segment: Segment): string => {
  const a = `${segment.x1},${segment.y1}`;
  const b = `${segment.x2},${segment.y2}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
};

describe('floorLayouts', () => {
  it('lays out the tavern ground floor with all six rooms and its openings', () => {
    const layouts: FloorLayout[] = floorLayouts(tavern);

    expect(layouts.map((layout) => layout.label)).toEqual(['Ground floor', 'First floor']);

    const ground = layouts[0];
    expect(ground.rooms.map((room) => room.name)).toEqual([
      'Kitchen',
      'Room',
      'Office',
      'Guest room',
      'Common room',
      'Dormitory',
    ]);
    expect(ground.doors).toHaveLength(6);
    expect(ground.doors.filter((door) => door.open)).toHaveLength(3);
    expect(ground.windows).toHaveLength(22);
    expect(ground.entrance).not.toBeNull();

    expect(ground.walls.length).toBeGreaterThan(0);
    const wallKeys = new Set(ground.walls.map(edgeKey));
    for (const door of ground.doors) expect(wallKeys.has(edgeKey(door))).toBe(false);
  });

  it('orders the gothic house ground-up before its cellar and labels the cellar', () => {
    const layouts = floorLayouts(gothic);

    expect(layouts.map((layout) => layout.level)).toEqual([0, 1, 2, 3, 4, -1]);
    expect(layouts[layouts.length - 1].label).toBe('Cellar');
  });

  it('draws a two-cell room as six outer walls with no dividing wall', () => {
    const layouts = floorLayouts({
      floors: [
        {
          level: 0,
          rooms: [{ name: 'Hall', cells: [{ i: 0, j: 0 }, { i: 0, j: 1 }] }], // one row, two columns: Dwellings' i is the row
          doors: [],
          windows: [],
          stairs: [],
        },
      ],
      exit: { cell: { i: 0, j: 0 }, dir: 'w' },
    });

    expect(layouts).toHaveLength(1);
    expect(layouts[0].walls).toHaveLength(6);
    expect(layouts[0].viewBox).toBe('-0.5 -0.5 3 2');

    const wallKeys = new Set(layouts[0].walls.map(edgeKey));
    expect(wallKeys.has(edgeKey({ x1: 1, y1: 0, x2: 1, y2: 1 }))).toBe(false);
  });

  it('refuses anything that is not a floor plan', () => {
    expect(() => floorLayouts({})).toThrow('Not a floor plan');
  });
});

describe('BuildingPlan', () => {
  it('renders the ground floor, its rooms and a floor switcher', () => {
    const { body } = render(BuildingPlan, {
      props: { name: 'The Gilded Goose', kind: 'tavern', plan: tavern },
    });

    expect(body).toContain('<svg');
    expect(body).toContain('Common room');
    expect(body).toContain('First floor');
    expect(body).toContain("The Gilded Goose (tavern) — floor plan from Watabou's Dwellings");
  });
});
