// Grid rules on top of the vendored geometry: footprints, movement, line of sight, cover and areas.
import { isBlocked, isDifficult, type BattleMap } from './map.js';
import { boxDistance, distance, isInCone, isInLine, type Box, type Point, CELL_FT } from './vendor/combat-geometry.js';
import { searchPath, type PathStep } from './vendor/find-path.js';

export type SizeCode = 'T' | 'S' | 'M' | 'L' | 'H' | 'G';
export type Cover = 'none' | 'half' | 'three_quarters' | 'total';

export interface Token {
  id: number;
  x: number;
  y: number;
  size: SizeCode;
  alive: boolean;
}

export const COVER_BONUS: Record<Cover, number> = { none: 0, half: 2, three_quarters: 5, total: 0 };

const FOOTPRINT: Record<SizeCode, number> = { T: 1, S: 1, M: 1, L: 2, H: 3, G: 4 };

export const footprintOf = (size: SizeCode): number => FOOTPRINT[size];

export const boxOf = (token: Token): Box => ({ x: token.x, y: token.y, fp: FOOTPRINT[token.size] });

/** SRD sizes arrive as words ("small", "Gargantuan"); the grid stores the one-letter code. */
export function sizeCode(srdSize: string): SizeCode {
  const first = srdSize.trim().charAt(0).toUpperCase() as SizeCode;
  return FOOTPRINT[first] === undefined ? 'M' : first;
}

/** Chebyshev distance in feet between two tokens' footprints. */
export const distanceBetween = (a: Token, b: Token): number => boxDistance(boxOf(a), boxOf(b));

export const distanceToPoint = (a: Token, point: Point): number => boxDistance(boxOf(a), { ...point, fp: 1 });

export function cellsOf(token: Token): Point[] {
  const fp = FOOTPRINT[token.size];
  const cells: Point[] = [];
  for (let dy = 0; dy < fp; dy += 1) {
    for (let dx = 0; dx < fp; dx += 1) cells.push({ x: token.x + dx, y: token.y + dy });
  }
  return cells;
}

export function occupiedCells(tokens: Token[], exclude: number[] = []): Set<string> {
  const taken = new Set<string>();
  for (const token of tokens) {
    if (!token.alive || exclude.includes(token.id)) continue;
    for (const cell of cellsOf(token)) taken.add(`${cell.x},${cell.y}`);
  }
  return taken;
}

/** Can a token of this size stand with its top-left cell at (x, y)? Other creatures are impassable. */
export function canStand(map: BattleMap, tokens: Token[], mover: Token, x: number, y: number): boolean {
  const fp = FOOTPRINT[mover.size];
  if (x < 0 || y < 0 || x + fp > map.w || y + fp > map.h) return false;
  const taken = occupiedCells(tokens, [mover.id]);
  for (let dy = 0; dy < fp; dy += 1) {
    for (let dx = 0; dx < fp; dx += 1) {
      if (isBlocked(map, x + dx, y + dy)) return false;
      if (taken.has(`${x + dx},${y + dy}`)) return false;
    }
  }
  return true;
}

export interface MovePlan {
  path: PathStep[];
  cost_ft: number;
  destination: Point;
  reached: boolean;
  /** The A* search stopped on its expansion budget, so "no path" may only mean "not from here". */
  budget_exhausted: boolean;
}

/**
 * A* to `target` (or to any cell next to it when `adjacent`), trimmed to the movement budget.
 * Difficult terrain costs double; a big token pays for the cell its top-left corner enters.
 * `through_creatures` is the DM's ruling: other creatures stop blocking the way, but not the cell
 * the move ends in, so the path is cut back to the last free one.
 */
