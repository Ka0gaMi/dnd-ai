// Pure helpers for Watabou "Dwellings" exports: generator parameters, a share URL, a DM digest of
// the floor plan and a player-safe copy with secret rooms masked as solid masonry. No I/O.
import { z } from 'zod';

export const BUILDING_KINDS = [
  'tavern',
  'inn',
  'house',
  'shop',
  'workshop',
  'warehouse',
  'manor',
  'temple',
  'guildhall',
  'keep',
] as const;

export type BuildingKind = (typeof BUILDING_KINDS)[number];

/** Rooms style and tags each building kind passes to the generator, in URL order. */
const KIND_PARAMS: Record<BuildingKind, { rooms: 'regular' | 'gothic' | 'tavern'; tags: string[] }> = {
  tavern: { rooms: 'tavern', tags: ['medium'] },
  inn: { rooms: 'tavern', tags: ['large'] },
  house: { rooms: 'regular', tags: ['small'] },
  shop: { rooms: 'regular', tags: ['small'] },
  workshop: { rooms: 'regular', tags: ['medium'] },
  warehouse: { rooms: 'regular', tags: ['large', 'low'] },
  manor: { rooms: 'gothic', tags: ['large', 'tall', 'basement'] },
  temple: { rooms: 'gothic', tags: ['large', 'hallways'] },
  guildhall: { rooms: 'gothic', tags: ['large'] },
  keep: { rooms: 'gothic', tags: ['large', 'tall', 'basement', 'stairwell'] },
};

export function dwellingsParams(kind: BuildingKind): { rooms: 'regular' | 'gothic' | 'tavern'; tags: string[] } {
  return KIND_PARAMS[kind];
}

export function dwellingsUrl(seed: number, kind: BuildingKind): string {
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`Seed must be a non-negative integer: ${seed}`);
  const { rooms, tags } = dwellingsParams(kind);
  const params = new URLSearchParams({ seed: String(seed), tags: tags.join(',') });
  if (rooms !== 'regular') params.set('rooms', rooms);
  return `https://watabou.github.io/dwellings/?${params.toString()}`;
}

export interface PlanFloor {
  level: number;
  label: string;
  rooms: Array<{ name: string; cells: number }>;
  doors: number;
  openings: number;
  windows: number;
  stairs_up: boolean;
  stairs_down: boolean;
}

export interface PlanDigest {
  floors: PlanFloor[];
  entrance: string | null;
  /** Compass word of the ground-floor exit, kept so the render can name the entrance direction. */
  entrance_dir: 'north' | 'east' | 'south' | 'west' | null;
  secret_rooms: Array<{ name: string; level: number }>;
}

const dirSchema = z.enum(['n', 'e', 's', 'w']);
const cellSchema = z.looseObject({ i: z.number(), j: z.number() });
const roomSchema = z.looseObject({
  name: z.string().nullish(),
  cells: z.array(cellSchema),
});
const doorSchema = z.looseObject({
  edge: z.looseObject({ cell: cellSchema, dir: dirSchema }),
  type: z.string().optional(),
});
const floorSchema = z.looseObject({
  level: z.number(),
  rooms: z.array(roomSchema),
  doors: z.array(doorSchema),
  windows: z.array(z.looseObject({ cell: cellSchema, dir: dirSchema })),
  stairs: z.array(z.looseObject({ cell: cellSchema, dir: dirSchema, up: z.boolean() })),
});
const planSchema = z.looseObject({
  floors: z.array(floorSchema),
  exit: z.looseObject({ cell: cellSchema, dir: dirSchema }),
});

type Dir = 'n' | 'e' | 's' | 'w';
type RawPlan = z.infer<typeof planSchema>;

const DIR_WORDS: Record<Dir, 'north' | 'east' | 'south' | 'west'> = {
  n: 'north',
  e: 'east',
  s: 'south',
  w: 'west',
};

const SECRET = /secret/i;

function refuse(reason: string): never {
  throw new Error(`Not a floor plan: ${reason}`);
}

function issueReason(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'unrecognised shape';
}

function cellKey(cell: { i: number; j: number }): string {
  return `${cell.i},${cell.j}`;
}

/** Grid neighbour across an edge; Dwellings' `i` is the row, so north is i−1, south i+1, east j+1, west j−1. */
function neighbour(cell: { i: number; j: number }, dir: Dir): { i: number; j: number } {
  if (dir === 'n') return { i: cell.i - 1, j: cell.j };
  if (dir === 's') return { i: cell.i + 1, j: cell.j };
  if (dir === 'e') return { i: cell.i, j: cell.j + 1 };
  return { i: cell.i, j: cell.j - 1 };
}

function roomName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : 'passage';
}

