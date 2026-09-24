// Pure county partition of a region: land components, town and city seats grown by multi-source
// Dijkstra within a day's ride, castle lordships on leftover patches, and the county graph.
import { hexDistance, parseHex } from './region-graph.js';
import { hexNeighbours } from './politics.js';
import type {
  ComputedCounties,
  ComputedCounty,
  CountyEdge,
  PoliticsInput,
  PoliticsSettlement,
  SeatKind,
} from './politics-types.js';

/** A day's ride, in movement-cost units; seats claim only land within this. */
export const RIDE = 5;

/** Seat strength: a city reaches further than a town, a lone lord least of all. */
export const SEAT_POWER: Record<SeatKind, number> = { city: 1.6, town: 1.3, castle: 1 };

const EPSILON = 1e-9;

const MOVEMENT_COST: Record<string, number> = {
  plains: 1,
  'forest-light': 1.5,
  'forest-dark': 2,
  rocks: 2.5,
  swamp: 3,
  mountain: 4,
};

const movementCost = (terrain: string): number => MOVEMENT_COST[terrain] ?? 1;

const hexId = (q: number, r: number): string => `q${q}_r${r}`;

const smallestHex = (hexes: string[]): string => hexes.reduce((a, b) => (a < b ? a : b));

interface Seat {
  place_id: number;
  name: string;
  hex: string;
  kind: SeatKind;
  power: number;
  coast: boolean;
}

interface QueueEntry {
  total: number;
  seat: number;
  hex: string;
}

interface Growth {
  dist: Map<string, number>;
  owner: Map<string, number>;
}

interface Movement {
  neighbours: Map<string, string[]>;
  isLand: (id: string) => boolean;
  isHard: (id: string) => boolean;
  enterCost: (from: string, to: string) => number;
  grow: (seats: Seat[]) => Growth;
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

/** The movement graph: land neighbours, road-halved entering costs, and a multi-source Dijkstra. */
function buildMovement(input: PoliticsInput): Movement {
  const byId = new Map(input.hexes.map((hex) => [hex.id, hex]));
  const isLand = (id: string): boolean => {
    const hex = byId.get(id);
    return hex !== undefined && hex.terrain !== 'water';
  };

  const neighbours = new Map<string, string[]>();
  for (const hex of input.hexes) {
    if (hex.terrain === 'water') continue;
    const list: string[] = [];
    for (const step of hexNeighbours(hex.q, hex.r)) {
      const id = hexId(step.q, step.r);
      if (isLand(id)) list.push(id);
    }
    neighbours.set(hex.id, list);
  }

  const roadsOn = new Map<string, Set<number>>();
  input.roads.forEach((road, index) => {
    for (const id of road) {
      const set = roadsOn.get(id) ?? new Set<number>();
      set.add(index);
      roadsOn.set(id, set);
    }
  });
  const sameRoad = (a: string, b: string): boolean => {
    const from = roadsOn.get(a);
    const to = roadsOn.get(b);
    if (!from || !to) return false;
    for (const road of from) if (to.has(road)) return true;
    return false;
  };

  const enterCost = (from: string, to: string): number => {
    const target = byId.get(to);
    if (target === undefined) return 1;
    return movementCost(target.terrain) * (sameRoad(from, to) ? 0.5 : 1);
  };

  const isHard = (id: string): boolean => {
    const terrain = byId.get(id)?.terrain;
    return terrain === 'mountain' || terrain === 'swamp';
  };

  const grow = (seats: Seat[]): Growth => {
    const dist = new Map<string, number>();
    const owner = new Map<string, number>();
    const heap: QueueEntry[] = [];

    seats.forEach((seat, index) => {
      if (!isLand(seat.hex)) return;
      const known = dist.get(seat.hex);
      if (known !== undefined && known <= 0) return;
      dist.set(seat.hex, 0);
      owner.set(seat.hex, index);
      pushHeap(heap, { total: 0, seat: index, hex: seat.hex });
    });

    while (heap.length > 0) {
      const entry = popHeap(heap)!;
      if (dist.get(entry.hex) !== entry.total || owner.get(entry.hex) !== entry.seat) continue;
      const power = seats[entry.seat].power;
      for (const id of neighbours.get(entry.hex) ?? []) {
        const total = entry.total + enterCost(entry.hex, id) / power;
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
    return { dist, owner };
  };

  return { neighbours, isLand, isHard, enterCost, grow };
}

/** Min movement cost from one seat to every reachable land hex, for that seat's power. */
export function travelCosts(input: PoliticsInput, seatHex: string, power: number): Map<string, number> {
  const seat: Seat = { place_id: 0, name: '', hex: seatHex, kind: 'castle', power, coast: false };
  return buildMovement(input).grow([seat]).dist;
}

function landComponents(move: Movement, input: PoliticsInput): { groups: string[][]; of: Map<string, number> } {
  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const hex of input.hexes) {
    if (hex.terrain === 'water' || seen.has(hex.id)) continue;
    const group: string[] = [];
    const stack = [hex.id];
    seen.add(hex.id);
    while (stack.length > 0) {
      const current = stack.pop()!;
      group.push(current);
      for (const neighbour of move.neighbours.get(current) ?? []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        stack.push(neighbour);
      }
    }
    groups.push(group);
  }
  groups.sort((a, b) => {
    const ma = smallestHex(a);
    const mb = smallestHex(b);
    return ma < mb ? -1 : ma > mb ? 1 : 0;
  });
  const of = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const id of group) of.set(id, index);
  });
  return { groups, of };
}

