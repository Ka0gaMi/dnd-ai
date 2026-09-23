// Turns a Watabou Dwellings plan into the geometry an inline SVG can draw, with no fetching.

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface FloorLayout {
  level: number;
  label: string;
  viewBox: string;
  cells: Array<{ x: number; y: number; room: number; solid: boolean }>;
  rooms: Array<{ name: string; x: number; y: number }>;
  walls: Segment[];
  doors: Array<Segment & { open: boolean }>;
  windows: Segment[];
  stairs: Array<{ x: number; y: number; up: boolean }>;
  entrance: Segment | null;
}

type Dir = 'n' | 'e' | 's' | 'w';

interface Cell {
  i: number;
  j: number;
}

const DIRS: Dir[] = ['n', 'e', 's', 'w'];
const FLOOR_NAMES = ['Ground floor', 'First floor', 'Second floor', 'Third floor'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Dwellings' `i` is the row and `j` the column, so they are swapped into x (i here) and y (j here). */
function cellOf(value: unknown): Cell | null {
  if (!isRecord(value)) return null;
  const i = num(value.j);
  const j = num(value.i);
  return i === null || j === null ? null : { i, j };
}

const dirOf = (value: unknown): Dir | null =>
  value === 'n' || value === 'e' || value === 's' || value === 'w' ? value : null;

const key = (i: number, j: number): string => `${i},${j}`;

/** The unit edge of a cell in a direction; n is y = j, s is y = j + 1, w is x = i, e is x = i + 1. */
function edgeSegment(i: number, j: number, dir: Dir): Segment {
  if (dir === 'n') return { x1: i, y1: j, x2: i + 1, y2: j };
  if (dir === 's') return { x1: i, y1: j + 1, x2: i + 1, y2: j + 1 };
  if (dir === 'w') return { x1: i, y1: j, x2: i, y2: j + 1 };
  return { x1: i + 1, y1: j, x2: i + 1, y2: j + 1 };
}

function neighbour(i: number, j: number, dir: Dir): Cell {
  if (dir === 'n') return { i, j: j - 1 };
  if (dir === 's') return { i, j: j + 1 };
  if (dir === 'w') return { i: i - 1, j };
  return { i: i + 1, j };
}

/** An edge key that is the same whichever of its two cells produced it, so walls dedupe. */
function segmentKey(segment: Segment): string {
  const a = `${segment.x1},${segment.y1}`;
  const b = `${segment.x2},${segment.y2}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function labelOf(level: number): string {
  if (level >= 0 && level < FLOOR_NAMES.length) return FLOOR_NAMES[level];
  if (level > 0) return `Floor ${level}`;
  if (level === -1) return 'Cellar';
  if (level === -2) return 'Lower cellar';
  return `Cellar ${-level}`;
}

/** Ground floor first, then uppers ascending, then cellars from −1 downwards. */
function orderOf(level: number): [number, number] {
  if (level === 0) return [0, 0];
  if (level > 0) return [1, level];
  return [2, -level];
}

function nameOf(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : '';
}

function doorOf(value: unknown): { cell: Cell; dir: Dir; type: unknown } | null {
  if (!isRecord(value) || !isRecord(value.edge)) return null;
  const cell = cellOf(value.edge.cell);
  const dir = dirOf(value.edge.dir);
  return cell && dir ? { cell, dir, type: value.type } : null;
}

function layoutFor(floor: Record<string, unknown>, level: number, exit: unknown): FloorLayout {
  const rawRooms = Array.isArray(floor.rooms) ? floor.rooms.filter(isRecord) : [];

  const roomOf = new Map<string, number>();
  for (const [index, room] of rawRooms.entries()) {
    if (!Array.isArray(room.cells)) continue;
    for (const raw of room.cells) {
      const cell = cellOf(raw);
      if (cell) roomOf.set(key(cell.i, cell.j), index);
    }
  }

  const rooms: FloorLayout['rooms'] = [];
  const cells: FloorLayout['cells'] = [];
  for (const [index, room] of rawRooms.entries()) {
    const listed = Array.isArray(room.cells)
      ? room.cells.map(cellOf).filter((cell): cell is Cell => cell !== null)
      : [];
    let sumX = 0;
    let sumY = 0;
    for (const cell of listed) {
      sumX += cell.i + 0.5;
      sumY += cell.j + 0.5;
      // Only the room that finally owns the cell contributes it, so an overlap never duplicates.
      if (roomOf.get(key(cell.i, cell.j)) === index) cells.push({ x: cell.i, y: cell.j, room: index, solid: room.solid === true });
    }
    const count = listed.length || 1;
    rooms.push({ name: room.solid === true ? '' : nameOf(room.name), x: sumX / count, y: sumY / count });
  }

  const doorKeys = new Set<string>();
  const doors: FloorLayout['doors'] = [];
  if (Array.isArray(floor.doors)) {
    for (const raw of floor.doors) {
      const door = doorOf(raw);
      if (!door) continue;
      const segment = edgeSegment(door.cell.i, door.cell.j, door.dir);
      doorKeys.add(segmentKey(segment));
      doors.push({ ...segment, open: door.type !== 'REGULAR' });
    }
  }

  const windows: FloorLayout['windows'] = [];
  if (Array.isArray(floor.windows)) {
    for (const raw of floor.windows) {
      const cell = cellOf(isRecord(raw) ? raw.cell : null);
      const dir = dirOf(isRecord(raw) ? raw.dir : null);
      if (cell && dir) windows.push(edgeSegment(cell.i, cell.j, dir));
    }
  }

  const stairs: FloorLayout['stairs'] = [];
  if (Array.isArray(floor.stairs)) {
    for (const raw of floor.stairs) {
      const cell = cellOf(isRecord(raw) ? raw.cell : null);
      if (cell) stairs.push({ x: cell.i, y: cell.j, up: isRecord(raw) && raw.up === true });
    }
  }

  const walls: FloorLayout['walls'] = [];
  const wallKeys = new Set<string>();
  for (const cell of cells) {
    for (const dir of DIRS) {
      const next = neighbour(cell.x, cell.y, dir);
      if (roomOf.get(key(next.i, next.j)) === cell.room) continue;
      const segment = edgeSegment(cell.x, cell.y, dir);
      const edge = segmentKey(segment);
      if (doorKeys.has(edge) || wallKeys.has(edge)) continue;
      wallKeys.add(edge);
      walls.push(segment);
    }
  }

  let minI = Infinity;
  let minJ = Infinity;
  let maxI = -Infinity;
  let maxJ = -Infinity;
  for (const cell of cells) {
    if (cell.x < minI) minI = cell.x;
    if (cell.y < minJ) minJ = cell.y;
    if (cell.x > maxI) maxI = cell.x;
    if (cell.y > maxJ) maxJ = cell.y;
  }
  const viewBox =
    cells.length === 0 ? '0 0 0 0' : `${minI - 0.5} ${minJ - 0.5} ${maxI - minI + 2} ${maxJ - minJ + 2}`;

  let entrance: Segment | null = null;
  if (level === 0) {
    const exitCell = cellOf(isRecord(exit) ? exit.cell : null);
    const exitDir = dirOf(isRecord(exit) ? exit.dir : null);
    if (exitCell && exitDir) entrance = edgeSegment(exitCell.i, exitCell.j, exitDir);
  }

  return { level, label: labelOf(level), viewBox, cells, rooms, walls, doors, windows, stairs, entrance };
}

export function floorLayouts(plan: unknown): FloorLayout[] {
  if (!isRecord(plan) || !Array.isArray(plan.floors)) throw new Error('Not a floor plan');
  return plan.floors
    .filter(isRecord)
    .map((floor) => ({ floor, level: num(floor.level) ?? 0 }))
    .sort((a, b) => {
      const [aGroup, aOrder] = orderOf(a.level);
      const [bGroup, bOrder] = orderOf(b.level);
      return aGroup - bGroup || aOrder - bOrder;
    })
    .map(({ floor, level }) => layoutFor(floor, level, plan.exit));
}
