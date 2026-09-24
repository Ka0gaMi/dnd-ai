// Pure parser for a Perilous Shores region export: settlements, dangers, named areas and the routes
// between them. No state, no dice, no I/O; the caller hands in the decoded JSON.
import { z } from 'zod';

export interface RealmSettlement {
  name: string;
  size: 'village' | 'town' | 'city';
  walled: boolean;
  coast: boolean;
  info: string;
  link: string;
  seed: number;
  hex: string;
  q: number;
  r: number;
  terrain: string;
}

export interface RealmDanger {
  name: string;
  link: string;
  seed: number;
  hex: string;
  q: number;
  r: number;
  terrain: string;
}

export interface RealmArea {
  name: string;
  hexes: string[];
  terrain: string;
}

export interface RealmRoute {
  kind: 'road' | 'searoute';
  from_hex: string;
  to_hex: string;
  hexes: string[];
}

export interface ParsedRealm {
  name: string;
  seed: number;
  tags: string[];
  origin: string;
  settlements: RealmSettlement[];
  dangers: RealmDanger[];
  areas: RealmArea[];
  routes: RealmRoute[];
}

const townSchema = z.looseObject({
  name: z.string(),
  type: z.enum(['village', 'town', 'city']),
  walled: z.boolean(),
  info: z.string(),
  link: z.string(),
  seed: z.number(),
});

const dangerSchema = z.looseObject({
  name: z.string(),
  link: z.string(),
  seed: z.number(),
});

const hexSchema = z.looseObject({
  q: z.number(),
  r: z.number(),
  terrain: z.string().optional(),
  town: townSchema.optional(),
  danger: dangerSchema.optional(),
});

const featureSchema = z.looseObject({
  name: z.string(),
  hexes: z.array(z.string()),
});

const realmSchema = z.looseObject({
  name: z.string(),
  origin: z.string(),
  bp: z.looseObject({
    width: z.number(),
    height: z.number(),
    tags: z.array(z.string()),
    seed: z.number(),
  }),
  layout: z.string(),
  hexes: z.record(z.string(), hexSchema),
  roads: z.record(z.string(), z.array(z.string())),
  searoutes: z.record(z.string(), z.array(z.string())).optional(),
  features: z.array(featureSchema),
});

function refuse(reason: string): never {
  throw new Error(`Not a Perilous Shores region: ${reason}`);
}

/** A settlement sits on the coast when its generator link asks for one, either directly or in its tags. */
function isCoastal(link: string): boolean {
  if (!URL.canParse(link)) return false;
  const url = new URL(link);
  if (url.searchParams.get('coast') === '1') return true;
  const tags = url.searchParams.get('tags');
  return tags !== null && tags.split(',').includes('coast');
}

/** In even-r offsets an odd row sits one column right of odd-r, so its q grows by one while r is unchanged. */
function evenRQ(q: number, r: number): number {
  return q + (r & 1);
}

/** Re-keys every `q<q>_r<r>` in a hex id, edge or key from odd-r offsets to even-r; other text is unchanged. */
export function evenRHexId(id: string): string {
  return id.replace(/q(-?\d+)_r(-?\d+)/g, (_match, q: string, r: string) => `q${evenRQ(Number(q), Number(r))}_r${r}`);
}

interface RealmFile {
  layout?: unknown;
  hexes?: Record<string, unknown>;
  roads?: Record<string, string[]>;
  searoutes?: Record<string, string[]>;
  features?: Array<Record<string, unknown> & { hexes?: string[] }>;
  rivers?: Record<string, Record<string, unknown> & { parent?: string | null; channel?: string[] }>;
}