/** Connected patches of land no seat has claimed, ordered by each patch's smallest hex id. */
function unclaimedPatches(move: Movement, input: PoliticsInput, claimed: Set<string>): string[][] {
  const patches: string[][] = [];
  const seen = new Set<string>();
  for (const hex of input.hexes) {
    if (hex.terrain === 'water' || claimed.has(hex.id) || seen.has(hex.id)) continue;
    const patch: string[] = [];
    const stack = [hex.id];
    seen.add(hex.id);
    while (stack.length > 0) {
      const current = stack.pop()!;
      patch.push(current);
      for (const neighbour of move.neighbours.get(current) ?? []) {
        if (claimed.has(neighbour) || seen.has(neighbour)) continue;
        seen.add(neighbour);
        stack.push(neighbour);
      }
    }
    patches.push(patch);
  }
  patches.sort((a, b) => {
    const ma = smallestHex(a);
    const mb = smallestHex(b);
    return ma < mb ? -1 : ma > mb ? 1 : 0;
  });
  return patches;
}

const castleSeat = (place_id: number, name: string, hex: string): Seat => ({
  place_id,
  name,
  hex,
  kind: 'castle',
  power: SEAT_POWER.castle,
  coast: false,
});

/** The village inside a patch that would claim the most of it within a ride; ties go to the lower id. */
function largestVillage(move: Movement, villages: PoliticsSettlement[], patch: Set<string>): Seat | undefined {
  let best: PoliticsSettlement | undefined;
  let bestCount = -1;
  for (const village of villages) {
    const { dist } = move.grow([castleSeat(village.place_id, village.name, village.hex)]);
    let count = 0;
    for (const id of patch) if ((dist.get(id) ?? Infinity) <= RIDE + EPSILON) count++;
    if (count > bestCount) {
      bestCount = count;
      best = village;
    }
  }
  return best === undefined ? undefined : castleSeat(best.place_id, best.name, best.hex);
}

/** A stronghold in the patch if there is one, else its most-reaching village, else nothing. */
function chooseCastleSeat(
  move: Movement,
  input: PoliticsInput,
  patch: Set<string>,
): Seat | undefined {
  const stronghold = input.strongholds
    .filter((place) => patch.has(place.hex) && move.isLand(place.hex))
    .sort((a, b) => a.place_id - b.place_id)[0];
  if (stronghold !== undefined) return castleSeat(stronghold.place_id, stronghold.name, stronghold.hex);

  const villages = input.settlements
    .filter((place) => place.size === 'village' && patch.has(place.hex) && move.isLand(place.hex))
    .sort((a, b) => a.place_id - b.place_id);
  if (villages.length === 0) return undefined;
  return largestVillage(move, villages, patch);
}

