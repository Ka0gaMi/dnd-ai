// Lazy political division of a campaign's region: computes and stores it on first use, then answers
// which county, realm and duchy a place belongs to. No randomness.
import type { Db } from '../db/connection.js';
import { computeHierarchyParts } from './politics.js';
import { politicsInputFromDb } from './politics-input.js';
import { getPolitics, saveHierarchy, type StoredDuchy, type StoredPolitics } from './politics-store.js';
import { getRegion, type WorldPlace } from './region.js';

export interface PlacePolitics {
  county: { id: number; name: string } | null;
  realm: { id: number; name: string; capital: string | null } | null;
  duchy: StoredDuchy | null;
  march: boolean;
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

/** The county, realm and duchy holding a place, keyed by its anchor hex; nulls without a region. */
export function placePolitics(db: Db, campaignId: number, place: WorldPlace): PlacePolitics {
  const politics = ensurePolitics(db, campaignId);
  if (!politics) return { county: null, realm: null, duchy: null, march: false };

  const hex = place.hexes[0];
  const county =
    politics.counties.find((entry) => entry.hexes.includes(hex)) ??
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
    realm: realm ? { id: realm.id, name: realm.name, capital: capital?.name ?? null } : null,
    duchy,
    march: county.is_march,
  };
}