export function planMove(
  map: BattleMap,
  tokens: Token[],
  mover: Token,
  target: Point,
  budgetFt: number,
  adjacent = false,
  throughCreatures = false,
): MovePlan {
  const empty = throughCreatures ? tokens.filter((t) => t.id === mover.id) : tokens;
  const grid = {
    passable: (x: number, y: number): boolean => canStand(map, empty, mover, x, y),
    cost: (x: number, y: number): number => (isDifficult(map, x, y) ? CELL_FT * 2 : CELL_FT),
  };
  const search = searchPath({ x: mover.x, y: mover.y }, target, grid, adjacent);
  const full = search.path;
  const path: PathStep[] = [];
  for (const step of full) {
    if (step.cost > budgetFt) break;
    path.push(step);
  }
  // Passing through somebody is allowed; ending the move on top of them is not.
  while (throughCreatures && path.length > 0 && !canStand(map, tokens, mover, path[path.length - 1]!.x, path[path.length - 1]!.y)) {
    path.pop();
  }
  const last = path[path.length - 1];
  const goal = full[full.length - 1];
  const arrived = Boolean(last && goal && last.x === goal.x && last.y === goal.y && isGoal(goal, target, adjacent));
  return {
    path,
    cost_ft: last?.cost ?? 0,
    destination: last ? { x: last.x, y: last.y } : { x: mover.x, y: mover.y },
    reached: arrived,
    budget_exhausted: search.exhausted,
  };
}

export interface ReachableCell extends Point {
  cost_ft: number;
}

// Orthogonals first, matching the pathfinder's step order.
const STEPS: Array<[number, number]> = [[0, -1], [-1, 0], [1, 0], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

/** Every cell the token can stand in within the budget, at the costs planMove pays, including where it stands. */
export function reachableCells(map: BattleMap, tokens: Token[], mover: Token, budgetFt: number): ReachableCell[] {
  const stand = (x: number, y: number): boolean => canStand(map, tokens, mover, x, y);
  const best = new Map<string, number>([[`${mover.x},${mover.y}`, 0]]);
  let frontier: Point[] = [{ x: mover.x, y: mover.y }];
  while (frontier.length > 0) {
    const next: Point[] = [];
    for (const cell of frontier) {
      const cost = best.get(`${cell.x},${cell.y}`)!;
      for (const [dx, dy] of STEPS) {
        const x = cell.x + dx;
        const y = cell.y + dy;
        if (!stand(x, y)) continue;
        // No corner cutting, as in findPath: a diagonal step needs one of its two side cells open.
        if (dx !== 0 && dy !== 0 && !stand(cell.x + dx, cell.y) && !stand(cell.x, cell.y + dy)) continue;
        const total = cost + (isDifficult(map, x, y) ? CELL_FT * 2 : CELL_FT);
        if (total > budgetFt || total >= (best.get(`${x},${y}`) ?? Infinity)) continue;
        best.set(`${x},${y}`, total);
        next.push({ x, y });
      }
    }
    frontier = next;
  }
  return [...best].map(([key, cost_ft]) => {
    const [x, y] = key.split(',').map(Number);
    return { x: x!, y: y!, cost_ft };
  });
}

const isGoal = (step: Point, target: Point, adjacent: boolean): boolean =>
  adjacent
    ? Math.max(Math.abs(step.x - target.x), Math.abs(step.y - target.y)) <= 1
    : step.x === target.x && step.y === target.y;

export function hasLineOfSight(map: BattleMap, from: Token, to: Token): boolean {
  return cornerLines(map, boxOf(from), boxOf(to), new Set()).blocked < 4;
}

export const COVER_ORDER: Cover[] = ['none', 'half', 'three_quarters', 'total'];

export interface CoverResult {
  cover: Cover;
  ac_bonus: number;
  line_of_sight: boolean;
}

const EPS = 1e-9;

/**
 * Does the segment pass through a cell the predicate marks? A sample sitting exactly on a cell edge
 * counts only when both cells sharing that edge match, so a line running along a wall's face is clear
 * while one squeezing between two wall cells is not; a sample on a lattice corner is always clear.
 * Sixteen samples per cell of the dominant axis: a steep line can clip a cell over a short stretch.
 */
function segmentCrosses(from: Point, to: Point, hit: (x: number, y: number) => boolean): boolean {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) * 16));
  for (let i = 1; i < steps; i += 1) {
    const px = from.x + ((to.x - from.x) * i) / steps;
    const py = from.y + ((to.y - from.y) * i) / steps;
    const onX = Math.abs(px - Math.round(px)) < EPS;
    const onY = Math.abs(py - Math.round(py)) < EPS;
    if (onX && onY) continue;
    const x = Math.round(px);
    const y = Math.round(py);
    if (onX) {
      if (hit(x - 1, Math.floor(py)) && hit(x, Math.floor(py))) return true;
    } else if (onY) {
      if (hit(Math.floor(px), y - 1) && hit(Math.floor(px), y)) return true;
    } else if (hit(Math.floor(px), Math.floor(py))) {
      return true;
    }
  }
  return false;
}

