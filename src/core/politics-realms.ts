// Pure, deterministic realm partition over computed counties: kingdoms, free cities, lordships
// and tribes. No database, no randomness, no I/O.
import type {
  ComputedCounties,
  ComputedRealm,
  ComputedRealms,
  CountyEdge,
  PoliticsInput,
  RealmKind,
  SeatKind,
} from './politics-types.js';

/** Realm growth stops once a county's accumulated step cost exceeds this. */
export const BUDGET = 14;

const EPSILON = 1e-9;
const SEA_LINK_MAX = 18;
const COASTAL_FACTOR = 1.25;

const BASE_SEAT_WEIGHT: Record<SeatKind, number> = { city: 12, town: 4, castle: 2 };
const EXPANSIONISM: Record<SeatKind, number> = { city: 1.5, town: 1.2, castle: 1 };

/** Seat strength used for capital, ducal-seat and realm ordering; a port adds a quarter. */
export function seatWeight(kind: SeatKind, population = 0, coastal = false): number {
  const size = kind === 'city' ? population / 4 : kind === 'town' ? population / 8 : 0;
  return (BASE_SEAT_WEIGHT[kind] + size) * (coastal ? COASTAL_FACTOR : 1);
}

/** Traversable weight of a county border; a hard border costs four times as much. */
export function edgeWeight(edge: CountyEdge): number {
  return edge.cost * (edge.hard ? 4 : 1);
}

/** Counties one capital tends to hold for a region's tags: 8 civilized, 2 wild, else 4. */
export function realmDivisor(tags: string[]): number {
  if (tags.includes('civilized') || tags.includes('lawful')) return 8;
  if (tags.includes('wild') || tags.includes('chaotic')) return 2;
  return 4;
}

/** All-pairs shortest paths between counties; Infinity where no edge path exists. */
export function countyDistances(counties: ComputedCounties): number[][] {
  const total = counties.counties.length;
  const adjacency: Array<Array<{ to: number; weight: number }>> = Array.from(
    { length: total },
    () => [],
  );
  for (const edge of counties.edges) {
    const weight = edgeWeight(edge);
    adjacency[edge.a].push({ to: edge.b, weight });
    adjacency[edge.b].push({ to: edge.a, weight });
  }
  const all: number[][] = [];
  for (let source = 0; source < total; source += 1) {
    const distance = new Array<number>(total).fill(Infinity);
    const visited = new Array<boolean>(total).fill(false);
    distance[source] = 0;
    for (;;) {
      let current = -1;
      let best = Infinity;
      for (let i = 0; i < total; i += 1) {
        if (!visited[i] && distance[i] < best) {
          best = distance[i];
          current = i;
        }
      }
      if (current === -1) break;
      visited[current] = true;
      for (const { to, weight } of adjacency[current]) {
        const next = distance[current] + weight;
        if (next < distance[to] - EPSILON) distance[to] = next;
      }
    }
    all.push(distance);
  }
  return all;
}

interface RealmRecord {
  kind: RealmKind;
  capitalCounty: number | null;
  capitalPlaceId: number | null;
  offMap: boolean;
  liege: number | null;
  counties: number[];
  /** A tiny kingdom whose capital is a city, named a principality rather than a lordship. */
  principality: boolean;
}

interface QueueEntry {
  total: number;
  realm: number;
  county: number;
}

const REGION_PREFIX = /^(?:kingdom of |realm of |lands of |land of |duchy of |the )/i;

/** Region name with one leading realm word removed, so "Kingdom Of Pank" becomes "Pank". */
function beyondRegion(region: string): string {
  return region.replace(REGION_PREFIX, '');
}

function realmName(realm: RealmRecord, capitalName: string, region: string): string {
  switch (realm.kind) {
    case 'kingdom':
      return realm.offMap ? `The Kingdom beyond ${beyondRegion(region)}` : `Kingdom of ${capitalName}`;
    case 'free_city':
      return `Free City of ${capitalName}`;
    case 'lordship':
      return realm.principality ? `Principality of ${capitalName}` : `Lordship of ${capitalName}`;
    case 'tribe':
      return `The ${capitalName} Clans`;
  }
}

