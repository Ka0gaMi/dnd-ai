// Pure digest of a stored Watabou export: GeoJSON towns (city/village) and one-page-dungeon JSON,
// reduced to the few facts an AI DM needs. No state, no dice, no I/O.
import { z } from 'zod';

export interface TownDigest {
  kind: 'city' | 'village';
  name: string;
  buildings: number;
  districts: string[];
  walled: boolean;
  wall_towers: number;
  bridges: number;
  squares: number;
  fields: number;
  water: boolean;
  river: boolean;
  link_flags: string[];
}

export interface DungeonDigest {
  kind: 'dungeon';
  title: string;
  story: string;
  rooms: number;
  doors: Record<string, number>;
  notes: Array<{ ref: string; text: string }>;
  columns: number;
  water: number;
}

export type PlaceMapDigest = TownDigest | DungeonDigest;

const townSchema = z.looseObject({
  type: z.literal('FeatureCollection'),
  features: z.array(z.looseObject({ id: z.string() })),
});

const dungeonSchema = z.looseObject({
  title: z.string(),
  story: z.string().optional(),
  rects: z.array(z.unknown()),
  doors: z.array(z.looseObject({ type: z.number() })),
  notes: z.array(z.looseObject({ ref: z.union([z.string(), z.number()]), text: z.string() })),
  columns: z.array(z.unknown()).optional(),
  water: z.array(z.unknown()).optional(),
});

/** Door type codes from the MIT one-page-dungeon importer, in the order a digest lists them. */
const DOOR_NAMES = [
  'empty',
  'door',
  'opening',
  'stairs down',
  'bars',
  'double door',
  'secret',
  'flush door',
  'stairs up',
];

const CITY_FLAGS: Array<[param: string, flag: string]> = [
  ['citadel', 'citadel'],
  ['urban_castle', 'urban castle'],
  ['plaza', 'plaza'],
  ['temple', 'temple'],
  ['walls', 'walls'],
  ['shantytown', 'shanty town'],
  ['coast', 'coast'],
  ['river', 'river'],
];

const FLAVOUR_LINE =
  "Flavour only: the generator's items and effects are prompts, not rules. Run anything mechanical as SRD content or a homebrew clause.";

function refuse(kind: string, reason: string): never {
  throw new Error(`Not a ${kind} map: ${reason}`);
}

function issueReason(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'unrecognised shape';
}

function searchParams(link: string): URLSearchParams | null {
  return URL.canParse(link) ? new URL(link).searchParams : null;
}

/** Length of an array-shaped value, or 0 when it is missing or not an array. */
function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function geometriesOf(feature: Record<string, unknown> | undefined): unknown[] {
  const geometries = feature?.geometries;
  return Array.isArray(geometries) ? geometries : [];
}

/** Outer-ring point count minus the closing point that repeats the first. */
function ringPoints(geometry: unknown): number {
  const coordinates = (geometry as { coordinates?: unknown } | null)?.coordinates;
  if (!Array.isArray(coordinates) || !Array.isArray(coordinates[0])) return 0;
  return Math.max(0, coordinates[0].length - 1);
}

