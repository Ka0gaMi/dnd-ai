// Storage for the political division of a campaign's region map: its realms and their counties,
// plus the region's hexes with terrain for whoever computes that division.
import type { Db } from '../db/connection.js';

export interface StoredRealm {
  id: number;
  name: string;
  capital_place_id: number | null;
  county_ids: number[];
}

export interface StoredCounty {
  id: number;
  realm_id: number;
  name: string;
  seat_place_id: number;
  hexes: string[];
}

export interface StoredPolitics {
  realms: StoredRealm[];
  counties: StoredCounty[];
}

interface RealmRow {
  id: number;
  name: string;
  capital_place_id: number | null;
}

interface CountyRow {
  id: number;
  realm_id: number;
  name: string;
  seat_place_id: number;
  hexes_json: string;
}

interface RegionHexRow {
  raw_json: string;
}

interface RawHex {
  q: number;
  r: number;
  terrain?: string;
}

export function getPolitics(db: Db, campaignId: number): StoredPolitics | null {
  const realmRows = db
    .prepare('SELECT id, name, capital_place_id FROM world_realm WHERE campaign_id = ? ORDER BY id')
    .all(campaignId) as RealmRow[];
  if (realmRows.length === 0) return null;

  const countyRows = db
    .prepare('SELECT id, realm_id, name, seat_place_id, hexes_json FROM world_county WHERE campaign_id = ? ORDER BY id')
    .all(campaignId) as CountyRow[];
  const counties: StoredCounty[] = countyRows.map((row) => ({
    id: row.id,
    realm_id: row.realm_id,
    name: row.name,
    seat_place_id: row.seat_place_id,
    hexes: JSON.parse(row.hexes_json) as string[],
  }));

  const realms: StoredRealm[] = realmRows.map((row) => ({
    id: row.id,
    name: row.name,
    capital_place_id: row.capital_place_id,
    county_ids: counties.filter((county) => county.realm_id === row.id).map((county) => county.id),
  }));

  return { realms, counties };
}

export function savePolitics(
  db: Db,
  campaignId: number,
  politics: {
    realms: Array<{ name: string; capital_place_id: number | null }>;
    counties: Array<{ name: string; seat_place_id: number; realm: number; hexes: string[] }>;
  },
): StoredPolitics {
  db.transaction(() => {
    db.prepare('DELETE FROM world_county WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM world_realm WHERE campaign_id = ?').run(campaignId);

    const insertRealm = db.prepare(
      'INSERT INTO world_realm (campaign_id, name, capital_place_id) VALUES (?, ?, ?)',
    );
    const realmIds = politics.realms.map((realm) =>
      Number(insertRealm.run(campaignId, realm.name, realm.capital_place_id).lastInsertRowid),
    );

    const insertCounty = db.prepare(
      'INSERT INTO world_county (campaign_id, realm_id, seat_place_id, name, hexes_json) VALUES (?, ?, ?, ?, ?)',
    );
    for (const county of politics.counties) {
      const realmId = realmIds[county.realm];
      if (realmId === undefined) {
        throw new Error(`County "${county.name}" names realm ${county.realm}, which does not exist.`);
      }
      insertCounty.run(campaignId, realmId, county.seat_place_id, county.name, JSON.stringify(county.hexes));
    }
  })();

  return getPolitics(db, campaignId)!;
}

export function regionHexes(
  db: Db,
  campaignId: number,
): Array<{ id: string; q: number; r: number; terrain: string }> | null {
  const row = db.prepare('SELECT raw_json FROM world_region WHERE campaign_id = ?').get(campaignId) as
    | RegionHexRow
    | undefined;
  if (!row) return null;

  const raw = JSON.parse(row.raw_json) as { hexes?: Record<string, RawHex> };
  const hexes = raw.hexes ?? {};
  return Object.entries(hexes).map(([id, cell]) => ({
    id,
    q: cell.q,
    r: cell.r,
    terrain: cell.terrain ?? 'plains',
  }));
}