function borderPairs(neighbours: Map<string, string[]>, a: Set<string>, b: Set<string>): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const id of a) {
    for (const neighbour of neighbours.get(id) ?? []) {
      if (b.has(neighbour)) pairs.push([id, neighbour]);
    }
  }
  return pairs;
}

/** One edge per pair of bordering counties, plus sea lanes between coastal seats without a land border. */
function computeEdges(
  counties: ComputedCounty[],
  seats: Seat[],
  move: Movement,
): CountyEdge[] {
  const hexCounty = new Map<string, number>();
  counties.forEach((county, index) => {
    for (const id of county.hexes) hexCounty.set(id, index);
  });

  const borders = new Map<string, Array<[string, string]>>();
  for (let index = 0; index < counties.length; index++) {
    for (const id of counties[index].hexes) {
      for (const neighbour of move.neighbours.get(id) ?? []) {
        const other = hexCounty.get(neighbour);
        if (other === undefined || other === index) continue;
        const a = Math.min(index, other);
        const b = Math.max(index, other);
        const key = `${a}_${b}`;
        const list = borders.get(key) ?? [];
        list.push(index === a ? [id, neighbour] : [neighbour, id]);
        borders.set(key, list);
      }
    }
  }

  const edges: CountyEdge[] = [];
  const keys = [...borders.keys()].sort((x, y) => {
    const [ax, bx] = x.split('_').map(Number);
    const [ay, by] = y.split('_').map(Number);
    return ax - ay || bx - by;
  });
  for (const key of keys) {
    const pairs = borders.get(key)!;
    const [a, b] = key.split('_').map(Number);
    let sum = 0;
    let hardCount = 0;
    for (const [from, to] of pairs) {
      sum += (move.enterCost(from, to) + move.enterCost(to, from)) / 2;
      if (move.isHard(from) || move.isHard(to)) hardCount++;
    }
    edges.push({ a, b, cost: sum / pairs.length, hard: hardCount * 2 >= pairs.length, sea: false });
  }

  for (let i = 0; i < counties.length; i++) {
    for (let j = i + 1; j < counties.length; j++) {
      if (borders.has(`${i}_${j}`)) continue;
      const from = seats[i];
      const to = seats[j];
      if (from.kind === 'castle' || to.kind === 'castle' || !from.coast || !to.coast) continue;
      const distance = hexDistance(parseHex(from.hex), parseHex(to.hex));
      if (distance > 12) continue;
      edges.push({ a: i, b: j, cost: 1.5 * distance, sea: true, hard: false });
    }
  }

  edges.sort((x, y) => x.a - y.a || x.b - y.b || (x.sea ? 1 : 0) - (y.sea ? 1 : 0));
  return edges;
}

