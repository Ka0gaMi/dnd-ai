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

export function parseRealm(raw: unknown): ParsedRealm {
  const parsed = realmSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    refuse(issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'unrecognised shape');
  }
  const realm = parsed.data;
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
      const [from_hex, to_hex] = key.split('-');
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
