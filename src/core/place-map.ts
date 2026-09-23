// Storage for the downloaded map export of a region place: a settlement's city/village map or a
// danger's dungeon map. One per place; no fetching and no dice live here.
import type { Db } from '../db/connection.js';
import type { PlaceKind } from './region.js';

export type PlaceMapKind = 'city' | 'village' | 'dungeon';

export interface StoredPlaceMap {
  place_id: number;
  kind: PlaceMapKind;
  url: string;
  raw: unknown;
  fetched_at: string;
}

interface PlaceMapRow {
  place_id: number;
  kind: PlaceMapKind;
  url: string;
  raw_json: string;
  fetched_at: string;
}

/** Which map kinds each place kind can hold: settlements a city or village, dangers a dungeon, areas none. */
const ALLOWED: Record<PlaceKind, PlaceMapKind[]> = {
  settlement: ['city', 'village'],
  danger: ['dungeon'],
  area: [],
};

/** Whether a place of this kind may hold a map of this kind. */
export function canHold(placeKind: PlaceKind, mapKind: PlaceMapKind): boolean {
  return ALLOWED[placeKind].includes(mapKind);
}

export function savePlaceMap(
  db: Db,
  campaignId: number,
  placeId: number,
  map: { kind: PlaceMapKind; url: string; raw: unknown },
): StoredPlaceMap {
  const place = db
    .prepare('SELECT kind FROM world_place WHERE id = ? AND campaign_id = ?')
    .get(placeId, campaignId) as { kind: PlaceKind } | undefined;
  if (!place) throw new Error(`No place ${placeId} on this campaign's region map.`);
  if (!canHold(place.kind, map.kind)) {
    throw new Error(`A ${place.kind} cannot hold a ${map.kind} map.`);
  }

  db.prepare(
    'INSERT OR REPLACE INTO world_place_map (place_id, campaign_id, kind, url, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(placeId, campaignId, map.kind, map.url, JSON.stringify(map.raw), new Date().toISOString());

  return getPlaceMap(db, campaignId, placeId)!;
}

export function getPlaceMap(db: Db, campaignId: number, placeId: number): StoredPlaceMap | null {
  const row = db
    .prepare('SELECT place_id, kind, url, raw_json, fetched_at FROM world_place_map WHERE place_id = ? AND campaign_id = ?')
    .get(placeId, campaignId) as PlaceMapRow | undefined;
  if (!row) return null;
  return {
    place_id: row.place_id,
    kind: row.kind,
    url: row.url,
    raw: JSON.parse(row.raw_json) as unknown,
    fetched_at: row.fetched_at,
  };
}