/** `level` 0 is the ground floor; positive levels are upper floors, negative are cellars. */
function levelLabel(level: number): string {
  if (level === 0) return 'ground floor';
  if (level === 1) return 'first floor';
  if (level === 2) return 'second floor';
  if (level === 3) return 'third floor';
  if (level > 3) return `floor ${level}`;
  if (level === -1) return 'cellar';
  if (level === -2) return 'lower cellar';
  return `cellar ${level}`;
}

function containsCell(room: { cells: Array<{ i: number; j: number }> }, cell: { i: number; j: number }): boolean {
  return room.cells.some((c) => c.i === cell.i && c.j === cell.j);
}

export function digestPlan(raw: unknown): PlanDigest {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) refuse(issueReason(parsed.error));
  const plan: RawPlan = parsed.data;

  const floors = [...plan.floors].sort((a, b) => a.level - b.level);
  const secret_rooms: Array<{ name: string; level: number }> = [];
  const digestFloors: PlanFloor[] = floors.map((floor) => {
    const rooms = floor.rooms.map((room) => ({ name: roomName(room.name), cells: room.cells.length }));
    for (const room of rooms) {
      if (SECRET.test(room.name)) secret_rooms.push({ name: room.name, level: floor.level });
    }
    return {
      level: floor.level,
      label: levelLabel(floor.level),
      rooms,
      doors: floor.doors.filter((door) => door.type === 'REGULAR').length,
      openings: floor.doors.filter((door) => door.type === undefined).length,
      windows: floor.windows.length,
      stairs_up: floor.stairs.some((stair) => stair.up),
      stairs_down: floor.stairs.some((stair) => !stair.up),
    };
  });

  const ground = floors.find((floor) => floor.level === 0);
  const entranceRoom = ground?.rooms.find((room) => containsCell(room, plan.exit.cell));
  const entrance = entranceRoom ? roomName(entranceRoom.name) : null;

  return { floors: digestFloors, entrance, entrance_dir: DIR_WORDS[plan.exit.dir], secret_rooms };
}

function floorLine(floor: PlanFloor): string {
  const label = floor.label.charAt(0).toUpperCase() + floor.label.slice(1);
  const rooms = floor.rooms.map((room) => `${room.name} ${room.cells}`).join(', ');
  const parts: string[] = [];
  if (floor.doors > 0) parts.push(`${floor.doors} door${floor.doors === 1 ? '' : 's'}`);
  if (floor.openings > 0) parts.push(`${floor.openings} open doorway${floor.openings === 1 ? '' : 's'}`);
  if (floor.windows > 0) parts.push(`${floor.windows} window${floor.windows === 1 ? '' : 's'}`);

  let line = `${label}: ${rooms}`;
  if (parts.length > 0) line += `; ${parts.join(', ')}`;
  if (floor.stairs_up) line += '; stairs up';
  if (floor.stairs_down) line += '; stairs down';
  return line;
}

export function renderPlanDigest(name: string, kind: string, digest: PlanDigest): string {
  const floors = [...digest.floors].sort((a, b) => b.level - a.level);
  const count = digest.floors.length;
  const cellar = digest.floors.some((floor) => floor.level < 0) ? ', with a cellar' : '';
  let head = `${name} (${kind}, ${count} floor${count === 1 ? '' : 's'}${cellar}): enter from the ${digest.entrance_dir}`;
  if (digest.entrance !== null) head += ` into the ${digest.entrance}`;
  head += '.';

  const lines = [head, ...floors.map(floorLine)];
  if (digest.secret_rooms.length > 0) {
    const hidden = digest.secret_rooms.map((room) => `${room.name} (${levelLabel(room.level)})`).join(', ');
    lines.push(`Hidden from the player's plan: ${hidden}`);
  }
  return lines.join('\n');
}

export function playerPlan(raw: unknown): unknown {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) refuse(issueReason(parsed.error));
  const plan = JSON.parse(JSON.stringify(raw)) as RawPlan;

  for (const floor of plan.floors) {
    const secretCells = new Set<string>();
    for (const room of floor.rooms) {
      if (SECRET.test(roomName(room.name))) {
        for (const cell of room.cells) secretCells.add(cellKey(cell));
      }
    }
    floor.rooms = floor.rooms.map((room) =>
      SECRET.test(roomName(room.name)) ? { name: null, cells: room.cells, solid: true } : room,
    );
    floor.doors = floor.doors.filter(
      (door) => !secretCells.has(cellKey(door.edge.cell)) && !secretCells.has(cellKey(neighbour(door.edge.cell, door.edge.dir))),
    );
    floor.windows = floor.windows.filter((window) => !secretCells.has(cellKey(window.cell)));
    floor.stairs = floor.stairs.filter((stair) => !secretCells.has(cellKey(stair.cell)));
  }
  return plan;
}
