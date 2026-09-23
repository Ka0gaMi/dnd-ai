// Storage for the named buildings inside a settlement of the region map: a tavern, a shop, a temple,
// each with its downloaded floor plan and whether the party has been told about it.
import type { Db } from '../db/connection.js';

export interface WorldBuilding {
  id: number;
  place_id: number;
  name: string;
  kind: string;
  seed: number;
  url: string;
  raw: unknown;
  known_to_party: boolean;
  created_at: string;
}

interface BuildingRow {
  id: number;
  place_id: number;
  name: string;
  kind: string;
  seed: number;
  url: string;
  raw_json: string;
  known_to_party: number;
  created_at: string;
}

const COLUMNS = 'id, place_id, name, kind, seed, url, raw_json, known_to_party, created_at';

function buildingFromRow(row: BuildingRow): WorldBuilding {
  return {
    id: row.id,
    place_id: row.place_id,
    name: row.name,
    kind: row.kind,
    seed: row.seed,
    url: row.url,
    raw: JSON.parse(row.raw_json) as unknown,
    known_to_party: row.known_to_party === 1,
    created_at: row.created_at,
  };
}

function getBuildingById(db: Db, campaignId: number, buildingId: number): WorldBuilding | undefined {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM world_building WHERE campaign_id = ? AND id = ?`)
    .get(campaignId, buildingId) as BuildingRow | undefined;
  return row ? buildingFromRow(row) : undefined;
}

export function saveBuilding(
  db: Db,
  campaignId: number,
  placeId: number,
  building: { name: string; kind: string; seed: number; url: string; raw: unknown },
): WorldBuilding {
  const place = db
    .prepare('SELECT kind, name FROM world_place WHERE id = ? AND campaign_id = ?')
    .get(placeId, campaignId) as { kind: string; name: string } | undefined;
  if (!place || place.kind !== 'settlement') {
    throw new Error(`Buildings belong to settlements; place ${placeId} is not one on this campaign's map.`);
  }

  const name = building.name.trim();
  if (!name) throw new Error('A building needs a name.');
  if (findBuilding(db, campaignId, placeId, name)) {
    throw new Error(`${place.name} already has a building named "${name}".`);
  }

  const info = db
    .prepare(
      'INSERT INTO world_building (campaign_id, place_id, name, kind, seed, url, raw_json, known_to_party, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
    )
    .run(
      campaignId,
      placeId,
      name,
      building.kind,
      building.seed,
      building.url,
      JSON.stringify(building.raw),
      new Date().toISOString(),
    );

  return getBuildingById(db, campaignId, Number(info.lastInsertRowid))!;
}

export function findBuilding(
  db: Db,
  campaignId: number,
  placeId: number,
  name: string,
): WorldBuilding | undefined {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM world_building WHERE campaign_id = ? AND place_id = ? AND lower(name) = lower(?)`)
    .get(campaignId, placeId, name.trim()) as BuildingRow | undefined;
  return row ? buildingFromRow(row) : undefined;
}

export function listBuildings(
  db: Db,
  campaignId: number,
  placeId: number,
  options: { knownOnly?: boolean } = {},
): WorldBuilding[] {
  const known = options.knownOnly ? ' AND known_to_party = 1' : '';
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM world_building WHERE campaign_id = ? AND place_id = ?${known} ORDER BY id`)
    .all(campaignId, placeId) as BuildingRow[];
  return rows.map(buildingFromRow);
}

export function revealBuilding(db: Db, campaignId: number, buildingId: number): WorldBuilding {
  const info = db
    .prepare('UPDATE world_building SET known_to_party = 1 WHERE id = ? AND campaign_id = ?')
    .run(buildingId, campaignId);
  if (info.changes === 0) throw new Error(`No building ${buildingId} in this campaign.`);
  return getBuildingById(db, campaignId, buildingId)!;
}