/** Copies an odd-r realm export with every hex id re-keyed to even-r; other input is returned unchanged. */
export function realmAsEvenR<T>(raw: T): T {
  const realm = raw as unknown as RealmFile | null | undefined;
  if (realm === null || realm === undefined || realm.layout !== 'odd-r' || realm.hexes === undefined) {
    return raw;
  }

  const hexes: Record<string, unknown> = {};
  for (const [id, cell] of Object.entries(realm.hexes)) {
    const { q = 0, r = 0 } = (cell ?? {}) as { q?: number; r?: number };
    hexes[evenRHexId(id)] = { ...(cell as object), q: evenRQ(q, r) };
  }
  const convert = (list: string[]): string[] => list.map(evenRHexId);
  const convertEntries = (entries?: Record<string, string[]>): Record<string, string[]> | undefined =>
    entries === undefined
      ? undefined
      : Object.fromEntries(Object.entries(entries).map(([key, list]) => [evenRHexId(key), convert(list)]));

  return {
    ...realm,
    layout: 'even-r',
    hexes,
    roads: convertEntries(realm.roads),
    searoutes: convertEntries(realm.searoutes),
    features: realm.features?.map((feature) => ({ ...feature, hexes: (feature.hexes ?? []).map(evenRHexId) })),
    rivers:
      realm.rivers === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(realm.rivers).map(([key, river]) => [
              evenRHexId(key),
              {
                ...river,
                parent: river.parent == null ? null : evenRHexId(river.parent),
                channel: (river.channel ?? []).map(evenRHexId),
              },
            ]),
          ),
  } as unknown as T;
}

export function parseRealm(raw: unknown): ParsedRealm {
  const parsed = realmSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    refuse(issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'unrecognised shape');
  }
  const realm = realmAsEvenR(parsed.data);
  if (realm.layout !== 'even-r') {
    refuse(`unsupported layout "${realm.layout}"`);
  }

  const hexes = realm.hexes;
  const terrainOf = (hexId: string): string => hexes[hexId]?.terrain ?? 'plains';

  const settlements: RealmSettlement[] = [];
  const dangers: RealmDanger[] = [];
  for (const [hex, cell] of Object.entries(hexes)) {
    if (cell.town) {
      settlements.push({
        name: cell.town.name,
        size: cell.town.type,
        walled: cell.town.walled,
        coast: isCoastal(cell.town.link),
        info: cell.town.info,
        link: cell.town.link,
        seed: cell.town.seed,
        hex,
        q: cell.q,
        r: cell.r,
        terrain: cell.terrain ?? 'plains',
      });
    }
    if (cell.danger) {
      dangers.push({
        name: cell.danger.name,
        link: cell.danger.link,
        seed: cell.danger.seed,
        hex,
        q: cell.q,
        r: cell.r,
        terrain: cell.terrain ?? 'plains',
      });
    }
  }

  for (const [kind, names] of [['settlement', settlements.map((s) => s.name)], ['danger', dangers.map((d) => d.name)]] as const) {
    const twice = names.find((name, i) => names.indexOf(name) !== i);
    if (twice !== undefined) refuse(`two ${kind}s are both named "${twice}"`);
  }
  const settlementNames = new Set(settlements.map((s) => s.name));
  const dangerNames = new Set(dangers.map((d) => d.name));
  const areas: RealmArea[] = realm.features
    .filter((f) => !settlementNames.has(f.name) && !dangerNames.has(f.name))
    .map((f) => ({ name: f.name, hexes: f.hexes, terrain: areaTerrain(f.hexes, terrainOf) }));

  const routes: RealmRoute[] = [];
  const groups: Array<{ kind: RealmRoute['kind']; entries: Record<string, string[]> }> = [
    { kind: 'road', entries: realm.roads },
    { kind: 'searoute', entries: realm.searoutes ?? {} },
  ];
  for (const group of groups) {
    for (const [key, routeHexes] of Object.entries(group.entries)) {
      // The route's own first and last hex are its endpoints; the key would split wrongly on a negative id.
      const [from_hex = key, to_hex = key] = [routeHexes[0], routeHexes.at(-1)];
      routes.push({ kind: group.kind, from_hex, to_hex, hexes: routeHexes });
    }
  }

  return {
    name: realm.name,
    seed: realm.bp.seed,
    tags: realm.bp.tags,
    origin: realm.origin,
    settlements,
    dangers,
    areas,
    routes,
  };
}

/** The most common terrain among a feature's hexes; missing hexes and missing terrain count as plains. */
function areaTerrain(hexIds: string[], terrainOf: (hexId: string) => string): string {
  const counts = new Map<string, number>();
  for (const hexId of hexIds) {
    const terrain = terrainOf(hexId);
    counts.set(terrain, (counts.get(terrain) ?? 0) + 1);
  }
  let best = 'plains';
  let bestCount = 0;
  for (const terrain of [...counts.keys()].sort()) {
    const count = counts.get(terrain) ?? 0;
    if (count > bestCount) {
      best = terrain;
      bestCount = count;
    }
  }
  return best;
}
