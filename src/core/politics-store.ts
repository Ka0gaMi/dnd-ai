// Storage for the political division of a campaign's region map: its realms, duchies, counties and
// claims, plus the region's hexes with terrain for whoever computes that division.
import type { Db } from '../db/connection.js';
import type { ComputedCounties, ComputedHierarchy, ComputedRealms, JoinedHow, RealmKind, SeatKind } from './politics-types.js';
import { realmAsEvenR } from './realm.js';

export interface StoredRealm {
  id: number;
  name: string;
  capital_place_id: number | null;
  kind: RealmKind;
  off_map: boolean;
  liege_realm_id: number | null;
  government: string | null;
  ruler_title: string | null;
  county_ids: number[];
}

export interface StoredCounty {
  id: number;
  realm_id: number;
  name: string;
  seat_place_id: number;
  hexes: string[];
  seat_kind: SeatKind;
  duchy_id: number | null;
  is_march: boolean;
  village_place_ids: number[];
}

export interface StoredDuchy {
  id: number;
  realm_id: number;
  name: string;
  seat_place_id: number | null;
  demesne: boolean;
  joined_how: JoinedHow;
  county_ids: number[];
}

export interface StoredClaim {
  county_id: number;
  claimant_realm_id: number;
  strength: 'weak' | 'strong';
  reason: string;
}

export interface StoredPolitics {
  realms: StoredRealm[];
  counties: StoredCounty[];
  duchies: StoredDuchy[];
  claims: StoredClaim[];
}

interface RealmRow {
  id: number;
  name: string;
  capital_place_id: number | null;
  kind: RealmKind;
  off_map: number;
  liege_realm_id: number | null;
  government: string | null;
  ruler_title: string | null;
}

interface CountyRow {
  id: number;
  realm_id: number;
  name: string;
  seat_place_id: number;
  hexes_json: string;
  seat_kind: SeatKind;
  duchy_id: number | null;
  is_march: number;
  village_ids_json: string;
}

interface DuchyRow {
  id: number;
  realm_id: number;
  name: string;
  seat_place_id: number | null;
  demesne: number;
  joined_how: JoinedHow;
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
    .prepare('SELECT id, name, capital_place_id, kind, off_map, liege_realm_id, government, ruler_title FROM world_realm WHERE campaign_id = ? ORDER BY id')
    .all(campaignId) as RealmRow[];
  if (realmRows.length === 0) return null;

  const countyRows = db
    .prepare(
      'SELECT id, realm_id, name, seat_place_id, hexes_json, seat_kind, duchy_id, is_march, village_ids_json FROM world_county WHERE campaign_id = ? ORDER BY id',
    )
    .all(campaignId) as CountyRow[];
  const counties: StoredCounty[] = countyRows.map((row) => ({
    id: row.id,
    realm_id: row.realm_id,
    name: row.name,
    seat_place_id: row.seat_place_id,
    hexes: JSON.parse(row.hexes_json) as string[],
    seat_kind: row.seat_kind,
    duchy_id: row.duchy_id,
    is_march: row.is_march === 1,
    village_place_ids: JSON.parse(row.village_ids_json) as number[],
  }));

  const duchyRows = db
    .prepare('SELECT id, realm_id, name, seat_place_id, demesne, joined_how FROM world_duchy WHERE campaign_id = ? ORDER BY id')
    .all(campaignId) as DuchyRow[];
  const duchies: StoredDuchy[] = duchyRows.map((row) => ({
    id: row.id,
    realm_id: row.realm_id,
    name: row.name,
    seat_place_id: row.seat_place_id,
    demesne: row.demesne === 1,
    joined_how: row.joined_how,
    county_ids: counties.filter((county) => county.duchy_id === row.id).map((county) => county.id),
  }));

  const claims = db
    .prepare('SELECT county_id, claimant_realm_id, strength, reason FROM world_claim WHERE campaign_id = ? ORDER BY county_id, claimant_realm_id')
    .all(campaignId) as StoredClaim[];

  const realms: StoredRealm[] = realmRows.map((row) => ({
    id: row.id,
    name: row.name,
    capital_place_id: row.capital_place_id,
    kind: row.kind,
    off_map: row.off_map === 1,
    liege_realm_id: row.liege_realm_id,
    government: row.government,
    ruler_title: row.ruler_title,
    county_ids: counties.filter((county) => county.realm_id === row.id).map((county) => county.id),
  }));

