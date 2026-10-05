// Lazy political division of a campaign's region: computes and stores it on first use, then answers
// which county, realm and duchy a place belongs to and how firmly it is held. No randomness.
import type { Db } from '../db/connection.js';
import { computeControl, type ControlBand, type ControlSeat } from './politics-control.js';
import { computeHierarchyParts } from './politics.js';
import { politicsInputFromDb } from './politics-input.js';
import { getPolitics, saveHierarchy, type StoredCounty, type StoredDuchy, type StoredPolitics } from './politics-store.js';
import { getRegion, type WorldPlace } from './region.js';

export interface PlacePolitics {
  county: { id: number; name: string } | null;
  realm: {
    id: number;
    name: string;
    capital: string | null;
    government: string | null;
    off_map: boolean;
  } | null;
  duchy: StoredDuchy | null;
  march: boolean;
}

/** A control band as the DM reads it: claimed land under 20 is "claimed wild", unclaimed land plain "wild". */
export type PlaceBand = ControlBand | 'claimed wild';

/** One land hex's control, derived on read from the stored division and never stored. */
export interface PlaceControl {
  band: PlaceBand;
  /** The holding realm's control, floored at zero. */
  control: number;
  /** The county whose legal claim covers the hex, or null on unclaimed land. */
  county_id: number | null;
  realm_id: number | null;
  /** The realm contesting the hex, or null. */
  rival_realm_id: number | null;
}

/** Returns the campaign's stored division, computing and saving it from the region when absent. */
export function ensurePolitics(db: Db, campaignId: number): StoredPolitics | null {
  const existing = getPolitics(db, campaignId);
  if (existing) return existing;

  const input = politicsInputFromDb(db, campaignId);
  if (!input) return null;

  // Politics may not be recomputed once the living world exists, so there is nothing to write then.
  if (db.prepare('SELECT 1 FROM world_state WHERE campaign_id = ?').get(campaignId)) return null;

  return saveHierarchy(db, campaignId, computeHierarchyParts(input));
}

/** A county's legal claim: its stored claim hexes, or the hexes it holds when it predates them. */
const claimOf = (county: StoredCounty): string[] => county.claim_hexes ?? county.hexes;

/** Every land hex's control over the stored counties' claims; null without a region or a division. */
export function controlMap(db: Db, campaignId: number): Map<string, PlaceControl> | null {
  const politics = ensurePolitics(db, campaignId);
  const input = politics ? politicsInputFromDb(db, campaignId) : null;
  if (!politics || !input) return null;

  const hexOf = new Map(input.settlements.map((place) => [place.place_id, place.hex]));
  const capitalOf = new Map(politics.realms.map((realm) => [realm.id, realm.capital_place_id]));
  const seats: ControlSeat[] = [];
  for (const county of politics.counties) {
    const hex = hexOf.get(county.seat_place_id);
    if (hex === undefined) continue;
    seats.push({
      place_id: county.seat_place_id,
      hex,
      kind: county.seat_kind,
      realm: county.realm_id,
      county: county.id,
      capital: capitalOf.get(county.realm_id) === county.seat_place_id,
      march: county.is_march,
    });
  }
  const countyOf = new Map<string, number>();
  for (const county of politics.counties) for (const hex of claimOf(county)) countyOf.set(hex, county.id);

  const control = computeControl(input, seats, {
    claims: politics.claims.map((claim) => ({ county: claim.county_id, claimant_realm: claim.claimant_realm_id })),
    claimOf: (hex) => countyOf.get(hex) ?? null,
  });
  const result = new Map<string, PlaceControl>();
  for (const [hex, entry] of control) {
    const county = countyOf.get(hex) ?? null;
    result.set(hex, {
      band: entry.band === 'wild' && county !== null ? 'claimed wild' : entry.band,
      control: entry.control,
      county_id: county,
      realm_id: entry.realm,
      rival_realm_id: entry.rival,
    });
  }
  return result;
}

/** The control at a place's anchor hex; pass a map already derived in this call to skip recomputing it. */
export function placeControl(
  db: Db,
  campaignId: number,
  place: WorldPlace,
  map: Map<string, PlaceControl> | null = controlMap(db, campaignId),
): PlaceControl | null {
  const hex = place.hexes[0];
  return hex === undefined ? null : (map?.get(hex) ?? null);
}

/** The county, realm and duchy whose legal claim covers a place, keyed by its anchor hex; nulls without a region. */
export function placePolitics(db: Db, campaignId: number, place: WorldPlace): PlacePolitics {
  const politics = ensurePolitics(db, campaignId);
  if (!politics) return { county: null, realm: null, duchy: null, march: false };

  const hex = place.hexes[0];
  const county =
    politics.counties.find((entry) => claimOf(entry).includes(hex)) ??
    (place.kind === 'settlement' ? politics.counties.find((entry) => entry.seat_place_id === place.id) : undefined);
  if (!county) return { county: null, realm: null, duchy: null, march: false };

  const realm = politics.realms.find((entry) => entry.id === county.realm_id);
  const duchy =
    county.duchy_id === null ? null : (politics.duchies.find((entry) => entry.id === county.duchy_id) ?? null);
  const capital = realm
    ? getRegion(db, campaignId)?.places.find((entry) => entry.id === realm.capital_place_id)
    : undefined;

  return {
    county: { id: county.id, name: county.name },
    realm: realm
      ? {
          id: realm.id,
          name: realm.name,
          capital: capital?.name ?? null,
          government: realm.government,
          off_map: realm.off_map,
        }
      : null,
    duchy,
    march: county.is_march,
  };
}
