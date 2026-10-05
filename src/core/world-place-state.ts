// What a won agenda leaves on the map: a place's passing state (raided, besieged, ruined) that recovers
// lazily, a settlement's own faith, and a county changing hands between sovereign realms.
import type { Db } from '../db/connection.js';
import { hexNeighbours } from './politics.js';
import { getPolitics, type StoredCounty, type StoredRealm } from './politics-store.js';
import { findPlace } from './region.js';
import { parseHex } from './region-graph.js';

export const RAIDED_DAYS = 90;
/** A siege lasts until it is resolved, but never longer than this. */
export const BESIEGED_MAX_DAYS = 180;
export const RUINED_DAYS = 730;

export type PlaceStateKind = 'raided' | 'besieged' | 'ruined';

const STATE_DAYS: Record<PlaceStateKind, number> = {
  raided: RAIDED_DAYS,
  besieged: BESIEGED_MAX_DAYS,
  ruined: RUINED_DAYS,
};

/** The share of foreign land neighbours that makes a kingdom's county a march, as in politics-duchies. */
const MARCH_LAND_SHARE = 0.4;

export interface PlaceState {
  state: PlaceStateKind;
  /** The first day the place reads as recovered. */
  until_day: number;
  cause_event_id: number | null;
  updated_day: number;
}

export interface PlaceStateChange {
  /** A new state, lasting its standard span from the given day. */
  state?: PlaceStateKind;
  /** The settlement's own faith, overriding its realm's church; null removes the override. */
  faith_id?: number | null;
  cause_event_id?: number | null;
}

export interface TransferCountyOptions {
  /** A duchy of the receiving realm for the county to join; without one it sits outside any duchy. */
  duchy_id?: number | null;
  /** The claim the former holder keeps on the county, strong unless given; null keeps none. */
  former_claim?: 'weak' | 'strong' | null;
}

export interface CountyTransfer {
  county_id: number;
  from_realm_id: number;
  to_realm_id: number;
}

interface PlaceStateRow {
  state: PlaceStateKind | null;
  until_day: number | null;
  faith_id: number | null;
  cause_event_id: number | null;
  updated_day: number;
}

function stateRow(db: Db, campaignId: number, placeId: number): PlaceStateRow | undefined {
  return db
    .prepare(
      'SELECT state, until_day, faith_id, cause_event_id, updated_day FROM world_place_state WHERE campaign_id = ? AND place_id = ?',
    )
    .get(campaignId, placeId) as PlaceStateRow | undefined;
}

function inCampaign(db: Db, campaignId: number, table: 'world_place' | 'world_faith' | 'world_event', id: number): boolean {
  return db.prepare(`SELECT 1 FROM ${table} WHERE campaign_id = ? AND id = ?`).get(campaignId, id) !== undefined;
}

/** A row left with neither a state nor a faith says nothing, so it goes. */
function pruneEmpty(db: Db, campaignId: number, placeId: number): void {
  db.prepare(
    'DELETE FROM world_place_state WHERE campaign_id = ? AND place_id = ? AND state IS NULL AND faith_id IS NULL',
  ).run(campaignId, placeId);
}

/** The place's state on the given day, or null once its until_day has come. */
export function getPlaceState(db: Db, campaignId: number, placeId: number, day: number): PlaceState | null {
  const row = stateRow(db, campaignId, placeId);
  if (!row || row.state === null || row.until_day === null || row.until_day <= day) return null;
  return { state: row.state, until_day: row.until_day, cause_event_id: row.cause_event_id, updated_day: row.updated_day };
}

