// Pure, deterministic tribal layer: wilderness no county claims becomes tribal land, and rough
// frontier country far from towns is carved into tribal territory. No randomness, no database.
import { hexNeighbours } from './politics.js';
import { RIDE, travelCosts } from './politics-counties.js';
import type {
  ComputedCounties,
  ComputedRealm,
  ComputedRealms,
  ComputedTribalLand,
  PoliticsHex,
  PoliticsInput,
} from './politics-types.js';

export interface ComputedTribes {
  realms: ComputedRealm[];
  lands: ComputedTribalLand[];
  carved: Array<{ county: number; hexes: string[] }>;
}

const EPSILON = 1e-9;
const WILD_MIN = 10;
const FRONTIER_MIN = 12;
const ROUGH_SHARE = 0.6;
const FAR_SHARE = 0.6;
const FAR_FACTOR = 0.8;
const MIN_COUNTY = 6;
const AREA_SHARE = 0.4;

const ROUGH = new Set(['forest-dark', 'swamp', 'mountain', 'rocks']);

type TerrainClass = 'forest' | 'swamp' | 'mountain' | 'rocks' | 'plains';

const TERRAIN_ORDER: TerrainClass[] = ['forest', 'swamp', 'mountain', 'rocks', 'plains'];

const BASE_NAME: Record<TerrainClass, string> = {
  forest: 'The Forest Tribes',
  swamp: 'The Marsh Folk',
  mountain: 'The Hill Clans',
  rocks: 'The Hill Clans',
  plains: 'The Plains Riders',
};

const hexId = (q: number, r: number): string => `q${q}_r${r}`;

const smallest = (hexes: string[]): string => hexes.reduce((a, b) => (a < b ? a : b));

function terrainClass(terrain: string): TerrainClass {
  if (terrain === 'forest-dark' || terrain === 'forest-light') return 'forest';
  if (terrain === 'swamp') return 'swamp';
  if (terrain === 'mountain') return 'mountain';
  if (terrain === 'rocks') return 'rocks';
  return 'plains';
}

/** The most common terrain class, ties resolved by a fixed class order so names stay stable. */
function dominantClass(hexes: string[], byId: Map<string, PoliticsHex>): TerrainClass {
  const counts = new Map<TerrainClass, number>();
  for (const id of hexes) {
    const cls = terrainClass(byId.get(id)?.terrain ?? 'plains');
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  let best: TerrainClass = 'plains';
  let bestCount = -1;
  for (const cls of TERRAIN_ORDER) {
    const count = counts.get(cls) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = cls;
    }
  }
  return best;
}

/** Land components (islands) of the region, ordered by each component's smallest hex id. */
function landComponents(
  input: PoliticsInput,
  byId: Map<string, PoliticsHex>,
): { groups: string[][]; of: Map<string, number> } {
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
      const cell = byId.get(current)!;
      for (const step of hexNeighbours(cell.q, cell.r)) {
        const id = hexId(step.q, step.r);
        const target = byId.get(id);
        if (target === undefined || target.terrain === 'water' || seen.has(id)) continue;
        seen.add(id);
        stack.push(id);
      }
    }
    groups.push(group);
  }
  groups.sort((a, b) => {
    const ma = smallest(a);
    const mb = smallest(b);
    return ma < mb ? -1 : ma > mb ? 1 : 0;
  });
  const of = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const id of group) of.set(id, index);
  });
  return { groups, of };
}

/** Connected land patches no county claims, ordered by each patch's smallest hex id. */
function wildPatches(
  input: PoliticsInput,
  byId: Map<string, PoliticsHex>,
  claimed: Set<string>,
): string[][] {
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
      const cell = byId.get(current)!;
      for (const step of hexNeighbours(cell.q, cell.r)) {
        const id = hexId(step.q, step.r);
        const target = byId.get(id);
        if (target === undefined || target.terrain === 'water' || claimed.has(id) || seen.has(id)) {
          continue;
        }
        seen.add(id);
        stack.push(id);
      }
    }
    patches.push(patch);
  }
  patches.sort((a, b) => {
    const ma = smallest(a);
    const mb = smallest(b);
    return ma < mb ? -1 : ma > mb ? 1 : 0;
  });
  return patches;
}

/** Frontier peoples allowed by a region's tags: one civilized, three wild, two neutral. */
function frontierCap(tags: string[]): number {
  if (tags.includes('civilized') || tags.includes('lawful')) return 1;
  if (tags.includes('wild') || tags.includes('chaotic')) return 3;
  return 2;
}

function share(hexes: string[], predicate: (id: string) => boolean): number {
  if (hexes.length === 0) return 0;
  let count = 0;
  for (const id of hexes) if (predicate(id)) count += 1;
  return count / hexes.length;
}

/**
 * Places tribes on a map: unclaimed wilderness patches become wild lands, rough far country
 * inside settled counties is carved into frontier lands, and adjacent lands join one people.
 */
