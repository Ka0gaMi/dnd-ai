// Duchies, marches and claims over already-computed counties and realms. Pure and deterministic:
// no database, randomness or I/O; everything here is a function of the inputs alone.
import type {
  ComputedClaim,
  ComputedCounties,
  ComputedDuchy,
  ComputedHierarchy,
  ComputedRealms,
  JoinedHow,
  PoliticsInput,
  SeatKind,
} from './politics-types.js';

const SEAT_WEIGHT: Record<SeatKind, number> = { city: 12, town: 4, castle: 2 };
const HARD_FACTOR = 4;
const DEMESNE_NEIGHBOUR_LIMIT = 2;
const DUCHY_SIZE_LIMIT = 5;
const SEAT_HOP_GAP = 2;
const CLAIM_RATIO_LIMIT = 1.15;
const STRONG_RATIO_LIMIT = 1.05;
const MARCH_LAND_SHARE = 0.4;
const AREA_HEX_SHARE = 0.25;
const EPSILON = 1e-9;

interface WeightedEdge {
  to: number;
  weight: number;
  hard: boolean;
  sea: boolean;
}

interface LocalDuchy {
  realm: number;
  seat_county: number;
  seat_place_id: number;
  counties: number[];
  demesne: boolean;
  off_map: boolean;
  removed: boolean;
}

interface DistanceItem {
  distance: number;
  node: number;
}

interface GrowthItem {
  total: number;
  duchy: number;
  county: number;
}

function heapPush<T>(heap: T[], item: T, before: (a: T, b: T) => boolean): void {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!before(heap[index], heap[parent])) break;
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
}

function heapPop<T>(heap: T[], before: (a: T, b: T) => boolean): T | undefined {
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
      if (left < heap.length && before(heap[left], heap[smallest])) smallest = left;
      if (right < heap.length && before(heap[right], heap[smallest])) smallest = right;
      if (smallest === index) break;
      [heap[smallest], heap[index]] = [heap[index], heap[smallest]];
      index = smallest;
    }
  }
  return top;
}

const byDistance = (a: DistanceItem, b: DistanceItem): boolean =>
  a.distance !== b.distance ? a.distance < b.distance : a.node < b.node;

const byGrowth = (a: GrowthItem, b: GrowthItem): boolean =>
  a.total !== b.total
    ? a.total < b.total
    : a.duchy !== b.duchy
      ? a.duchy < b.duchy
      : a.county < b.county;

function buildAdjacency(counties: ComputedCounties): WeightedEdge[][] {
  const adjacency: WeightedEdge[][] = counties.counties.map(() => []);
  for (const edge of counties.edges) {
    const weight = edge.cost * (edge.hard ? HARD_FACTOR : 1);
    adjacency[edge.a].push({ to: edge.b, weight, hard: edge.hard, sea: edge.sea });
    adjacency[edge.b].push({ to: edge.a, weight, hard: edge.hard, sea: edge.sea });
  }
  return adjacency;
}

function dijkstra(adjacency: WeightedEdge[][], source: number, allowed?: Set<number>): number[] {
  const distance = new Array<number>(adjacency.length).fill(Infinity);
  distance[source] = 0;
  const heap: DistanceItem[] = [{ distance: 0, node: source }];
  while (heap.length > 0) {
    const item = heapPop(heap, byDistance)!;
    if (item.distance > distance[item.node] + EPSILON) continue;
    for (const edge of adjacency[item.node]) {
      if (allowed && !allowed.has(edge.to)) continue;
      const total = item.distance + edge.weight;
      if (total < distance[edge.to] - EPSILON) {
        distance[edge.to] = total;
        heapPush(heap, { distance: total, node: edge.to }, byDistance);
      }
    }
  }
  return distance;
}

