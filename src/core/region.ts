import type { Db } from '../db/connection.js';
import { getCampaign, logEvent } from './campaign.js';
import { parseRealm } from './realm.js';

export type PlaceKind = 'settlement' | 'area' | 'danger';

export interface WorldPlace {
  id: number;
  kind: PlaceKind;
  name: string;
  q: number;
  r: number;
  hexes: string[];
  tags: Record<string, unknown>;
  info: string;
  link: string | null;
  seed: number | null;
  known_to_party: boolean;
  entity_id: number | null;
}

export interface WorldRoute {
  id: number;
  kind: 'road' | 'searoute';
  from_hex: string;
  to_hex: string;
  hexes: string[];
}

export interface RegionView {
  campaign_id: number;
  name: string;
  source: 'generated' | 'uploaded';
  seed: number;
  tags: string[];
  origin_url: string;
  imported_at: string;
  places: WorldPlace[];
  routes: WorldRoute[];
}

export interface PlayerRegionSummary {
  name: string;
  tags: string[];
  seed: number;
  settlements: Array<{ name: string; size: string }>;
  areas: number;
  dangers: number;
  /** True once the party knows any place, after which the map can no longer be replaced. */
  locked: boolean;
}

interface RegionRow {
  campaign_id: number;
  name: string;
  source: 'generated' | 'uploaded';
  seed: number;
  tags_json: string;
  origin_url: string;
  raw_json: string;
  imported_at: string;
}

interface PlaceRow {
  id: number;
  campaign_id: number;
  kind: PlaceKind;
  name: string;
  q: number;
  r: number;
  hexes_json: string;
  tags_json: string;
  info: string;
  link: string | null;
  seed: number | null;
  known_to_party: number;
  entity_id: number | null;
  created_at: string;
}

interface RouteRow {
  id: number;
  campaign_id: number;
  kind: 'road' | 'searoute';
  from_hex: string;
  to_hex: string;
  hexes_json: string;
}

const nowIso = (): string => new Date().toISOString();

function jsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? (parsed as string[]) : [];
}

function jsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

function placeFromRow(row: PlaceRow): WorldPlace {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    q: row.q,
    r: row.r,
    hexes: jsonArray(row.hexes_json),
    tags: jsonObject(row.tags_json),
    info: row.info,
    link: row.link,
    seed: row.seed,
    known_to_party: row.known_to_party === 1,
    entity_id: row.entity_id,
  };
}

function routeFromRow(row: RouteRow): WorldRoute {
  return {
    id: row.id,
    kind: row.kind,
    from_hex: row.from_hex,
    to_hex: row.to_hex,
    hexes: jsonArray(row.hexes_json),
  };
}

export function getRegion(db: Db, campaignId: number): RegionView | null {
  const row = db.prepare('SELECT * FROM world_region WHERE campaign_id = ?').get(campaignId) as RegionRow | undefined;
  if (!row) return null;
  const places = (
    db.prepare('SELECT * FROM world_place WHERE campaign_id = ? ORDER BY id').all(campaignId) as PlaceRow[]
  ).map(placeFromRow);
  const routes = (
    db.prepare('SELECT * FROM world_route WHERE campaign_id = ? ORDER BY id').all(campaignId) as RouteRow[]
  ).map(routeFromRow);
  return {
    campaign_id: row.campaign_id,
    name: row.name,
    source: row.source,
    seed: row.seed,
    tags: jsonArray(row.tags_json),
    origin_url: row.origin_url,
    imported_at: row.imported_at,
    places,
    routes,
  };
}

/** An area has no q/r of its own, so it is anchored at the first hex of its feature list. */
function areaOrigin(area: { name: string; hexes: string[] }): { q: number; r: number } {
  const hex = area.hexes[0];
  const match = hex === undefined ? null : /^q(-?\d+)_r(-?\d+)$/.exec(hex);
  if (!match) throw new Error(`Area "${area.name}" has no hex in q<q>_r<r> form.`);
  return { q: Number(match[1]), r: Number(match[2]) };
}

/** Refuses a replacement the caller did not ask for, or one the party has already outgrown. */
export function assertReplaceable(db: Db, campaignId: number, replace: boolean | undefined): void {
  const existing = getRegion(db, campaignId);
  if (existing && replace !== true) {
    throw new Error(`Campaign ${campaignId} already has a region "${existing.name}". Pass replace to swap it.`);
  }
  if (existing && existing.places.some((p) => p.known_to_party)) {
    throw new Error(`The party already knows places in "${existing.name}", so the region can no longer be replaced.`);
  }
}