  return { realms, counties, duchies, claims };
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

/** Replaces the campaign's realms, duchies, counties and claims; only valid before the world starts. */
export function saveHierarchy(
  db: Db,
  campaignId: number,
  parts: { counties: ComputedCounties; realms: ComputedRealms; hierarchy: ComputedHierarchy },
): StoredPolitics {
  if (db.prepare('SELECT 1 FROM world_state WHERE campaign_id = ?').get(campaignId)) {
    throw new Error('Politics cannot be recomputed after the living world has started.');
  }

  db.transaction(() => {
    db.prepare('DELETE FROM world_claim WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM world_county WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM world_duchy WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM world_realm WHERE campaign_id = ?').run(campaignId);

    const insertRealm = db.prepare(
      'INSERT INTO world_realm (campaign_id, name, capital_place_id, kind, off_map) VALUES (?, ?, ?, ?, ?)',
    );
    const realmIds = parts.realms.realms.map((realm) =>
      Number(
        insertRealm.run(campaignId, realm.name, realm.capital_place_id, realm.kind, realm.off_map ? 1 : 0).lastInsertRowid,
      ),
    );

    const setLiege = db.prepare('UPDATE world_realm SET liege_realm_id = ? WHERE id = ? AND campaign_id = ?');
    parts.realms.realms.forEach((realm, index) => {
      if (realm.liege === null) return;
      const liegeId = realmIds[realm.liege];
      if (liegeId === undefined) {
        throw new Error(`Realm "${realm.name}" owes fealty to realm ${realm.liege}, which does not exist.`);
      }
      setLiege.run(liegeId, realmIds[index], campaignId);
    });

    const insertDuchy = db.prepare(
      'INSERT INTO world_duchy (campaign_id, realm_id, name, seat_place_id, demesne, joined_how) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const duchyIds = parts.hierarchy.duchies.map((duchy) => {
      const realmId = realmIds[duchy.realm];
      if (realmId === undefined) {
        throw new Error(`Duchy "${duchy.name}" names realm ${duchy.realm}, which does not exist.`);
      }
      return Number(
        insertDuchy.run(campaignId, realmId, duchy.name, duchy.seat_place_id, duchy.demesne ? 1 : 0, duchy.joined_how)
          .lastInsertRowid,
      );
    });

    const insertCounty = db.prepare(
      'INSERT INTO world_county (campaign_id, realm_id, seat_place_id, name, hexes_json, seat_kind, duchy_id, is_march, village_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const march = new Set(parts.hierarchy.march_counties);
    const countyIds = parts.counties.counties.map((county, index) => {
      const realmIndex = parts.realms.county_realm[index];
      const realmId = realmIndex === undefined ? undefined : realmIds[realmIndex];
      if (realmId === undefined) {
        throw new Error(`County "${county.name}" names realm ${realmIndex}, which does not exist.`);
      }
      const duchyIndex = parts.hierarchy.county_duchy[index];
      const duchyId = duchyIndex === null || duchyIndex === undefined ? null : duchyIds[duchyIndex];
      if (duchyId === undefined) {
        throw new Error(`County "${county.name}" names duchy ${duchyIndex}, which does not exist.`);
      }
      return Number(
        insertCounty.run(
          campaignId,
          realmId,
          county.seat_place_id,
          county.name,
          JSON.stringify(county.hexes),
          county.seat_kind,
          duchyId,
          march.has(index) ? 1 : 0,
          JSON.stringify(county.village_place_ids),
        ).lastInsertRowid,
      );
    });

    const insertClaim = db.prepare(
      'INSERT INTO world_claim (campaign_id, county_id, claimant_realm_id, strength, reason) VALUES (?, ?, ?, ?, ?)',
    );
    for (const claim of parts.hierarchy.claims) {
      const countyId = countyIds[claim.county];
      const claimantId = realmIds[claim.claimant_realm];
      if (countyId === undefined) {
        throw new Error(`Claim names county ${claim.county}, which does not exist.`);
      }
      if (claimantId === undefined) {
        throw new Error(`Claim names realm ${claim.claimant_realm}, which does not exist.`);
      }
      insertClaim.run(campaignId, countyId, claimantId, claim.strength, claim.reason);
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

  const raw = JSON.parse(row.raw_json) as { layout?: string; hexes?: Record<string, RawHex> };
  // The stored file may be odd-r; every other reader of the region is even-r, so convert its hexes here.
  const { hexes = {} } = realmAsEvenR(raw);
  return Object.entries(hexes).map(([id, cell]) => ({
    id,
    q: cell.q,
    r: cell.r,
    terrain: cell.terrain ?? 'plains',
  }));
}
