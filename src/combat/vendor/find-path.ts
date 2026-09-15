/**
 * Vendored from battlecast-engine, findPath in src/engine/ai-movement.ts (MIT).
 * https://github.com/bjedrzejewski/battlecast-engine @ ffe036c758f18e772a808f538fe3baa845b9bcc0
 * Copyright (c) 2026 Bartosz Jedrzejewski - see THIRD_PARTY_LICENSES.md.
 *
 * Adapted: the creature list and terrain Set become passable/cost callbacks (so difficult terrain can
 * cost double), the goal can be the target cell itself instead of any cell next to it, the path
 * carries its running cost, and the search says when it stopped on its expansion budget.
 */
import type { Point } from './combat-geometry.js';

export interface Grid {
  /** Can a token of this footprint stand with its top-left cell here? */
  passable(x: number, y: number): boolean;
  /** Cost in feet of entering this cell. */
  cost(x: number, y: number): number;
}

export interface PathStep extends Point {
  cost: number;
}

export interface PathResult {
  path: PathStep[];
  /** The search hit MAX_EXPANSIONS: the path is the best effort so far, not proof there is none. */
  exhausted: boolean;
}

const chebyshev = (a: Point, b: Point): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// Orthogonals first so straight lines win ties against diagonals.
const DIRS: Array<[number, number]> = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

const MAX_EXPANSIONS = 4000;

/**
 * A* from `from` to `target`. With `adjacent` the goal is any cell next to the target (melee closing),
 * otherwise the target cell itself. Returns the steps after `from`, each with the cumulative cost in
 * feet, or the best-effort path toward the closest cell reached when the goal is unreachable.
 */
export function findPath(from: Point, target: Point, grid: Grid, adjacent: boolean): PathStep[] {
  return searchPath(from, target, grid, adjacent).path;
}

/** The same search, with the budget flag the engine turns into "try a nearer waypoint". */
export function searchPath(from: Point, target: Point, grid: Grid, adjacent: boolean): PathResult {
  interface Node extends Point {
    g: number;
    f: number;
    parentKey: string | null;
  }
  const startKey = `${from.x},${from.y}`;
  const start: Node = { x: from.x, y: from.y, g: 0, f: chebyshev(from, target), parentKey: null };
  const open = new Map<string, Node>([[startKey, start]]);
  const all = new Map<string, Node>([[startKey, start]]);
  const closed = new Set<string>();

  let bestH = chebyshev(from, target);
  let bestKey: string | null = null;

  const buildPath = (endKey: string): PathStep[] => {
    const path: PathStep[] = [];
    let key: string | null = endKey;
    while (key && key !== startKey) {
      const node = all.get(key);
      if (!node) break;
      path.unshift({ x: node.x, y: node.y, cost: node.g });
      key = node.parentKey;
    }
    return path;
  };

  const reached = (node: Point): boolean =>
    adjacent ? chebyshev(node, target) <= 1 : node.x === target.x && node.y === target.y;

  let expansions = 0;
  while (open.size > 0 && expansions++ < MAX_EXPANSIONS) {
    let currentKey = '';
    let current: Node | null = null;
    for (const [key, node] of open) {
      if (!current || node.f < current.f) {
        current = node;
        currentKey = key;
      }
    }
    if (!current) break;
    if (reached(current) && currentKey !== startKey) return { path: buildPath(currentKey), exhausted: false };

    open.delete(currentKey);
    closed.add(currentKey);

    for (const [dx, dy] of DIRS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      const key = `${nx},${ny}`;
      if (closed.has(key)) continue;
      if (!grid.passable(nx, ny)) continue;
      // No corner cutting: a diagonal step needs at least one of its two side cells open.
      if (dx !== 0 && dy !== 0) {
        if (!grid.passable(current.x + dx, current.y) && !grid.passable(current.x, current.y + dy)) continue;
      }
      const g = current.g + grid.cost(nx, ny);
      const existing = open.get(key);
      if (existing && existing.g <= g) continue;
      const h = chebyshev({ x: nx, y: ny }, target);
      const node: Node = { x: nx, y: ny, g, f: g + h * 5, parentKey: currentKey };
      open.set(key, node);
      all.set(key, node);
      if (h < bestH) {
        bestH = h;
        bestKey = key;
      }
    }
  }
  return { path: bestKey ? buildPath(bestKey) : [], exhausted: expansions >= MAX_EXPANSIONS };
}