/** Sets a state, a faith override or a cause on a place; fields left out keep their current value. */
export function setPlaceState(
  db: Db,
  campaignId: number,
  placeId: number,
  day: number,
  change: PlaceStateChange,
): PlaceState | null {
  db.transaction(() => {
    if (!inCampaign(db, campaignId, 'world_place', placeId)) throw new Error(`No place ${placeId} in this campaign.`);
    if (change.state !== undefined && STATE_DAYS[change.state] === undefined) {
      throw new Error(`Unknown place state "${String(change.state)}".`);
    }
    if (change.faith_id != null && !inCampaign(db, campaignId, 'world_faith', change.faith_id)) {
      throw new Error(`No faith ${change.faith_id} in this campaign.`);
    }
    if (change.cause_event_id != null && !inCampaign(db, campaignId, 'world_event', change.cause_event_id)) {
      throw new Error(`No world event ${change.cause_event_id} in this campaign.`);
    }

    const current = stateRow(db, campaignId, placeId);
    const state = change.state ?? current?.state ?? null;
    const untilDay = change.state !== undefined ? day + STATE_DAYS[change.state] : (current?.until_day ?? null);
    const faithId = change.faith_id !== undefined ? change.faith_id : (current?.faith_id ?? null);
    const causeId = change.cause_event_id !== undefined ? change.cause_event_id : (current?.cause_event_id ?? null);
    db.prepare(
      `INSERT INTO world_place_state (campaign_id, place_id, state, until_day, faith_id, cause_event_id, updated_day)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(campaign_id, place_id) DO UPDATE SET
         state = excluded.state,
         until_day = excluded.until_day,
         faith_id = excluded.faith_id,
         cause_event_id = excluded.cause_event_id,
         updated_day = excluded.updated_day`,
    ).run(campaignId, placeId, state, untilDay, faithId, causeId, day);
    pruneEmpty(db, campaignId, placeId);
  })();
  return getPlaceState(db, campaignId, placeId, day);
}

/** Ends a place's state now, as when a siege is lifted; its faith override stays. */
export function clearPlaceState(db: Db, campaignId: number, placeId: number, day: number): void {
  db.transaction(() => {
    db.prepare(
      'UPDATE world_place_state SET state = NULL, until_day = NULL, updated_day = ? WHERE campaign_id = ? AND place_id = ?',
    ).run(day, campaignId, placeId);
    pruneEmpty(db, campaignId, placeId);
  })();
}

/** Lifts every siege still standing that a win of the given faction laid, returning the places freed. */
export function liftSiegesBy(db: Db, campaignId: number, factionId: number, day: number): number[] {
  const places = (
    db
      .prepare(
        `SELECT s.place_id FROM world_place_state s JOIN world_event e ON e.id = s.cause_event_id AND e.campaign_id = s.campaign_id
          WHERE s.campaign_id = ? AND s.state = 'besieged' AND s.until_day > ? AND e.faction_id = ?
          ORDER BY s.place_id`,
      )
      .all(campaignId, day, factionId) as Array<{ place_id: number }>
  ).map((row) => row.place_id);
  for (const placeId of places) clearPlaceState(db, campaignId, placeId, day);
  return places;
}

/**
 * The settlement's own faith if it has one, else the faith of its realm's church: the realm's
 * strongest church or dominant crown, the oldest on a tie.
 */
export function settlementFaithId(db: Db, campaignId: number, placeId: number): number | null {
  const override = stateRow(db, campaignId, placeId)?.faith_id ?? null;
  if (override !== null) return override;

  const place = findPlace(db, campaignId, placeId);
  const politics = place ? getPolitics(db, campaignId) : null;
  if (!place || !politics) return null;
  const hex = place.hexes[0];
  const county =
    politics.counties.find((entry) => hex !== undefined && claimOf(entry).includes(hex)) ??
    politics.counties.find((entry) => entry.seat_place_id === placeId);
  if (!county) return null;

  const church = db
    .prepare(
      `SELECT faith_id FROM world_faction
       WHERE campaign_id = ? AND realm_id = ? AND faith_id IS NOT NULL
         AND (type = 'church' OR (type = 'realm' AND influence = 'dominant'))
       ORDER BY CASE influence WHEN 'dominant' THEN 0 WHEN 'strong' THEN 1 ELSE 2 END, id
       LIMIT 1`,
    )
    .get(campaignId, county.realm_id) as { faith_id: number } | undefined;
  return church?.faith_id ?? null;
}

/** The realm at the top of a liege chain. */
function sovereignOf(realms: Map<number, StoredRealm>, realm: StoredRealm): number {
  const seen = new Set<number>();
  let current = realm;
  while (current.liege_realm_id !== null && !seen.has(current.id)) {
    seen.add(current.id);
    const liege = realms.get(current.liege_realm_id);
    if (!liege) break;
    current = liege;
  }
  return current.id;
}

/** A county's legal claim: borders and marches follow it, not the smaller land its seat holds. */
const claimOf = (county: StoredCounty): string[] => county.claim_hexes ?? county.hexes;

