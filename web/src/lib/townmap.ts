// Turns a Watabou GeoJSON export into the path data an inline SVG can draw, with no fetching.

export interface Stroke {
  d: string;
  width: number;
}

export interface TownLayers {
  viewBox: string;
  water: string[];
  fields: string[];
  greens: string[];
  squares: string[];
  buildings: string[];
  roads: Stroke[];
  rivers: Stroke[];
  planks: Stroke[];
  walls: Stroke[];
  trees: Array<{ x: number; y: number }>;
  districts: Array<{ name: string; x: number; y: number }>;
}

type Position = [number, number];

/** One feature's geometry fields; the id lives on the same object in a Watabou export. */
interface Geometry {
  type?: unknown;
  coordinates?: unknown;
  geometries?: unknown;
  width?: unknown;
  name?: unknown;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isPosition = (value: unknown): value is Position =>
  Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number';

function ringPath(ring: unknown): string {
  const points = Array.isArray(ring) ? ring.filter(isPosition) : [];
  if (points.length === 0) return '';
  const head = `M ${round1(points[0][0])} ${round1(points[0][1])}`;
  const tail = points
    .slice(1)
    .map((point) => `L ${round1(point[0])} ${round1(point[1])}`)
    .join(' ');
  return tail ? `${head} ${tail} Z` : `${head} Z`;
}

function polygonPath(rings: unknown): string {
  return (Array.isArray(rings) ? rings : []).map(ringPath).filter(Boolean).join(' ');
}

function linePath(coordinates: unknown): string {
  const points = Array.isArray(coordinates) ? coordinates.filter(isPosition) : [];
  if (points.length === 0) return '';
  const head = `M ${round1(points[0][0])} ${round1(points[0][1])}`;
  const tail = points
    .slice(1)
    .map((point) => `L ${round1(point[0])} ${round1(point[1])}`)
    .join(' ');
  return tail ? `${head} ${tail}` : head;
}

function widthOf(geometry: Geometry): number {
  return typeof geometry.width === 'number' && Number.isFinite(geometry.width) ? geometry.width : 1;
}

function polygonStrings(feature: Geometry | undefined): string[] {
  if (!feature || !Array.isArray(feature.coordinates)) return [];
  if (feature.type === 'Polygon') return [polygonPath(feature.coordinates)].filter(Boolean);
  if (feature.type === 'MultiPolygon') return feature.coordinates.map(polygonPath).filter(Boolean);
  return [];
}

const geometriesOf = (feature: Geometry | undefined): unknown[] =>
  feature?.type === 'GeometryCollection' && Array.isArray(feature.geometries) ? feature.geometries : [];

function lineStrokes(feature: Geometry | undefined): Stroke[] {
  return geometriesOf(feature)
    .filter((geometry): geometry is Geometry => isRecord(geometry) && geometry.type === 'LineString')
    .map((geometry) => ({ d: linePath(geometry.coordinates), width: widthOf(geometry) }))
    .filter((stroke) => stroke.d !== '');
}

function wallStrokes(feature: Geometry | undefined): Stroke[] {
  return geometriesOf(feature)
    .filter((geometry): geometry is Geometry => isRecord(geometry) && geometry.type === 'Polygon')
    .map((geometry) => ({ d: polygonPath(geometry.coordinates), width: widthOf(geometry) }))
    .filter((stroke) => stroke.d !== '');
}

function districtLabels(feature: Geometry | undefined): Array<{ name: string; x: number; y: number }> {
  return geometriesOf(feature)
    .filter((geometry): geometry is Geometry => isRecord(geometry) && geometry.type === 'Polygon')
    .map((geometry) => {
      const name = typeof geometry.name === 'string' ? geometry.name : '';
      if (name.trim() === '') return null;
      const outer =
        Array.isArray(geometry.coordinates) && Array.isArray(geometry.coordinates[0])
          ? geometry.coordinates[0]
          : [];
      const points = outer.filter(isPosition);
      const last = points[points.length - 1];
      if (points.length > 1 && last[0] === points[0][0] && last[1] === points[0][1]) points.pop();
      if (points.length === 0) return null;
      const sum = (pick: (point: Position) => number): number =>
        points.reduce((total, point) => total + pick(point), 0) / points.length;
      return {
        name,
        x: round1(sum((point) => point[0])),
        y: round1(sum((point) => point[1])),
      };
    })
    .filter((label): label is { name: string; x: number; y: number } => label !== null);
}

function treePoints(feature: Geometry | undefined): Array<{ x: number; y: number }> {
  const all =
    feature?.type === 'MultiPoint' && Array.isArray(feature.coordinates)
      ? feature.coordinates.filter(isPosition)
      : [];
  const step = Math.max(1, Math.ceil(all.length / 400));
  return all
    .filter((_, index) => index % step === 0)
    .map((point) => ({ x: round1(point[0]), y: round1(point[1]) }));
}

function collectPoints(value: unknown, out: Position[]): void {
  if (isPosition(value)) {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) for (const item of value) collectPoints(item, out);
}

/** Watabou's y axis points north and SVG's points down, so every coordinate pair is mirrored on the way in. */
function flipY(value: unknown): unknown {
  if (isPosition(value)) return [value[0], -value[1], ...value.slice(2)];
  if (Array.isArray(value)) return value.map(flipY);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, flipY(inner)]));
  return value;
}

export function townLayers(input: unknown): TownLayers {
  if (!isRecord(input) || input.type !== 'FeatureCollection') throw new Error('Not a town map');
  const geojson = flipY(input) as Record<string, unknown>;

  const features = new Map<string, Geometry>();
  const rawFeatures = Array.isArray(geojson.features) ? geojson.features : [];
  for (const feature of rawFeatures) {
    if (isRecord(feature) && typeof feature.id === 'string') features.set(feature.id, feature as Geometry);
  }

  const bounds: Position[] = [];
  collectPoints(features.get('buildings')?.coordinates, bounds);
  collectPoints(features.get('walls')?.geometries, bounds);
  if (bounds.length === 0) {
    for (const feature of features.values()) {
      collectPoints(feature.coordinates, bounds);
      collectPoints(feature.geometries, bounds);
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of bounds) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (bounds.length === 0) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const pad = Math.max(20, Math.max(spanX, spanY) * 0.1);
  const viewBox = [minX - pad, minY - pad, spanX + 2 * pad, spanY + 2 * pad].map(round1).join(' ');

  return {
    viewBox,
    water: polygonStrings(features.get('water')),
    fields: polygonStrings(features.get('fields')),
    greens: polygonStrings(features.get('greens')),
    squares: polygonStrings(features.get('squares')),
    buildings: polygonStrings(features.get('buildings')),
    roads: lineStrokes(features.get('roads')),
    rivers: lineStrokes(features.get('rivers')),
    planks: lineStrokes(features.get('planks')),
    walls: wallStrokes(features.get('walls')),
    trees: treePoints(features.get('trees')),
    districts: districtLabels(features.get('districts')),
  };
}
