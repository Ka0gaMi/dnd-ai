/**
 * Vendored from battlecast-engine, src/types/terrain.ts (MIT).
 * https://github.com/bjedrzejewski/battlecast-engine @ ffe036c758f18e772a808f538fe3baa845b9bcc0
 * Copyright (c) 2026 Bartosz Jedrzejewski - see THIRD_PARTY_LICENSES.md.
 *
 * Adapted: the blocked-cell Set is replaced by a predicate so our map rows can answer directly.
 */
import type { Box, Point } from './combat-geometry.js';

/** Cells from (x0,y0) to (x1,y1) inclusive, by Bresenham's line algorithm. */
export function bresenhamLine(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  // Safety bound: a sane battle grid is well under 200 cells on a side.
  for (let i = 0; i < 200; i += 1) {
    cells.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return cells;
}

/** The cell used as a footprint's centre for line maths; the same cell every time, so LOS is stable. */
export function footprintCenter(pos: Point, fp: number): Point {
  const offset = Math.floor(fp / 2);
  return { x: pos.x + offset, y: pos.y + offset };
}

/** True when the centre-to-centre line crosses a sight-blocking cell outside both footprints. */
export function lineOfSightBlocked(from: Box, to: Box, blocks: (x: number, y: number) => boolean): boolean {
  const a = footprintCenter(from, from.fp);
  const b = footprintCenter(to, to.fp);
  const inFrom = (x: number, y: number): boolean =>
    x >= from.x && x < from.x + from.fp && y >= from.y && y < from.y + from.fp;
  const inTo = (x: number, y: number): boolean => x >= to.x && x < to.x + to.fp && y >= to.y && y < to.y + to.fp;
  for (const [x, y] of bresenhamLine(a.x, a.y, b.x, b.y)) {
    if (inFrom(x, y) || inTo(x, y)) continue;
    if (blocks(x, y)) return true;
  }
  return false;
}