export function computeTribes(
  input: PoliticsInput,
  counties: ComputedCounties,
  realms: ComputedRealms,
): ComputedTribes {
  const byId = new Map(input.hexes.map((hex) => [hex.id, hex]));
  const components = landComponents(input, byId);
  const combined: ComputedRealm[] = [...realms.realms];
  const lands: ComputedTribalLand[] = [];
  const carvedByCounty = new Map<number, string[]>();
  const taken = new Set<string>();

  const countyOfHex = new Map<string, number>();
  const remaining: number[] = [];
  const tribeHex = new Map<string, number>();
  counties.counties.forEach((county, index) => {
    remaining[index] = county.hexes.length;
    const realm = realms.county_realm[index];
    for (const id of county.hexes) {
      countyOfHex.set(id, index);
      if (realm !== undefined && combined[realm]?.kind === 'tribe') tribeHex.set(id, realm);
    }
  });

  const neighbourIds = (id: string): string[] => {
    const cell = byId.get(id);
    if (cell === undefined) return [];
    return hexNeighbours(cell.q, cell.r).map((step) => hexId(step.q, step.r));
  };

  const adjacentTribe = (hexes: string[]): number | null => {
    let best: number | null = null;
    for (const id of hexes) {
      for (const neighbour of neighbourIds(id)) {
        const realm = tribeHex.get(neighbour);
        if (realm === undefined) continue;
        if (best === null || realm < best) best = realm;
      }
    }
    return best;
  };

  const bestAreaName = (hexes: string[], set: Set<string>): string | undefined => {
    let best: string | undefined;
    let bestCount = 0;
    for (const area of input.areas) {
      let count = 0;
      for (const id of area.hexes) if (set.has(id)) count += 1;
      if (count > bestCount) {
        bestCount = count;
        best = area.name;
      }
    }
    if (best === undefined) return undefined;
    return bestCount + EPSILON >= AREA_SHARE * hexes.length ? best : undefined;
  };

  const nameFor = (hexes: string[], component: number): string => {
    const set = new Set(hexes);
    const group = components.groups[component] ?? [];
    const island =
      group.length > 0 && group.length === hexes.length && group.every((id) => set.has(id));
    const area = bestAreaName(hexes, set);
    if (island) return `The Island Clans of ${area ?? input.region_name}`;
    const base = BASE_NAME[dominantClass(hexes, byId)];
    return area === undefined ? base : `${base} of ${area}`;
  };

  const record = (
    hexes: string[],
    component: number,
    frontier: boolean,
    adjacent: number | null,
  ): void => {
    const name = nameFor(hexes, component);
    let realmIndex = adjacent;
    if (realmIndex === null) {
      realmIndex = combined.length;
      combined.push({ name, kind: 'tribe', capital_place_id: null, off_map: false, liege: null });
    }
    for (const id of hexes) tribeHex.set(id, realmIndex);
    lands.push({ realm_index: realmIndex, name, hexes: [...hexes].sort(), component, frontier });
  };

  const claimed = new Set<string>();
  for (const county of counties.counties) for (const id of county.hexes) claimed.add(id);
  for (const patch of wildPatches(input, byId, claimed)) {
    if (patch.length < WILD_MIN) continue;
    for (const id of patch) taken.add(id);
    const component = components.of.get(patch[0]!) ?? -1;
    record(patch, component, false, adjacentTribe(patch));
  }

  const seatHexes = new Set<string>();
  const placeHex = new Map<number, string>();
  for (const place of input.settlements) placeHex.set(place.place_id, place.hex);
  for (const place of input.strongholds) placeHex.set(place.place_id, place.hex);
  for (const county of counties.counties) {
    const hex = placeHex.get(county.seat_place_id);
    if (hex !== undefined) seatHexes.add(hex);
  }

  const near = new Map<string, number>();
  for (const place of input.settlements) {
    if (place.size !== 'town' && place.size !== 'city') continue;
    for (const [id, dist] of travelCosts(input, place.hex, 1)) {
      const current = near.get(id);
      if (current === undefined || dist < current) near.set(id, dist);
    }
  }
  const isFar = (id: string): boolean => (near.get(id) ?? Infinity) > FAR_FACTOR * RIDE + EPSILON;

  const cap = frontierCap(input.tags);
  const candidates = input.areas
    .map((area, index) => ({
      index,
      hexes: area.hexes.filter((id) => {
        const cell = byId.get(id);
        return cell !== undefined && cell.terrain !== 'water';
      }),
    }))
    .filter((area) => area.hexes.length >= FRONTIER_MIN)
    .filter((area) => share(area.hexes, (id) => ROUGH.has(byId.get(id)!.terrain)) + EPSILON >= ROUGH_SHARE)
    .filter((area) => share(area.hexes, isFar) + EPSILON >= FAR_SHARE)
    .sort((a, b) => b.hexes.length - a.hexes.length || a.index - b.index);

  let founded = 0;
  for (const area of candidates) {
    if (founded >= cap) break;
    const carved: string[] = [];
    for (const id of [...area.hexes].sort()) {
      const cell = byId.get(id)!;
      if (!ROUGH.has(cell.terrain) || !isFar(id)) continue;
      if (taken.has(id) || seatHexes.has(id)) continue;
      const county = countyOfHex.get(id);
      if (county === undefined) continue;
      if (remaining[county]! - 1 < MIN_COUNTY) continue;
      remaining[county]! -= 1;
      taken.add(id);
      carved.push(id);
      tribeHex.delete(id);
      const list = carvedByCounty.get(county);
      if (list) list.push(id);
      else carvedByCounty.set(county, [id]);
    }
    if (carved.length === 0) continue;
    const component = components.of.get(carved[0]!) ?? -1;
    record(carved, component, true, adjacentTribe(carved));
    founded += 1;
  }

  const carved = [...carvedByCounty.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([county, hexes]) => ({ county, hexes: [...hexes].sort() }));

  return { realms: combined, lands, carved };
}