/** Grows realistic counties: seats within a day's ride, castle lordships on leftovers, then the graph. */
export function computeCounties(input: PoliticsInput): ComputedCounties {
  const move = buildMovement(input);
  const { groups, of: componentOf } = landComponents(move, input);

  const seats: Seat[] = input.settlements
    .filter((place): place is PoliticsSettlement & { size: 'town' | 'city' } =>
      (place.size === 'town' || place.size === 'city') && move.isLand(place.hex),
    )
    .sort((a, b) => a.place_id - b.place_id)
    .map((place) => ({
      place_id: place.place_id,
      name: place.name,
      hex: place.hex,
      kind: place.size,
      power: SEAT_POWER[place.size],
      coast: place.coast,
    }));

  // Castle lordships: while a large patch is unclaimed, seat it at a stronghold, else its best village.
  while (true) {
    const { dist } = move.grow(seats);
    const claimed = new Set<string>();
    for (const hex of input.hexes) {
      if (hex.terrain !== 'water' && (dist.get(hex.id) ?? Infinity) <= RIDE + EPSILON) claimed.add(hex.id);
    }
    const fresh: Seat[] = [];
    for (const patch of unclaimedPatches(move, input, claimed)) {
      if (patch.length < 8) continue;
      const seat = chooseCastleSeat(move, input, new Set(patch));
      if (seat !== undefined) fresh.push(seat);
    }
    if (fresh.length === 0) break;
    seats.push(...fresh);
  }

  // A component with villages but no seat at all still gets one, so its land is not left unassigned.
  const seated = new Set(seats.map((seat) => componentOf.get(seat.hex)).filter((index) => index !== undefined));
  for (let index = 0; index < groups.length; index++) {
    if (seated.has(index)) continue;
    const group = new Set(groups[index]);
    const villages = input.settlements
      .filter((place) => place.size === 'village' && group.has(place.hex) && move.isLand(place.hex))
      .sort((a, b) => a.place_id - b.place_id);
    if (villages.length === 0) continue;
    const seat = largestVillage(move, villages, group);
    if (seat !== undefined) seats.push(seat);
  }

  const { owner } = move.grow(seats);
  const seatedComponents = new Set<number>();
  for (const seat of seats) {
    const component = componentOf.get(seat.hex);
    if (component !== undefined) seatedComponents.add(component);
  }

  const hexesOf: Array<Set<string>> = seats.map(() => new Set<string>());
  for (const hex of input.hexes) {
    if (hex.terrain === 'water') continue;
    const component = componentOf.get(hex.id);
    if (component === undefined || !seatedComponents.has(component)) continue;
    const seatIndex = owner.get(hex.id);
    if (seatIndex === undefined) continue;
    hexesOf[seatIndex].add(hex.id);
  }

  // Villages are known before merging so a small, village-less lordship can be spotted and absorbed.
  const seatIds = new Set(seats.map((seat) => seat.place_id));
  const villagesIn = (index: number): number[] =>
    input.settlements
      .filter((place) => place.size === 'village' && !seatIds.has(place.place_id) && hexesOf[index].has(place.hex))
      .map((place) => place.place_id);

  const removed = new Set<number>();
  for (let index = 0; index < seats.length; index++) {
    if (removed.has(index) || seats[index].kind !== 'castle') continue;
    if (hexesOf[index].size >= 6 || villagesIn(index).length > 0) continue;
    let target = -1;
    let longest = 0;
    for (let other = 0; other < seats.length; other++) {
      if (other === index || removed.has(other)) continue;
      const length = borderPairs(move.neighbours, hexesOf[index], hexesOf[other]).length;
      if (length > longest) {
        longest = length;
        target = other;
      }
    }
    if (target === -1) continue;
    for (const id of hexesOf[index]) hexesOf[target].add(id);
    removed.add(index);
  }

  const kept = seats.map((seat, index) => ({ seat, index })).filter(({ index }) => !removed.has(index));
  const finalSeats = kept.map(({ seat }) => seat);
  const counties: ComputedCounty[] = kept.map(({ seat, index }) => ({
    name: seat.kind === 'castle' ? `Lordship of ${seat.name}` : `County of ${seat.name}`,
    seat_place_id: seat.place_id,
    seat_kind: seat.kind,
    hexes: [...hexesOf[index]].sort(),
    village_place_ids: [],
    component: componentOf.get(seat.hex) ?? -1,
  }));

  const finalSeatIds = new Set(finalSeats.map((seat) => seat.place_id));
  const hexToCounty = new Map<string, number>();
  counties.forEach((county, index) => {
    for (const id of county.hexes) hexToCounty.set(id, index);
  });
  for (const place of input.settlements) {
    if (place.size !== 'village' || finalSeatIds.has(place.place_id)) continue;
    const index = hexToCounty.get(place.hex);
    if (index === undefined) continue;
    counties[index].village_place_ids.push(place.place_id);
  }
  for (const county of counties) county.village_place_ids.sort((a, b) => a - b);

  return { counties, edges: computeEdges(counties, finalSeats, move) };
}
