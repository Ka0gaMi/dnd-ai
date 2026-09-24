// Pure geometry for the player-safe region map: hexes, borders, routes, places and labels.

export interface PlayerRegionMap {
  name: string;
  width: number;
  height: number;
  hexes: Array<{ id: string; q: number; r: number; terrain: string; county: number | null }>;
  counties: Array<{ name: string | null; realm: number }>;
  realms: Array<{ name: string | null }>;
  duchies: Array<{
    id: number;
    name: string | null;
    border: Array<{ from: string; to: string }>;
    hexes: string[];
  }>;
  places: Array<{
    name: string;
    kind: 'settlement' | 'area' | 'danger';
    size: string | null;
    port: boolean;
    q: number;
    r: number;
  }>;
  routes: Array<{ kind: 'road' | 'searoute'; hexes: string[] }>;
  party: { q: number; r: number } | null;
}

export interface RegionLayout {
  viewBox: string;
  hexes: Array<{ id: string; points: string; terrain: string }>;
  countyBorders: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  duchyBorders: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  realmBorders: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  routes: Array<{ kind: 'road' | 'searoute'; points: string }>;
  places: Array<{ name: string; kind: string; size: string | null; port: boolean; x: number; y: number }>;
  labels: Array<{ text: string; x: number; y: number; kind: 'county' | 'duchy' | 'realm' }>;
  party: { x: number; y: number } | null;
}

interface Point {
  x: number;
  y: number;
}

interface Hex {
  q: number;
  r: number;
}

interface Edge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const SIZE = 10;
const MARGIN = SIZE * 2.5;
const MIN_SPAN = 8;
const SQRT3 = Math.sqrt(3);

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Centre of a pointy-top hex in even-r offset coordinates; even rows sit half a hex right. */
export function hexCentre(q: number, r: number, size: number = SIZE): Point {
  return { x: size * SQRT3 * (q + (r % 2 === 0 ? 0.5 : 0)), y: size * 1.5 * r };
}

const NEIGHBOUR_OFFSETS: Record<'even' | 'odd', Array<[number, number]>> = {
  even: [
    [1, 0],
    [-1, 0],
    [0, -1],
    [1, -1],
    [0, 1],
    [1, 1],
  ],
  odd: [
    [1, 0],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [-1, 1],
    [0, 1],
  ],
};

function neighbours(q: number, r: number): Hex[] {
  return NEIGHBOUR_OFFSETS[r % 2 === 0 ? 'even' : 'odd'].map(([dq, dr]) => ({ q: q + dq, r: r + dr }));
}

function hexCorners(q: number, r: number, size: number = SIZE): Point[] {
  const centre = hexCentre(q, r, size);
  return Array.from({ length: 6 }, (_, k) => {
    const theta = ((60 * k - 30) * Math.PI) / 180;
    return { x: centre.x + size * Math.cos(theta), y: centre.y + size * Math.sin(theta) };
  });
}

const pointString = (point: Point): string => `${round1(point.x)},${round1(point.y)}`;

/** The shared edge is the two corners of A nearest to B's centre, robust to the angle convention. */
function sharedEdge(a: Hex, b: Hex, size: number = SIZE): Edge {
  const target = hexCentre(b.q, b.r, size);
  const square = (point: Point): number => (point.x - target.x) ** 2 + (point.y - target.y) ** 2;
  const [first, second] = [...hexCorners(a.q, a.r, size)].sort((p, q) => square(p) - square(q));
  return { x1: first.x, y1: first.y, x2: second.x, y2: second.y };
}

function parseHexId(id: string): Hex | null {
  const match = /^q(-?\d+)_r(-?\d+)$/.exec(id);
  return match ? { q: Number(match[1]), r: Number(match[2]) } : null;
}

function meanCentre(hexes: Hex[]): Point | null {
  if (hexes.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const hex of hexes) {
    const centre = hexCentre(hex.q, hex.r);
    x += centre.x;
    y += centre.y;
  }
  return { x: x / hexes.length, y: y / hexes.length };
}

