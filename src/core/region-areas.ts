// Pure derivation of area extents at import: a single-hex forest, marsh or hill label is flood-filled
// over its own terrain family into a bounded blob. Deterministic; no dice, no database, no I/O.
import { hexNeighbours } from './politics.js';

export interface ExtentHex {
  q: number;
  r: number;
  terrain?: string;
}

export interface ExtentArea {
  name: string;
  hexes: string[];
}

const MAX_RADIUS = 6;
const MAX_SIZE = 60;

/** Both forest terrains are one family, mountain and rocks another, and every other terrain exact. */
function terrainFamily(terrain: string): string {
  if (terrain === 'forest-dark' || terrain === 'forest-light') return 'forest';
  if (terrain === 'mountain' || terrain === 'rocks') return 'mountain';
  return terrain;
}

const hexId = (q: number, r: number): string => `q${q}_r${r}`;

/**
 * Grows each single-hex area over same-family terrain, at most 6 hexes from its label and 60 hexes
 * total; a shared blob splits to the nearest label. Multi-hex areas and hexes listed by any other
 * feature stay untouched. Returns one list per area, in input order, with the label hex first.
 */
export function deriveAreaExtents(
  hexes: Record<string, ExtentHex>,
  areas: ReadonlyArray<ExtentArea>,
  protectedHexes: ReadonlySet<string>,
): string[][] {
  // Every explicitly listed hex is a wall, so no grower swallows a settlement, danger or another area.
  const walls = new Set<string>(protectedHexes);
  for (const area of areas) {
    for (const hex of area.hexes) walls.add(hex);
  }

  // Multi-source BFS over the whole map: all labels seeded at once, so each free hex goes to the
  // nearest label, and FIFO order breaks a tie toward the earlier area.
  const owner = new Map<string, number>();
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (let index = 0; index < areas.length; index++) {
    const area = areas[index]!;
    if (area.hexes.length !== 1) continue;
    const label = area.hexes[0]!;
    if (hexes[label] === undefined || owner.has(label)) continue;
    owner.set(label, index);
    distance.set(label, 0);
    queue.push(label);
  }

  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    const index = owner.get(id)!;
    const step = distance.get(id)!;
    const cell = hexes[id];
    if (cell === undefined || step >= MAX_RADIUS) continue;
    const family = terrainFamily(hexes[areas[index]!.hexes[0]!]?.terrain ?? 'plains');
    for (const neighbour of hexNeighbours(cell.q, cell.r)) {
      const next = hexId(neighbour.q, neighbour.r);
      if (owner.has(next) || walls.has(next)) continue;
      const target = hexes[next];
      if (target === undefined || terrainFamily(target.terrain ?? 'plains') !== family) continue;
      owner.set(next, index);
      distance.set(next, step + 1);
      queue.push(next);
    }
  }

  return areas.map((area, index) => {
    if (area.hexes.length !== 1) return [...area.hexes];
    const label = area.hexes[0]!;
    if (owner.get(label) !== index) return [...area.hexes];
    const taken = [...owner.entries()]
      .filter(([id, ownerIndex]) => ownerIndex === index && id !== label)
      .map(([id]) => id)
      .sort((a, b) => distance.get(a)! - distance.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
    return [label, ...taken].slice(0, MAX_SIZE);
  });
}
