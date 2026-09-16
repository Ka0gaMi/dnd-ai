// Audit P7: SRD 5.2.1 "Moving Around Other Creatures" on the battle grid.
import { describe, expect, it } from 'vitest';
import { canStand, planMove, type Token } from '../src/combat/grid.js';
import type { BattleMap } from '../src/combat/map.js';

/** A hand-built map, so the movement geometry under test is exactly known. */
function plainMap(rows: string[]): BattleMap {
  return { w: rows[0]!.length, h: rows.length, rows, features: [] };
}

const token = (id: number, x: number, y: number, extra: Partial<Token> = {}): Token => ({
  id,
  x,
  y,
  size: 'M',
  alive: true,
  ...extra,
});

/** One row, ten cells: the only way to the far end is straight through whatever stands in it. */
const corridor = plainMap(['..........']);

describe('moving around other creatures (SRD 5.2.1)', () => {
  it('walks straight through an ally', () => {
    const mover = token(1, 0, 0, { team: 'party' });
    const ally = token(2, 3, 0, { team: 'party' });
    const plan = planMove(corridor, [mover, ally], mover, { x: 5, y: 0 }, 30);
    expect(plan.reached).toBe(true);
    expect(plan.destination).toEqual({ x: 5, y: 0 });
    expect(plan.path.some((step) => step.x === 3 && step.y === 0)).toBe(true);
  });

  it("charges difficult terrain for a creature's space", () => {
    const mover = token(1, 0, 0, { team: 'party' });
    const ally = token(2, 2, 0, { team: 'party' });
    const through = planMove(corridor, [mover, ally], mover, { x: 4, y: 0 }, 60);
    const openField = planMove(corridor, [mover], mover, { x: 4, y: 0 }, 60);
    expect(through.cost_ft).toBe(25); // 5 + 10 through the ally + 5 + 5
    expect(openField.cost_ft).toBe(20);
  });

  it('walks through an Incapacitated enemy', () => {
    const mover = token(1, 0, 0, { team: 'party' });
    const foe = token(2, 3, 0, { team: 'enemy', conditions: ['incapacitated'] });
    const plan = planMove(corridor, [mover, foe], mover, { x: 5, y: 0 }, 60);
    expect(plan.reached).toBe(true);
    expect(plan.path.some((step) => step.x === 3)).toBe(true);
  });

  it('walks through a creature two sizes apart', () => {
    const wide = plainMap(['............', '............', '............']);
    const mover = token(1, 0, 1, { team: 'party' });
    const huge = token(2, 5, 0, { size: 'H', team: 'enemy' });
    const plan = planMove(wide, [mover, huge], mover, { x: 10, y: 1 }, 70);
    expect(plan.reached).toBe(true);
    expect(plan.path.some((step) => step.x === 6)).toBe(true);
    expect(plan.cost_ft).toBe(65); // seven free cells and three inside the Huge's space
  });

  it("walks through a Tiny creature's space", () => {
    const mover = token(1, 0, 0, { size: 'S', team: 'party' });
    const tiny = token(2, 3, 0, { size: 'T', team: 'enemy' });
    const plan = planMove(corridor, [mover, tiny], mover, { x: 5, y: 0 }, 30);
    expect(plan.reached).toBe(true);
    expect(plan.path.some((step) => step.x === 3)).toBe(true);
  });

  it('still refuses to pass through an ordinary enemy of the same size', () => {
    const mover = token(1, 0, 0, { team: 'party' });
    const foe = token(2, 2, 0, { team: 'enemy' });
    const blocked = planMove(corridor, [mover, foe], mover, { x: 4, y: 0 }, 60);
    expect(blocked.reached).toBe(false);
    expect(blocked.destination).toEqual({ x: 1, y: 0 });
    expect(blocked.path.some((step) => step.x === 2)).toBe(false);

    // The same cell with an ally in it is passable: hostility, not the cell, decides.
    const ally = token(3, 2, 0, { team: 'party' });
    expect(planMove(corridor, [mover, ally], mover, { x: 4, y: 0 }, 60).reached).toBe(true);
  });

  it('never ends the move on an occupied cell', () => {
    const mover = token(1, 0, 0, { team: 'party' });
    const first = token(2, 2, 0, { team: 'party' });
    const second = token(3, 4, 0, { team: 'party' });
    const plan = planMove(corridor, [mover, first, second], mover, { x: 4, y: 0 }, 60);
    expect(plan.reached).toBe(false);
    expect(plan.destination).toEqual({ x: 3, y: 0 });
    expect(plan.path[plan.path.length - 1]).toMatchObject({ x: 3, y: 0 });

    // Every space the mover can pass through is still not a destination.
    const occupants = [
      token(4, 3, 0, { team: 'party' }),
      token(5, 3, 0, { team: 'enemy', conditions: ['incapacitated'] }),
      token(6, 3, 0, { size: 'H', team: 'enemy' }),
      token(7, 3, 0, { size: 'T', team: 'enemy' }),
    ];
    for (const occupant of occupants) {
      expect(canStand(corridor, [mover, occupant], mover, occupant.x, occupant.y)).toBe(false);
    }
  });
});
