/**
 * Vendored from battlecast-engine, src/engine/combat-geometry.ts (MIT).
 * https://github.com/bjedrzejewski/battlecast-engine @ ffe036c758f18e772a808f538fe3baa845b9bcc0
 * Copyright (c) 2026 Bartosz Jedrzejewski - see THIRD_PARTY_LICENSES.md.
 *
 * Adapted: the Creature type is replaced by a plain box (cell position plus footprint side in cells),
 * so nothing here knows about our combatant rows.
 */

export interface Point {
  x: number;
  y: number;
}

/** A token on the grid: top-left cell plus the side length of its square footprint, in cells. */
export interface Box extends Point {
  fp: number;
}

export const CELL_FT = 5;

/** Chebyshev distance between two cells, in feet: a diagonal step still costs 5 ft (5e RAW). */
export function distance(a: Point, b: Point): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * CELL_FT;
}

/** Minimum Chebyshev distance between two footprints, in feet: touching boxes return 0. */
export function boxDistance(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.fp - 1), b.x - (a.x + a.fp - 1)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.fp - 1), b.y - (a.y + a.fp - 1)));
  return Math.max(dx, dy) * CELL_FT;
}

/** AABB overlap of two footprints. */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.fp && a.x + a.fp > b.x && a.y < b.y + b.fp && a.y + a.fp > b.y;
}

/** True when `target` lies inside a 60-degree cone of `rangeFt` from `origin` aimed at `direction`. */
export function isInCone(origin: Point, direction: Point, target: Point, rangeFt: number): boolean {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dist = Math.sqrt(dx * dx + dy * dy) * CELL_FT;
  if (dist <= 0 || dist > rangeFt) return false;
  const ddx = direction.x - origin.x;
  const ddy = direction.y - origin.y;
  const dirLen = Math.sqrt(ddx * ddx + ddy * ddy);
  if (dirLen === 0) return dist <= CELL_FT;
  const dot = (dx * ddx + dy * ddy) / (Math.sqrt(dx * dx + dy * dy) * dirLen);
  return dot >= Math.cos(Math.PI / 6);
}

/** True when `target` lies inside a 5 ft wide line of `rangeFt` from `origin` aimed at `direction`. */
export function isInLine(origin: Point, direction: Point, target: Point, rangeFt: number): boolean {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dist = Math.sqrt(dx * dx + dy * dy) * CELL_FT;
  if (dist <= 0 || dist > rangeFt) return false;
  const ddx = direction.x - origin.x;
  const ddy = direction.y - origin.y;
  const dirLen = Math.sqrt(ddx * ddx + ddy * ddy);
  if (dirLen === 0) return dist <= CELL_FT;
  const dot = (dx * ddx + dy * ddy) / dirLen;
  if (dot < 0) return false;
  const perpDist = Math.abs(dx * ddy - dy * ddx) / dirLen;
  return perpDist <= 0.7;
}