export function regionLayout(map: PlayerRegionMap): RegionLayout {
  const hexes = map.hexes.map((hex) => ({
    id: hex.id,
    points: hexCorners(hex.q, hex.r).map(pointString).join(' '),
    terrain: hex.terrain,
  }));

  const byId = new Map(map.hexes.map((hex) => [hex.id, hex]));
  const countyBorders: Edge[] = [];
  const realmBorders: Edge[] = [];
  const seen = new Set<string>();
  for (const hex of map.hexes) {
    for (const neighbour of neighbours(hex.q, hex.r)) {
      const other = byId.get(`q${neighbour.q}_r${neighbour.r}`);
      if (!other) continue;
      if (hex.county === null || other.county === null || hex.county === other.county) continue;
      const key = hex.id < other.id ? `${hex.id}|${other.id}` : `${other.id}|${hex.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const realmA = map.counties[hex.county]?.realm;
      const realmB = map.counties[other.county]?.realm;
      const edge = sharedEdge(hex, other);
      if (realmA !== realmB) realmBorders.push(edge);
      else countyBorders.push(edge);
    }
  }

  // Duchy edges arrive as known hex-id pairs, so they reuse the same shared-edge geometry as counties.
  const duchyBorders: Edge[] = [];
  const seenDuchy = new Set<string>();
  for (const duchy of map.duchies) {
    for (const segment of duchy.border) {
      const key = segment.from < segment.to ? `${segment.from}|${segment.to}` : `${segment.to}|${segment.from}`;
      if (seenDuchy.has(key)) continue;
      const a = parseHexId(segment.from);
      const b = parseHexId(segment.to);
      if (!a || !b) continue;
      seenDuchy.add(key);
      duchyBorders.push(sharedEdge(a, b));
    }
  }

  const routes = map.routes.map((route) => ({
    kind: route.kind,
    points: route.hexes
      .map(parseHexId)
      .filter((hex): hex is Hex => hex !== null)
      .map((hex) => pointString(hexCentre(hex.q, hex.r)))
      .join(' '),
  }));

  const places = map.places.map((place) => {
    const centre = hexCentre(place.q, place.r);
    return { name: place.name, kind: place.kind, size: place.size, port: place.port, x: centre.x, y: centre.y };
  });

  const countyLabels: RegionLayout['labels'] = [];
  map.counties.forEach((county, index) => {
    if (county.name === null || county.name.trim() === '') return;
    const owned = map.hexes.filter((hex) => hex.county === index);
    const centre = meanCentre(owned);
    if (!centre) return;
    // Anchor the label on the visible hex nearest the county's centre so it never floats in fog.
    const anchor = owned
      .map((hex) => hexCentre(hex.q, hex.r))
      .reduce((best, point) =>
        (point.x - centre.x) ** 2 + (point.y - centre.y) ** 2 <
        (best.x - centre.x) ** 2 + (best.y - centre.y) ** 2
          ? point
          : best,
      );
    countyLabels.push({ text: county.name, x: anchor.x, y: anchor.y, kind: 'county' });
  });

  const duchyLabels: RegionLayout['labels'] = [];
  map.duchies.forEach((duchy) => {
    if (duchy.name === null || duchy.name.trim() === '') return;
    const centre = meanCentre(
      duchy.hexes.map(parseHexId).filter((hex): hex is Hex => hex !== null),
    );
    if (centre) duchyLabels.push({ text: duchy.name, x: centre.x, y: centre.y, kind: 'duchy' });
  });

  const realmLabels: RegionLayout['labels'] = [];
  map.realms.forEach((realm, index) => {
    if (realm.name === null || realm.name.trim() === '') return;
    const centre = meanCentre(
      map.hexes.filter((hex) => hex.county !== null && map.counties[hex.county]?.realm === index),
    );
    if (centre) realmLabels.push({ text: realm.name, x: centre.x, y: centre.y, kind: 'realm' });
  });

  // Drop a label that would sit within 1.5 hex widths of a smaller place's label: duchy over county,
  // realm over both. Smaller labels win because a duchy or realm is already implied by its counties.
  const clearance = 1.5 * SIZE * SQRT3;
  const clear = (label: RegionLayout['labels'][number], others: RegionLayout['labels']): boolean =>
    others.every((other) => Math.hypot(label.x - other.x, label.y - other.y) >= clearance);
  const keptDuchy = duchyLabels.filter((duchy) => clear(duchy, countyLabels));
  const labels: RegionLayout['labels'] = [
    ...countyLabels,
    ...keptDuchy,
    ...realmLabels.filter((realm) => clear(realm, [...countyLabels, ...keptDuchy])),
  ];

  // Frame what the party knows (hexes and the party) with a margin, never smaller than MIN_SPAN hexes a side.
  const known = map.hexes.map((hex) => hexCentre(hex.q, hex.r));
  if (map.party) known.push(hexCentre(map.party.q, map.party.r));
  if (known.length === 0) known.push({ x: 0, y: 0 });
  let minX = Math.min(...known.map((p) => p.x)) - MARGIN;
  let maxX = Math.max(...known.map((p) => p.x)) + MARGIN;
  let minY = Math.min(...known.map((p) => p.y)) - MARGIN;
  let maxY = Math.max(...known.map((p) => p.y)) + MARGIN;
  const minWidth = MIN_SPAN * SIZE * Math.sqrt(3);
  const minHeight = MIN_SPAN * SIZE * 1.5;
  if (maxX - minX < minWidth) {
    const grow = (minWidth - (maxX - minX)) / 2;
    minX -= grow;
    maxX += grow;
  }
  if (maxY - minY < minHeight) {
    const grow = (minHeight - (maxY - minY)) / 2;
    minY -= grow;
    maxY += grow;
  }
  const left = Math.floor(minX * 10) / 10;
  const top = Math.floor(minY * 10) / 10;
  const right = Math.ceil(maxX * 10) / 10;
  const bottom = Math.ceil(maxY * 10) / 10;
  const viewBox = `${left} ${top} ${round1(right - left)} ${round1(bottom - top)}`;

  return {
    viewBox,
    hexes,
    countyBorders,
    duchyBorders,
    realmBorders,
    routes,
    places,
    labels,
    party: map.party ? hexCentre(map.party.q, map.party.r) : null,
  };
}
