// Pure geometry over a stored region: hex and place distances, neighbours, travel along routes and
// matching free text to a place. No database, no dice, no I/O.
import type { PlaceKind, RegionView, WorldPlace } from './region.js';

export const MILES_PER_HEX = 6;

export interface Hex {
  q: number;
  r: number;
}

const HEX_ID = /^q(-?\d+)_r(-?\d+)$/;

export function parseHex(id: string): Hex {
  const match = HEX_ID.exec(id);
  if (!match) throw new Error(`Not a hex id: "${id}"`);
  return { q: Number(match[1]), r: Number(match[2]) };
}

/** Even-r offset to cube, then the Chebyshev distance between the two cubes. */
export function hexDistance(a: Hex, b: Hex): number {
  const cube = (h: Hex): [number, number, number] => {
    const x = h.q - (h.r + (h.r & 1)) / 2;
    const z = h.r;
    return [x, -x - z, z];
  };
  const [ax, ay, az] = cube(a);
  const [bx, by, bz] = cube(b);
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}

/** The nearest pair of hexes between two places; a shared hex is distance 0. */
export function placeDistance(a: WorldPlace, b: WorldPlace): number {
  let best = Infinity;
  for (const aHex of a.hexes) {
    const from = parseHex(aHex);
    for (const bHex of b.hexes) {
      const distance = hexDistance(from, parseHex(bHex));
      if (distance < best) best = distance;
    }
  }
  return best;
}

export function nearbyPlaces(
  view: RegionView,
  place: WorldPlace,
  maxHexes = 3,
): Array<{ place: WorldPlace; hexes: number; miles: number }> {
  return view.places
    .filter((other) => other.id !== place.id)
    .map((other) => ({ place: other, hexes: placeDistance(place, other) }))
    .filter((entry) => entry.hexes <= maxHexes)
    .map((entry) => ({ ...entry, miles: entry.hexes * MILES_PER_HEX }))
    .sort((a, b) => a.hexes - b.hexes || a.place.name.localeCompare(b.place.name));
}

const KIND_PREFERENCE: Record<PlaceKind, number> = { settlement: 0, area: 1, danger: 2 };

const anchorHex = (place: WorldPlace): string => `q${place.q}_r${place.r}`;

type RoutePlan = { hexes: number; miles: number; kinds: Array<'road' | 'searoute'>; stops: string[] };

/** Dijkstra over route endpoints, weighted by a route's step count; null when travel is impossible. */
export function routeBetween(
  view: RegionView,
  from: WorldPlace,
  to: WorldPlace,
): RoutePlan | null {
  if (from.kind === 'area' || to.kind === 'area') return null;
  if (from.id === to.id) return { hexes: 0, miles: 0, kinds: [], stops: [] };

  const start = anchorHex(from);
  const end = anchorHex(to);

  const nodes = new Set<string>();
  const edges = new Map<string, Array<{ to: string; weight: number; kind: 'road' | 'searoute' }>>();
  for (const route of view.routes) {
    const weight = route.hexes.length - 1;
    nodes.add(route.from_hex);
    nodes.add(route.to_hex);
    for (const [fromHex, toHex] of [
      [route.from_hex, route.to_hex],
      [route.to_hex, route.from_hex],
    ] as const) {
      const list = edges.get(fromHex) ?? [];
      list.push({ to: toHex, weight, kind: route.kind });
      edges.set(fromHex, list);
    }
  }
  if (!nodes.has(start) || !nodes.has(end)) return null;

  const dist = new Map<string, number>();
  const previous = new Map<string, { node: string; kind: 'road' | 'searoute' }>();
  const settled = new Set<string>();
  for (const node of nodes) dist.set(node, Infinity);
  dist.set(start, 0);

  while (true) {
    let current: string | null = null;
    for (const node of nodes) {
      if (settled.has(node)) continue;
      if (current === null || dist.get(node)! < dist.get(current)!) current = node;
    }
    if (current === null || dist.get(current) === Infinity || current === end) break;
    settled.add(current);
    for (const edge of edges.get(current) ?? []) {
      const candidate = dist.get(current)! + edge.weight;
      if (candidate < dist.get(edge.to)!) {
        dist.set(edge.to, candidate);
        previous.set(edge.to, { node: current, kind: edge.kind });
      }
    }
  }
  if (dist.get(end) === Infinity) return null;

  const path: string[] = [];
  for (let node = end; node !== start; ) {
    path.unshift(node);
    const hop = previous.get(node);
    if (!hop) return null;
    node = hop.node;
  }
  path.unshift(start);

  const nameOnHex = (hex: string): string | undefined =>
    view.places.find((p) => p.kind === 'settlement' && p.hexes.includes(hex))?.name;

  const kinds = path.slice(1).map((node) => previous.get(node)!.kind);
  const stops = path.slice(1, -1).map((node) => nameOnHex(node) ?? node);
  return { hexes: dist.get(end)!, miles: dist.get(end)! * MILES_PER_HEX, kinds, stops };
}

/** Exact name first, then the longest place name contained in the text; settlement beats area beats danger. */
export function locatePlace(view: RegionView, text: string | null | undefined): WorldPlace | undefined {
  if (text === null || text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const lower = trimmed.toLowerCase();

  const exact = view.places
    .filter((place) => place.name.toLowerCase() === lower)
    .sort((a, b) => KIND_PREFERENCE[a.kind] - KIND_PREFERENCE[b.kind]);
  if (exact[0]) return exact[0];

  const contained = view.places
    .filter((place) => lower.includes(place.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length || KIND_PREFERENCE[a.kind] - KIND_PREFERENCE[b.kind]);
  return contained[0];
}