export function importRegion(
  db: Db,
  campaignId: number,
  raw: unknown,
  meta: { source: 'generated' | 'uploaded'; replace?: boolean },
): RegionView {
  getCampaign(db, campaignId);
  const realm = parseRealm(raw);
  assertReplaceable(db, campaignId, meta.replace);

  db.transaction(() => {
    db.prepare('DELETE FROM world_building WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM world_place_map WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM world_route WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM world_place WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM world_region WHERE campaign_id = ?').run(campaignId);

    db.prepare(
      'INSERT INTO world_region (campaign_id, name, source, seed, tags_json, origin_url, raw_json, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      campaignId,
      realm.name,
      meta.source,
      realm.seed,
      JSON.stringify(realm.tags),
      realm.origin,
      JSON.stringify(raw),
      nowIso(),
    );

    const ts = nowIso();
    const insertPlace = db.prepare(
      'INSERT INTO world_place (campaign_id, kind, name, q, r, hexes_json, tags_json, info, link, seed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const s of realm.settlements) {
      insertPlace.run(
        campaignId,
        'settlement',
        s.name,
        s.q,
        s.r,
        JSON.stringify([s.hex]),
        JSON.stringify({ size: s.size, walled: s.walled, coast: s.coast, terrain: s.terrain }),
        s.info,
        s.link,
        s.seed,
        ts,
      );
    }
    for (const a of realm.areas) {
      const { q, r } = areaOrigin(a);
      insertPlace.run(
        campaignId,
        'area',
        a.name,
        q,
        r,
        JSON.stringify(a.hexes),
        JSON.stringify({ terrain: a.terrain }),
        '',
        null,
        null,
        ts,
      );
    }
    for (const d of realm.dangers) {
      insertPlace.run(
        campaignId,
        'danger',
        d.name,
        d.q,
        d.r,
        JSON.stringify([d.hex]),
        JSON.stringify({ kind: 'dungeon', terrain: d.terrain }),
        '',
        d.link,
        d.seed,
        ts,
      );
    }

    const insertRoute = db.prepare(
      'INSERT INTO world_route (campaign_id, kind, from_hex, to_hex, hexes_json) VALUES (?, ?, ?, ?, ?)',
    );
    for (const route of realm.routes) {
      insertRoute.run(campaignId, route.kind, route.from_hex, route.to_hex, JSON.stringify(route.hexes));
    }

    logEvent(db, {
      campaign_id: campaignId,
      kind: 'system',
      text: `Region "${realm.name}" imported: ${realm.settlements.length} settlements.`,
      payload: { source: meta.source, seed: realm.seed },
    });
  })();

  return getRegion(db, campaignId)!;
}

const KIND_PREFERENCE: Record<PlaceKind, number> = { settlement: 0, area: 1, danger: 2 };

export function findPlace(db: Db, campaignId: number, ref: number | string): WorldPlace | undefined {
  if (typeof ref === 'number') {
    const row = db
      .prepare('SELECT * FROM world_place WHERE campaign_id = ? AND id = ?')
      .get(campaignId, ref) as PlaceRow | undefined;
    return row ? placeFromRow(row) : undefined;
  }
  const rows = db
    .prepare('SELECT * FROM world_place WHERE campaign_id = ? AND lower(name) = lower(?)')
    .all(campaignId, ref.trim()) as PlaceRow[];
  rows.sort((a, b) => KIND_PREFERENCE[a.kind] - KIND_PREFERENCE[b.kind]);
  return rows[0] ? placeFromRow(rows[0]) : undefined;
}

/** The region as the player's window may see it: no danger names, links or per-place seeds. */
export function playerRegionSummary(view: RegionView): PlayerRegionSummary {
  const of = (kind: PlaceKind): WorldPlace[] => view.places.filter((p) => p.kind === kind);
  return {
    name: view.name,
    tags: view.tags,
    seed: view.seed,
    settlements: of('settlement').map((p) => ({ name: p.name, size: p.tags.size as string })),
    areas: of('area').length,
    dangers: of('danger').length,
    locked: view.places.some((p) => p.known_to_party),
  };
}