function hopDistances(adjacency: WeightedEdge[][], sources: number[], allowed: Set<number>): number[] {
  const distance = new Array<number>(adjacency.length).fill(Infinity);
  const queue: number[] = [];
  for (const source of sources) {
    if (distance[source] !== 0) {
      distance[source] = 0;
      queue.push(source);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    for (const edge of adjacency[node]) {
      if (!allowed.has(edge.to) || distance[edge.to] !== Infinity) continue;
      distance[edge.to] = distance[node] + 1;
      queue.push(edge.to);
    }
  }
  return distance;
}

function seatWeight(counties: ComputedCounties, county: number): number {
  return SEAT_WEIGHT[counties.counties[county].seat_kind];
}

/** Highest seat weight, ties settled by the lower place id. */
function bestSeat(counties: ComputedCounties, indexes: number[]): number {
  let best = indexes[0];
  for (const county of indexes) {
    const weight = seatWeight(counties, county);
    const bestWeight = seatWeight(counties, best);
    if (weight > bestWeight) best = county;
    else if (weight === bestWeight && counties.counties[county].seat_place_id < counties.counties[best].seat_place_id) best = county;
  }
  return best;
}

function bySeatRank(counties: ComputedCounties, a: number, b: number): number {
  const weightA = seatWeight(counties, a);
  const weightB = seatWeight(counties, b);
  if (weightA !== weightB) return weightB - weightA;
  return counties.counties[a].seat_place_id - counties.counties[b].seat_place_id;
}

/** The capital plus up to two cheapest neighbouring counties of the same realm. */
function demesneMembers(
  adjacency: WeightedEdge[][],
  countyRealm: number[],
  capitalCounty: number,
  realm: number,
): number[] {
  const cheapest = new Map<number, number>();
  for (const edge of adjacency[capitalCounty]) {
    if (countyRealm[edge.to] !== realm) continue;
    const known = cheapest.get(edge.to);
    if (known === undefined || edge.weight < known) cheapest.set(edge.to, edge.weight);
  }
  const ordered = [...cheapest.entries()]
    .sort((a, b) => (a[1] !== b[1] ? a[1] - b[1] : a[0] - b[0]))
    .slice(0, DEMESNE_NEIGHBOUR_LIMIT)
    .map(([county]) => county);
  return [capitalCounty, ...ordered];
}

function cheapestAdjacentDuchy(
  adjacency: WeightedEdge[][],
  county: number,
  owner: Map<number, number>,
  realmSet: Set<number>,
): number | null {
  let target: number | null = null;
  let bestWeight = Infinity;
  for (const edge of adjacency[county]) {
    if (!realmSet.has(edge.to)) continue;
    const duchy = owner.get(edge.to);
    if (duchy === undefined) continue;
    if (edge.weight < bestWeight - EPSILON) {
      bestWeight = edge.weight;
      target = duchy;
    } else if (Math.abs(edge.weight - bestWeight) <= EPSILON && (target === null || duchy < target)) {
      target = duchy;
    }
  }
  return target;
}

function nearestDuchy(
  adjacency: WeightedEdge[][],
  county: number,
  owner: Map<number, number>,
  realmSet: Set<number>,
): number {
  const distance = dijkstra(adjacency, county, realmSet);
  let target = 0;
  let best = Infinity;
  for (const [node, duchy] of owner) {
    if (!realmSet.has(node)) continue;
    if (distance[node] < best - EPSILON || (Math.abs(distance[node] - best) <= EPSILON && duchy < target)) {
      best = distance[node];
      target = duchy;
    }
  }
  return target;
}

/** Multi-source Dijkstra that stops a duchy at five counties, then folds leftovers into the realm. */
function growDuchies(adjacency: WeightedEdge[][], realmCounties: number[], dukes: LocalDuchy[]): void {
  const realmSet = new Set(realmCounties);
  const owner = new Map<number, number>();
  dukes.forEach((duke, index) => duke.counties.forEach((county) => owner.set(county, index)));

  const heap: GrowthItem[] = [];
  const frontier = (from: number, duchy: number): void => {
    for (const edge of adjacency[from]) {
      if (!realmSet.has(edge.to) || owner.has(edge.to)) continue;
      heapPush(heap, { total: edge.weight, duchy, county: edge.to }, byGrowth);
    }
  };
  dukes.forEach((duke, index) => duke.counties.forEach((county) => frontier(county, index)));

  while (heap.length > 0) {
    const item = heapPop(heap, byGrowth)!;
    if (owner.has(item.county)) continue;
    const duke = dukes[item.duchy];
    if (duke.counties.length >= DUCHY_SIZE_LIMIT) continue;
    owner.set(item.county, item.duchy);
    duke.counties.push(item.county);
    for (const edge of adjacency[item.county]) {
      if (!realmSet.has(edge.to) || owner.has(edge.to)) continue;
      heapPush(heap, { total: item.total + edge.weight, duchy: item.duchy, county: edge.to }, byGrowth);
    }
  }

  for (const county of realmCounties) {
    if (owner.has(county)) continue;
    const target = cheapestAdjacentDuchy(adjacency, county, owner, realmSet) ?? nearestDuchy(adjacency, county, owner, realmSet);
    owner.set(county, target);
    dukes[target].counties.push(county);
  }
}

/** A duchy left with a single county joins its cheapest adjacent duchy of the same realm. */
function mergeSingleCountyDuchies(adjacency: WeightedEdge[][], realmCounties: number[], dukes: LocalDuchy[]): void {
  const realmSet = new Set(realmCounties);
  const ownerOf = (): Map<number, number> => {
    const owner = new Map<number, number>();
    dukes.forEach((duke, index) => {
      if (duke.removed) return;
      duke.counties.forEach((county) => owner.set(county, index));
    });
    return owner;
  };
  for (let index = 0; index < dukes.length; index++) {
    const duke = dukes[index];
    if (duke.removed || duke.demesne || duke.counties.length !== 1) continue;
    const owner = ownerOf();
    const county = duke.counties[0];
    let target = -1;
    let bestWeight = Infinity;
    for (const edge of adjacency[county]) {
      if (!realmSet.has(edge.to)) continue;
      const other = owner.get(edge.to);
      if (other === undefined || other === index) continue;
      if (edge.weight < bestWeight - EPSILON || (Math.abs(edge.weight - bestWeight) <= EPSILON && other < target)) {
        bestWeight = edge.weight;
        target = other;
      }
    }
    if (target === -1) continue;
    dukes[target].counties.push(county);
    duke.counties = [];
    duke.removed = true;
  }
}

/** True when the cheapest edge joining the two county sets is a hard border. */
function cheapestConnectionHard(from: number[], to: Set<number>, adjacency: WeightedEdge[][]): boolean | null {
  let bestWeight = Infinity;
  let hard = false;
  let found = false;
  for (const county of [...from].sort((a, b) => a - b)) {
    for (const edge of adjacency[county]) {
      if (!to.has(edge.to)) continue;
      if (!found || edge.weight < bestWeight - EPSILON) {
        found = true;
        bestWeight = edge.weight;
        hard = edge.hard;
      } else if (Math.abs(edge.weight - bestWeight) <= EPSILON && edge.hard) {
        hard = true;
      }
    }
  }
  return found ? hard : null;
}

/** The input area covering the largest share of the duchy's hexes, if it clears a quarter. */
function dominantArea(
  areas: PoliticsInput['areas'],
  duke: LocalDuchy,
  counties: ComputedCounties,
): string | null {
  const hexes = new Set<string>();
  for (const county of duke.counties) for (const hex of counties.counties[county].hexes) hexes.add(hex);
  if (hexes.size === 0) return null;
  let bestArea: string | null = null;
  let bestCount = 0;
  for (const area of areas) {
    let count = 0;
    for (const hex of area.hexes) if (hexes.has(hex)) count++;
    if (count > bestCount) {
      bestCount = count;
      bestArea = area.name;
    }
  }
  return bestArea !== null && bestCount / hexes.size >= AREA_HEX_SHARE - EPSILON ? bestArea : null;
}

function joinedHow(
  duke: LocalDuchy,
  realmCapitalCounty: number[],
  demesneByRealm: number[][],
  counties: ComputedCounties,
  adjacency: WeightedEdge[][],
): JoinedHow {
  if (duke.off_map || duke.demesne) return 'core';
  const seatKind = counties.counties[duke.seat_county].seat_kind;
  const capitalCounty = realmCapitalCounty[duke.realm];
  if (capitalCounty < 0) return seatKind === 'city' ? 'inheritance' : 'core';
  const capitalComponent = counties.counties[capitalCounty].component;
  if (duke.counties.every((county) => counties.counties[county].component !== capitalComponent)) return 'union';
  const hard = cheapestConnectionHard(duke.counties, new Set(demesneByRealm[duke.realm]), adjacency);
  if (hard === true) return 'conquest';
  return seatKind === 'city' ? 'inheritance' : 'core';
}

export function computeHierarchy(
  input: PoliticsInput,
  counties: ComputedCounties,
  realms: ComputedRealms,
): ComputedHierarchy {
  const countyRealm = realms.county_realm;
  const adjacency = buildAdjacency(counties);

  const countiesByRealm: number[][] = realms.realms.map(() => []);
  countyRealm.forEach((realm, county) => {
    if (realm >= 0 && realm < countiesByRealm.length) countiesByRealm[realm].push(county);
  });

  const realmCapitalCounty = realms.realms.map((realm) => {
    if (realm.off_map || realm.capital_place_id === null) return -1;
    return counties.counties.findIndex((county) => county.seat_place_id === realm.capital_place_id);
  });

  const dukes: LocalDuchy[] = [];
  const demesneByRealm: number[][] = realms.realms.map(() => []);

  for (let realm = 0; realm < realms.realms.length; realm++) {
    const realmCounties = countiesByRealm[realm];
    if (realmCounties.length === 0) continue;

    if (realms.realms[realm].off_map) {
      const seat = bestSeat(counties, realmCounties);
      dukes.push({
        realm,
        seat_county: seat,
        seat_place_id: counties.counties[seat].seat_place_id,
        counties: [...realmCounties],
        demesne: false,
        off_map: true,
        removed: false,
      });
      continue;
    }

    if (realmCounties.length < 4) continue;

    const local: LocalDuchy[] = [];
    const realmSet = new Set(realmCounties);
    const chosenSeats: number[] = [];
    const capitalCounty = realmCapitalCounty[realm];
    if (capitalCounty >= 0) {
      const members = demesneMembers(adjacency, countyRealm, capitalCounty, realm);
      local.push({
        realm,
        seat_county: capitalCounty,
        seat_place_id: counties.counties[capitalCounty].seat_place_id,
        counties: members,
        demesne: true,
        off_map: false,
        removed: false,
      });
      demesneByRealm[realm] = members;
      chosenSeats.push(capitalCounty);
    }

    const assigned = new Set<number>(local.flatMap((duke) => duke.counties));
    const ranked = realmCounties.filter((county) => !assigned.has(county)).sort((a, b) => bySeatRank(counties, a, b));
    for (const candidate of ranked) {
      if (chosenSeats.length > 0) {
        const hops = hopDistances(adjacency, chosenSeats, realmSet)[candidate];
        if (hops < SEAT_HOP_GAP) continue;
      }
      chosenSeats.push(candidate);
      local.push({
        realm,
        seat_county: candidate,
        seat_place_id: counties.counties[candidate].seat_place_id,
        counties: [candidate],
        demesne: false,
        off_map: false,
        removed: false,
      });
    }

    growDuchies(adjacency, realmCounties, local);
    mergeSingleCountyDuchies(adjacency, realmCounties, local);
    for (const duke of local) if (!duke.removed) dukes.push(duke);
  }

  const placeName = new Map<number, string>();
  for (const settlement of input.settlements) placeName.set(settlement.place_id, settlement.name);
  for (const stronghold of input.strongholds) placeName.set(stronghold.place_id, stronghold.name);
  const nameOf = (placeId: number): string => placeName.get(placeId) ?? `place ${placeId}`;

  const used = new Set<string>();
  const duchies: ComputedDuchy[] = [];
  const countyDuchy: Array<number | null> = new Array(counties.counties.length).fill(null);

  for (const duke of dukes) {
    let name: string;
    if (duke.off_map) {
      name = `Duchy of ${input.region_name}`;
    } else if (duke.demesne) {
      name = `Crownlands of ${nameOf(duke.seat_place_id)}`;
    } else {
      const area = dominantArea(input.areas, duke, counties);
      const areaName = area !== null && !used.has(`Duchy of ${area}`) ? `Duchy of ${area}` : null;
      name = areaName ?? `Duchy of ${nameOf(duke.seat_place_id)}`;
    }
    used.add(name);

    const indexes = [...duke.counties].sort((a, b) => a - b);
    const duchyIndex = duchies.length;
    duchies.push({
      name,
      realm: duke.realm,
      seat_place_id: duke.seat_place_id,
      county_indexes: indexes,
      demesne: duke.demesne,
      joined_how: joinedHow(duke, realmCapitalCounty, demesneByRealm, counties, adjacency),
    });
    for (const county of indexes) countyDuchy[county] = duchyIndex;
  }

  const marchCounties: number[] = [];
  for (let county = 0; county < counties.counties.length; county++) {
    const realm = countyRealm[county];
    if (realms.realms[realm]?.kind !== 'kingdom') continue;
    let land = 0;
    let foreign = 0;
    for (const edge of adjacency[county]) {
      if (edge.sea) continue;
      land++;
      if (countyRealm[edge.to] !== realm) foreign++;
    }
    if (land > 0 && foreign / land >= MARCH_LAND_SHARE - EPSILON) marchCounties.push(county);
  }

  const marchSet = new Set(marchCounties);
  const capitalDistance = realms.realms.map((_, realm) =>
    realmCapitalCounty[realm] >= 0 ? dijkstra(adjacency, realmCapitalCounty[realm]) : null,
  );
  const claimLimit = Math.max(1, Math.round(counties.counties.length / 8));
  const claims: ComputedClaim[] = [];

  for (let county = 0; county < counties.counties.length; county++) {
    const ownRealm = countyRealm[county];
    const ownCapital = realmCapitalCounty[ownRealm];
    if (ownCapital === undefined || ownCapital < 0 || county === ownCapital) continue;
    const ownDistance = capitalDistance[ownRealm]![county];
    if (!Number.isFinite(ownDistance) || ownDistance <= EPSILON) continue;

    const candidates: Array<{ realm: number; ratio: number }> = [];
    for (let realm = 0; realm < realms.realms.length; realm++) {
      if (realm === ownRealm) continue;
      const distances = capitalDistance[realm];
      if (distances === null) continue;
      const other = distances[county];
      if (!Number.isFinite(other)) continue;
      const ratio = other / ownDistance;
      if (ratio <= CLAIM_RATIO_LIMIT + EPSILON) candidates.push({ realm, ratio });
    }
    candidates.sort((a, b) => (a.ratio !== b.ratio ? a.ratio - b.ratio : a.realm - b.realm));

    for (const candidate of candidates.slice(0, claimLimit)) {
      const duchy = countyDuchy[county];
      const reason: ComputedClaim['reason'] =
        duchy !== null && duchies[duchy].joined_how === 'conquest'
          ? 'recent conquest'
          : marchSet.has(county)
            ? 'ancient kingdom'
            : counties.counties[county].seat_kind === 'town'
              ? 'inheritance'
              : 'dowry';
      claims.push({
        county,
        claimant_realm: candidate.realm,
        strength: candidate.ratio <= STRONG_RATIO_LIMIT + EPSILON ? 'strong' : 'weak',
        reason,
      });
    }
  }

  return { duchies, county_duchy: countyDuchy, march_counties: marchCounties, claims };
}