/**
 * Decide realms for a region from its counties: capitals are seeded per land component, grown by
 * budgeted Dijkstra, and the leftovers become free cities, lordships or tribes.
 */
export function computeRealms(input: PoliticsInput, counties: ComputedCounties): ComputedRealms {
  const countyList = counties.counties;
  const total = countyList.length;
  if (total === 0) return { realms: [], county_realm: [] };

  const names = new Map<number, string>();
  const coasts = new Map<number, boolean>();
  const populations = new Map<number, number>();
  for (const settlement of input.settlements) {
    names.set(settlement.place_id, settlement.name);
    coasts.set(settlement.place_id, settlement.coast);
    if (settlement.population !== undefined) populations.set(settlement.place_id, settlement.population);
  }

  const chaotic = input.tags.includes('wild') || input.tags.includes('chaotic');
  const landHexes = input.hexes.filter((hex) => hex.terrain !== 'water').length;
  const hasCity = input.settlements.some((settlement) => settlement.size === 'city');
  if (landHexes < 400 && !hasCity && !chaotic) {
    return {
      realms: [
        {
          name: `The Kingdom beyond ${beyondRegion(input.region_name)}`,
          kind: 'kingdom',
          capital_place_id: null,
          off_map: true,
          liege: null,
        },
      ],
      county_realm: new Array<number>(total).fill(0),
    };
  }

  const distance = countyDistances(counties);
  const divisor = realmDivisor(input.tags);

  const adjacency: CountyEdge[][] = Array.from({ length: total }, () => []);
  for (const edge of counties.edges) {
    adjacency[edge.a].push(edge);
    adjacency[edge.b].push(edge);
  }
  const neighbourOf = (edge: CountyEdge, county: number): number =>
    edge.a === county ? edge.b : edge.a;

  const realms: RealmRecord[] = [];
  const assigned: Array<number | null> = new Array<number | null>(total).fill(null);

  const byComponent = new Map<number, number[]>();
  countyList.forEach((county, index) => {
    const members = byComponent.get(county.component);
    if (members) members.push(index);
    else byComponent.set(county.component, [index]);
  });
  const componentSize = new Map<number, number>();
  for (const [key, members] of byComponent) componentSize.set(key, members.length);
  const components = [...byComponent.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0] - b[0],
  );

  const placeName = (county: number): string =>
    names.get(countyList[county].seat_place_id) ?? countyList[county].name;

  const componentMaxDistance = (members: number[]): number => {
    let max = 0;
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const d = distance[members[i]][members[j]];
        if (Number.isFinite(d) && d > max) max = d;
      }
    }
    return max;
  };

  const weightOf = (county: number): number => {
    const place = countyList[county].seat_place_id;
    return seatWeight(
      countyList[county].seat_kind,
      populations.get(place) ?? 0,
      coasts.get(place) === true,
    );
  };

  const scoreSeat = (county: number, members: number[]): number => {
    let sum = 0;
    let count = 0;
    for (const other of members) {
      if (other === county) continue;
      const d = distance[county][other];
      if (Number.isFinite(d)) {
        sum += d;
        count += 1;
      }
    }
    const mean = count === 0 ? (members.length > 1 ? Infinity : 0) : sum / count;
    return weightOf(county) * (1 / (1 + mean));
  };

  const rankSeats = (members: number[]): number[] =>
    [...members].sort((a, b) => scoreSeat(b, members) - scoreSeat(a, members) || a - b);

  const pickCapitals = (members: number[]): number[] => {
    const cityCount = members.filter((index) => countyList[index].seat_kind === 'city').length;
    const wanted = Math.min(Math.max(Math.round(members.length / divisor), 1), cityCount + 1);
    const chosen: number[] = [rankSeats(members)[0]];
    let threshold = componentMaxDistance(members) / wanted;
    while (chosen.length < wanted && chosen.length < members.length) {
      const remaining = rankSeats(members.filter((index) => !chosen.includes(index)));
      let pick: number | undefined;
      for (const county of remaining) {
        if (chosen.every((capital) => distance[county][capital] >= threshold - EPSILON)) {
          pick = county;
          break;
        }
      }
      if (pick === undefined) {
        if (threshold <= EPSILON) pick = remaining[0];
        else {
          threshold *= 0.9;
          continue;
        }
      }
      chosen.push(pick!);
    }
    return chosen;
  };

  const grow = (capitals: number[], realmIndexes: number[], cap: number): Map<number, number> => {
    const queue: QueueEntry[] = [];
    capitals.forEach((county, i) => queue.push({ total: 0, realm: realmIndexes[i], county }));
    const claimed = new Map<number, number>();
    const counts = new Map<number, number>();
    while (queue.length > 0) {
      let best = 0;
      for (let i = 1; i < queue.length; i += 1) {
        const a = queue[i];
        const b = queue[best];
        if (a.total < b.total - EPSILON || (Math.abs(a.total - b.total) <= EPSILON && a.realm < b.realm)) {
          best = i;
        }
      }
      const entry = queue.splice(best, 1)[0];
      if (entry.total > BUDGET + EPSILON) break;
      if (claimed.has(entry.county)) continue;
      if ((counts.get(entry.realm) ?? 0) >= cap) continue;
      claimed.set(entry.county, entry.realm);
      counts.set(entry.realm, (counts.get(entry.realm) ?? 0) + 1);
      const capital = realms[entry.realm].capitalCounty!;
      const expansion = EXPANSIONISM[countyList[capital].seat_kind];
      for (const edge of adjacency[entry.county]) {
        const neighbour = neighbourOf(edge, entry.county);
        if (claimed.has(neighbour)) continue;
        const next = entry.total + edgeWeight(edge) / expansion;
        if (next > BUDGET + EPSILON) continue;
        queue.push({ total: next, realm: entry.realm, county: neighbour });
      }
    }
    return claimed;
  };

  const clusters = (candidates: number[]): number[][] => {
    const inSet = new Set(candidates);
    const seen = new Set<number>();
    const result: number[][] = [];
    for (const start of candidates) {
      if (seen.has(start)) continue;
      const stack = [start];
      seen.add(start);
      const cluster: number[] = [];
      while (stack.length > 0) {
        const county = stack.pop()!;
        cluster.push(county);
        for (const edge of adjacency[county]) {
          const neighbour = neighbourOf(edge, county);
          if (!inSet.has(neighbour) || seen.has(neighbour)) continue;
          seen.add(neighbour);
          stack.push(neighbour);
        }
      }
      result.push(cluster.sort((a, b) => a - b));
    }
    return result;
  };

  for (const [, members] of components) {
    if (members.length <= 2) {
      const memberSet = new Set(members);
      let peer: number | null = null;
      let peerCost = Infinity;
      for (const edge of counties.edges) {
        if (!edge.sea || edge.cost > SEA_LINK_MAX + EPSILON) continue;
        const aIn = memberSet.has(edge.a);
        if (aIn === memberSet.has(edge.b)) continue;
        const candidate = aIn ? edge.b : edge.a;
        const candidateComponent = countyList[candidate].component;
        if ((componentSize.get(candidateComponent) ?? 0) <= members.length) continue;
        if (assigned[candidate] === null) continue;
        if (
          peer === null ||
          edge.cost < peerCost - EPSILON ||
          (Math.abs(edge.cost - peerCost) <= EPSILON && candidate < peer)
        ) {
          peer = candidate;
          peerCost = edge.cost;
        }
      }
      if (peer !== null) {
        const realm = assigned[peer]!;
        for (const county of members) {
          assigned[county] = realm;
          realms[realm].counties.push(county);
        }
        continue;
      }
    }

    const capitals = pickCapitals(members);
    const realmIndexes = capitals.map((county) => {
      realms.push({
        kind: 'kingdom',
        capitalCounty: county,
        capitalPlaceId: countyList[county].seat_place_id,
        offMap: false,
        liege: null,
        counties: [],
        principality: false,
      });
      return realms.length - 1;
    });
    // Each realm may take at most this many counties; the rest stay available to its peers.
    const cap = Math.ceil((members.length / capitals.length) * 1.6);
    const claimed = grow(capitals, realmIndexes, cap);
    for (const [county, realm] of claimed) {
      assigned[county] = realm;
      realms[realm].counties.push(county);
    }

    const unreached = members.filter((county) => assigned[county] === null);
    const cities = unreached.filter((county) => countyList[county].seat_kind === 'city');
    const rest = unreached.filter((county) => countyList[county].seat_kind !== 'city');
    for (const county of cities) {
      const realm = realms.length;
      realms.push({
        kind: 'free_city',
        capitalCounty: county,
        capitalPlaceId: countyList[county].seat_place_id,
        offMap: false,
        liege: null,
        counties: [county],
        principality: false,
      });
      assigned[county] = realm;
    }
    if (chaotic) {
      for (const cluster of clusters(rest)) {
        const capital = cluster.reduce((best, county) =>
          weightOf(county) > weightOf(best) ? county : best,
        );
        const realm = realms.length;
        realms.push({
          kind: 'tribe',
          capitalCounty: capital,
          capitalPlaceId: countyList[capital].seat_place_id,
          offMap: false,
          liege: null,
          counties: [...cluster],
          principality: false,
        });
        for (const county of cluster) assigned[county] = realm;
      }
    } else {
      for (const county of rest) {
        const realm = realms.length;
        realms.push({
          kind: 'lordship',
          capitalCounty: county,
          capitalPlaceId: countyList[county].seat_place_id,
          offMap: false,
          liege: null,
          counties: [county],
          principality: false,
        });
        assigned[county] = realm;
      }
    }
  }

  // A kingdom too small to stand on its own is downgraded so the vassal rule below can fold it in.
  for (const realm of realms) {
    if (realm.kind !== 'kingdom' || realm.offMap || realm.counties.length >= 3) continue;
    realm.kind = 'lordship';
    realm.principality =
      realm.capitalCounty !== null && countyList[realm.capitalCounty].seat_kind === 'city';
  }

  const realmCount = realms.map((realm) => realm.counties.length);
  const neighbours: Array<Set<number>> = realms.map(() => new Set<number>());
  for (const edge of counties.edges) {
    const a = assigned[edge.a]!;
    const b = assigned[edge.b]!;
    if (a === b) continue;
    neighbours[a].add(b);
    neighbours[b].add(a);
  }
  realms.forEach((realm, index) => {
    const size = realmCount[index];
    if (size > 2) return;
    if (realm.kind === 'free_city' && neighbours[index].size >= 2) return;
    let liege: number | null = null;
    for (const neighbour of neighbours[index]) {
      if (realmCount[neighbour] <= 2 * size) continue;
      if (
        liege === null ||
        realmCount[neighbour] > realmCount[liege] ||
        (realmCount[neighbour] === realmCount[liege] && neighbour < liege)
      ) {
        liege = neighbour;
      }
    }
    realm.liege = liege;
  });

  const order = realms.map((_, index) => index).sort((a, b) => {
    const weightA =
      realms[a].capitalCounty === null ? 0 : weightOf(realms[a].capitalCounty!);
    const weightB =
      realms[b].capitalCounty === null ? 0 : weightOf(realms[b].capitalCounty!);
    if (weightA !== weightB) return weightB - weightA;
    return (realms[a].capitalPlaceId ?? -1) - (realms[b].capitalPlaceId ?? -1);
  });
  const remap = new Array<number>(realms.length);
  order.forEach((oldIndex, newIndex) => {
    remap[oldIndex] = newIndex;
  });

  const finalRealms: ComputedRealm[] = order.map((oldIndex) => {
    const realm = realms[oldIndex];
    const capitalName = realm.capitalCounty === null ? '' : placeName(realm.capitalCounty);
    return {
      name: realmName(realm, capitalName, input.region_name),
      kind: realm.kind,
      capital_place_id: realm.capitalPlaceId,
      off_map: realm.offMap,
      liege: realm.liege === null ? null : remap[realm.liege],
    };
  });

  return {
    realms: finalRealms,
    county_realm: assigned.map((realm) => remap[realm!]),
  };
}
