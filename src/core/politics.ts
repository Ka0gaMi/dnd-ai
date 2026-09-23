// Pure, deterministic partition of a region's land: counties grown from seats by multi-source
// Dijkstra, and realms grown from the city seats. No database, no randomness, no I/O.
import { hexDistance, parseHex } from './region-graph.js';

export interface PoliticsHex {
  id: string;
  q: number;
  r: number;
  terrain: string;
}

export interface PoliticsSettlement {
  place_id: number;
  name: string;
  size: 'village' | 'town' | 'city';
  hex: string;
}

export interface PoliticsInput {
  region_name: string;
  hexes: PoliticsHex[];
  settlements: PoliticsSettlement[];
}

export interface ComputedPolitics {
  realms: Array<{ name: string; capital_place_id: number | null }>;
  counties: Array<{ name: string; seat_place_id: number; realm: number; hexes: string[] }>;
}

const EPSILON = 1e-9;

const MOVEMENT_COST: Record<string, number> = {
  plains: 1,
  'forest-light': 1.5,
  'forest-dark': 2,
  rocks: 2.5,
  swamp: 3,
  mountain: 4,
};

const SEAT_POWER: Record<PoliticsSettlement['size'], number> = {
  city: 1.6,
  town: 1.3,
  village: 1,
};

const movementCost = (terrain: string): number => MOVEMENT_COST[terrain] ?? 1;

const hexId = (q: number, r: number): string => `q${q}_r${r}`;

/** Even-r offset neighbours: even rows step one way, odd rows the other. */
export function hexNeighbours(q: number, r: number): Array<{ q: number; r: number }> {
  const offsets =
    r % 2 === 0
      ? [
          [1, 0],
          [-1, 0],
          [0, -1],
          [1, -1],
          [0, 1],
          [1, 1],
        ]
      : [
          [1, 0],
          [-1, 0],
          [-1, -1],
          [0, -1],
          [-1, 1],
          [0, 1],
        ];
  return offsets.map(([dq, dr]) => ({ q: q + dq, r: r + dr }));
}

interface QueueEntry {
  total: number;
  seat: number;
  hex: string;
}

/** Lowest total first, then lowest seat index, then hex id; the last is only a stable tiebreak. */
function compareEntries(a: QueueEntry, b: QueueEntry): number {
  if (a.total !== b.total) return a.total < b.total ? -1 : 1;
  if (a.seat !== b.seat) return a.seat - b.seat;
  return a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0;
}

function pushHeap(heap: QueueEntry[], entry: QueueEntry): void {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (compareEntries(heap[parent], heap[index]) <= 0) break;
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
}

function popHeap(heap: QueueEntry[]): QueueEntry | undefined {
  const top = heap[0];
  if (top === undefined) return undefined;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && compareEntries(heap[left], heap[smallest]) < 0) smallest = left;
      if (right < heap.length && compareEntries(heap[right], heap[smallest]) < 0) smallest = right;
      if (smallest === index) break;
      [heap[smallest], heap[index]] = [heap[index], heap[smallest]];
      index = smallest;
    }
  }
  return top;
}

export function computePolitics(input: PoliticsInput): ComputedPolitics {
  const { region_name, hexes, settlements } = input;

  const townSeats = settlements.filter((seat) => seat.size === 'town' || seat.size === 'city');
  const seats = townSeats.length > 0 ? townSeats : settlements;

  const byId = new Map(hexes.map((hex) => [hex.id, hex]));
  const isLand = (hex: PoliticsHex | undefined): hex is PoliticsHex =>
    hex !== undefined && hex.terrain !== 'water';

  const dist = new Map<string, number>();
  const owner = new Map<string, number>();
  const heap: QueueEntry[] = [];

  seats.forEach((seat, index) => {
    if (!isLand(byId.get(seat.hex)) || dist.has(seat.hex)) return;
    dist.set(seat.hex, 0);
    owner.set(seat.hex, index);
    pushHeap(heap, { total: 0, seat: index, hex: seat.hex });
  });

  while (heap.length > 0) {
    const entry = popHeap(heap)!;
    if (dist.get(entry.hex) !== entry.total || owner.get(entry.hex) !== entry.seat) continue;
    const hex = byId.get(entry.hex)!;
    const power = SEAT_POWER[seats[entry.seat].size];
    for (const neighbour of hexNeighbours(hex.q, hex.r)) {
      const id = hexId(neighbour.q, neighbour.r);
      const target = byId.get(id);
      if (!isLand(target)) continue;
      const total = entry.total + movementCost(target.terrain) / power;
      const known = dist.get(id);
      const knownOwner = owner.get(id);
      const better =
        known === undefined ||
        total < known - EPSILON ||
        (Math.abs(total - known) <= EPSILON && knownOwner !== undefined && entry.seat < knownOwner);
      if (!better) continue;
      dist.set(id, total);
      owner.set(id, entry.seat);
      pushHeap(heap, { total, seat: entry.seat, hex: id });
    }
  }

  // Land hexes cut off from every seat fall to the seat that is geometrically nearest.
  if (seats.length > 0) {
    for (const hex of hexes) {
      if (!isLand(hex) || dist.has(hex.id)) continue;
      let bestSeat = 0;
      let bestDistance = Infinity;
      seats.forEach((seat, index) => {
        const distance = hexDistance(hex, parseHex(seat.hex));
        if (distance < bestDistance) {
          bestDistance = distance;
          bestSeat = index;
        }
      });
      owner.set(hex.id, bestSeat);
    }
  }

  const counties = seats.map((seat, index) => ({
    name: `County of ${seat.name}`,
    seat_place_id: seat.place_id,
    realm: 0,
    hexes: hexes.filter((hex) => owner.get(hex.id) === index).map((hex) => hex.id),
  }));

  const capitals = seats
    .map((seat, index) => ({ seat, index }))
    .filter(({ seat }) => seat.size === 'city');

  let realms: ComputedPolitics['realms'];
  if (capitals.length === 0) {
    realms = [{ name: region_name, capital_place_id: null }];
  } else {
    realms = capitals.map(({ seat }) => ({
      name: `Kingdom of ${seat.name}`,
      capital_place_id: seat.place_id,
    }));
    counties.forEach((county, index) => {
      const ownRealm = capitals.findIndex((capital) => capital.index === index);
      if (ownRealm !== -1) {
        county.realm = ownRealm;
        return;
      }
      const seatHex = parseHex(seats[index].hex);
      let bestRealm = 0;
      let bestDistance = Infinity;
      capitals.forEach((capital, realmIndex) => {
        const distance = hexDistance(seatHex, parseHex(capital.seat.hex));
        if (distance < bestDistance) {
          bestDistance = distance;
          bestRealm = realmIndex;
        }
      });
      county.realm = bestRealm;
    });
  }

  return { realms, counties };
}

/** The index of the county holding this hex id, or null for water and off-map hexes. */
export function countyOfHex(politics: ComputedPolitics, hex: string): number | null {
  const index = politics.counties.findIndex((county) => county.hexes.includes(hex));
  return index === -1 ? null : index;
}