/** The counties sharing a land border with this one, by hex adjacency of their claims. */
function landNeighbours(hexCounty: Map<string, number>, county: StoredCounty): number[] {
  const around = new Set<number>();
  for (const hex of claimOf(county)) {
    const { q, r } = parseHex(hex);
    for (const step of hexNeighbours(q, r)) {
      const other = hexCounty.get(`q${step.q}_r${step.r}`);
      if (other !== undefined && other !== county.id) around.add(other);
    }
  }
  return [...around].sort((a, b) => a - b);
}

/**
 * Moves a county to another sovereign realm, into the given duchy or none, recomputing its marches and
 * its neighbours'. The new holder's claim on it lapses and the former holder keeps one; refusals write nothing.
 */
export function transferCounty(
  db: Db,
  campaignId: number,
  countyId: number,
  toRealmId: number,
  opts: TransferCountyOptions = {},
): CountyTransfer {
  return db.transaction(() => {
    const politics = getPolitics(db, campaignId);
    const county = politics?.counties.find((entry) => entry.id === countyId);
    if (!politics || !county) throw new Error(`No county ${countyId} in this campaign.`);
    const realms = new Map(politics.realms.map((realm) => [realm.id, realm]));
    const target = realms.get(toRealmId);
    if (!target) throw new Error(`No realm ${toRealmId} in this campaign.`);
    const holder = realms.get(county.realm_id)!;
    if (target.liege_realm_id !== null) {
      throw new Error(`${target.name} owes fealty to another realm, so it cannot take ${county.name} in its own right.`);
    }
    if (sovereignOf(realms, holder) === target.id) throw new Error(`${county.name} already lies within ${target.name}.`);
    if (holder.capital_place_id !== null && holder.capital_place_id === county.seat_place_id) {
      throw new Error(`${county.name} is the capital county of ${holder.name}.`);
    }
    if (holder.county_ids.length <= 1) throw new Error(`${county.name} is the last county of ${holder.name}.`);
    const duchyId = opts.duchy_id ?? null;
    if (duchyId !== null && politics.duchies.find((duchy) => duchy.id === duchyId)?.realm_id !== target.id) {
      throw new Error(`Duchy ${duchyId} is not a duchy of ${target.name}.`);
    }

    db.prepare('UPDATE world_county SET realm_id = ?, duchy_id = ? WHERE id = ? AND campaign_id = ?').run(
      target.id,
      duchyId,
      county.id,
      campaignId,
    );

    const holderOf = (entry: StoredCounty): number => (entry.id === county.id ? target.id : entry.realm_id);
    const byId = new Map(politics.counties.map((entry) => [entry.id, entry]));
    const hexCounty = new Map<string, number>();
    for (const entry of politics.counties) for (const hex of claimOf(entry)) hexCounty.set(hex, entry.id);
    const setMarch = db.prepare('UPDATE world_county SET is_march = ? WHERE id = ? AND campaign_id = ?');
    for (const affected of [county.id, ...landNeighbours(hexCounty, county)]) {
      const entry = byId.get(affected)!;
      const around = landNeighbours(hexCounty, entry);
      const foreign = around.filter((other) => holderOf(byId.get(other)!) !== holderOf(entry)).length;
      const march =
        realms.get(holderOf(entry))?.kind === 'kingdom' &&
        around.length > 0 &&
        foreign / around.length >= MARCH_LAND_SHARE;
      setMarch.run(march ? 1 : 0, affected, campaignId);
    }

    db.prepare('DELETE FROM world_claim WHERE campaign_id = ? AND county_id = ? AND claimant_realm_id = ?').run(
      campaignId,
      county.id,
      target.id,
    );
    const formerClaim = opts.former_claim === undefined ? 'strong' : opts.former_claim;
    if (formerClaim !== null) {
      db.prepare(
        `INSERT INTO world_claim (campaign_id, county_id, claimant_realm_id, strength, reason) VALUES (?, ?, ?, ?, 'recent conquest')
         ON CONFLICT(campaign_id, county_id, claimant_realm_id) DO UPDATE SET strength = excluded.strength, reason = excluded.reason`,
      ).run(campaignId, county.id, holder.id, formerClaim);
    }

    return { county_id: county.id, from_realm_id: holder.id, to_realm_id: target.id };
  })();
}