function townDigest(kind: 'city' | 'village', raw: unknown, link: string): TownDigest {
  const parsed = townSchema.safeParse(raw);
  if (!parsed.success) refuse(kind, issueReason(parsed.error));
  const features: unknown[] = parsed.data.features;
  const featureOf = (id: string): Record<string, unknown> | undefined =>
    features.find(
      (feature): feature is Record<string, unknown> =>
        typeof feature === 'object' && feature !== null && (feature as { id?: unknown }).id === id,
    );

  const districts = geometriesOf(featureOf('districts'))
    .map((geometry) => (geometry as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === 'string');
  const walls = geometriesOf(featureOf('walls'));
  const params = searchParams(link);

  return {
    kind,
    name: params?.get('name') ?? '',
    buildings: arrayLength(featureOf('buildings')?.coordinates),
    districts,
    walled: walls.length > 0,
    wall_towers: walls.reduce<number>((total, wall) => total + ringPoints(wall), 0),
    bridges: geometriesOf(featureOf('planks')).length,
    squares: arrayLength(featureOf('squares')?.coordinates),
    fields: arrayLength(featureOf('fields')?.coordinates),
    water: arrayLength(featureOf('water')?.coordinates) > 0,
    river: geometriesOf(featureOf('rivers')).length > 0,
    link_flags: kind === 'city' ? cityFlags(params) : villageFlags(params),
  };
}

function cityFlags(params: URLSearchParams | null): string[] {
  if (!params) return [];
  return CITY_FLAGS.filter(([param]) => params.get(param) === '1').map(([, flag]) => flag);
}

function villageFlags(params: URLSearchParams | null): string[] {
  const tags = params?.get('tags');
  return tags ? tags.split(',').filter((tag) => tag !== '') : [];
}

function doorName(type: number): string {
  return DOOR_NAMES[type] ?? `type ${type}`;
}

function refNumber(ref: string | number): number {
  const value = Number(ref);
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
}

/** Known door names in their canonical order, then any unknown `type <n>` names after them. */
function orderedDoors(doors: Record<string, number>): Array<[string, number]> {
  const known = DOOR_NAMES.filter((name) => (doors[name] ?? 0) > 0).map(
    (name): [string, number] => [name, doors[name] ?? 0],
  );
  const unknown = Object.keys(doors)
    .filter((name) => !DOOR_NAMES.includes(name))
    .sort()
    .map((name): [string, number] => [name, doors[name] ?? 0]);
  return [...known, ...unknown];
}

function dungeonDigest(raw: unknown): DungeonDigest {
  const parsed = dungeonSchema.safeParse(raw);
  if (!parsed.success) refuse('dungeon', issueReason(parsed.error));
  const dungeon = parsed.data;

  const doors: Record<string, number> = {};
  for (const door of dungeon.doors) {
    const name = doorName(door.type);
    doors[name] = (doors[name] ?? 0) + 1;
  }

  const notes = [...dungeon.notes]
    .map((note) => ({ ref: String(note.ref), text: note.text, order: refNumber(note.ref) }))
    .sort((a, b) => a.order - b.order)
    .map(({ ref, text }) => ({ ref, text }));

  return {
    kind: 'dungeon',
    title: dungeon.title,
    story: dungeon.story ?? '',
    rooms: dungeon.rects.length,
    doors,
    notes,
    columns: arrayLength(dungeon.columns),
    water: arrayLength(dungeon.water),
  };
}

export function digestPlaceMap(
  kind: 'city' | 'village' | 'dungeon',
  raw: unknown,
  link: string,
): PlaceMapDigest {
  return kind === 'dungeon' ? dungeonDigest(raw) : townDigest(kind, raw, link);
}

export function renderPlaceMapDigest(digest: PlaceMapDigest): string {
  if (digest.kind === 'dungeon') {
    const doors = orderedDoors(digest.doors)
      .map(([name, count]) => `${name} ${count}`)
      .join(', ');
    return [
      `${digest.title} (dungeon map): ${digest.rooms} rooms and corridors${doors ? `; doors: ${doors}` : ''}`,
      `Story: ${digest.story}`,
      'Notes:',
      ...digest.notes.map((note) => `${note.ref}. ${note.text}`),
      FLAVOUR_LINE,
    ].join('\n');
  }

  let line = `${digest.name} (${digest.kind} map): ${digest.buildings} buildings`;
  if (digest.districts.length > 0) line += `; districts: ${digest.districts.join(', ')}`;
  if (digest.walled) line += `; walled, ${digest.wall_towers} towers`;
  if (digest.bridges > 0) line += `; ${digest.bridges} bridges`;
  if (digest.water) line += '; by water';
  if (digest.river) line += '; river';
  if (digest.link_flags.length > 0) line += `; ${digest.link_flags.join(', ')}`;
  return line;
}