/** The four corner points of a footprint, in grid coordinates (a cell spans [x,x+1] x [y,y+1]). */
const cornersOf = (box: Box): Point[] => [
  { x: box.x, y: box.y },
  { x: box.x + box.fp, y: box.y },
  { x: box.x, y: box.y + box.fp },
  { x: box.x + box.fp, y: box.y + box.fp },
];

/** The best (least covered) attacker corner: how many of its four lines to the target are blocked. */
function cornerLines(
  map: BattleMap,
  a: Box,
  b: Box,
  creatureCells: Set<string>,
): { blocked: number; creature: boolean } {
  const targets = cornersOf(b);
  let best = { blocked: 5, creature: true };
  for (const corner of cornersOf(a)) {
    let blocked = 0;
    let creature = false;
    for (const target of targets) {
      if (segmentCrosses(corner, target, (x, y) => isBlocked(map, x, y))) blocked += 1;
      else if (segmentCrosses(corner, target, (x, y) => creatureCells.has(`${x},${y}`))) creature = true;
    }
    if (blocked < best.blocked || (blocked === best.blocked && best.creature && !creature)) {
      best = { blocked, creature };
    }
  }
  return best;
}

/**
 * Cover by the DMG grid rule, applied to AC and to DEX saves. From the attacker corner that yields the
 * least cover, trace lines to the four corners of the target's space: none blocked is no cover, one or
 * two is half (+2), three is three-quarters (+5), four is total (no line of sight). A creature standing
 * on an otherwise clear line is half cover and never blocks sight.
 */
export function coverBetween(map: BattleMap, tokens: Token[], from: Token, to: Token): CoverResult {
  const creatureCells = occupiedCells(tokens, [from.id, to.id]);
  const { blocked, creature } = cornerLines(map, boxOf(from), boxOf(to), creatureCells);
  const cover: Cover =
    blocked >= 4 ? 'total' : blocked === 3 ? 'three_quarters' : blocked > 0 ? 'half' : creature ? 'half' : 'none';
  return { cover, ac_bonus: COVER_BONUS[cover], line_of_sight: blocked < 4 };
}

export interface AoeShape {
  kind: 'sphere' | 'cone' | 'line' | 'cube';
  size_ft: number;
}

/** Every token with at least one footprint cell inside the area; cones and lines need an origin. */
export function aoeTargets(tokens: Token[], origin: Point | null, point: Point, shape: AoeShape): Token[] {
  const half = shape.size_ft / (CELL_FT * 2);
  const inArea = (cell: Point): boolean => {
    switch (shape.kind) {
      case 'sphere':
        return Math.hypot(cell.x - point.x, cell.y - point.y) * CELL_FT <= shape.size_ft;
      case 'cube':
        return Math.abs(cell.x - point.x) <= half && Math.abs(cell.y - point.y) <= half;
      case 'cone':
        return origin !== null && isInCone(origin, point, cell, shape.size_ft);
      case 'line':
        return origin !== null && isInLine(origin, point, cell, shape.size_ft);
    }
  };
  return tokens.filter((token) => token.alive && cellsOf(token).some(inArea));
}

export { distance, CELL_FT };
export type { Point, PathStep };
