// Lazy political division of a campaign's region: computes and stores it on first use, then answers
// which county and realm a place belongs to. No randomness.
import type { Db } from '../db/connection.js';
import { computePolitics, type PoliticsSettlement } from './politics.js';
import { getPolitics, regionHexes, savePolitics, type StoredPolitics } from './politics-store.js';
import { getRegion, type WorldPlace } from './region.js';

export interface PlacePolitics {
  county: { id: number; name: string } | null;
  realm: { id: number; name: string; capital: string | null } | null;
}

/** Returns the campaign's stored division, computing and saving it from the region when absent. */
export function ensurePolitics(db: Db, campaignId: number): StoredPolitics | null {
  const region = getRegion(db, campaignId);
  if (!region) return null;

  const existing = getPolitics(db, campaignId);
  if (existing) return existing;

  const settlements = region.places
    .filter((place) => place.kind === 'settlement')
    .map((place) => ({
      place_id: place.id,
      name: place.name,
      size: place.tags.size as PoliticsSettlement['size'],
      hex: place.hexes[0],
    }));

  const computed = computePolitics({
    region_name: region.name,
    hexes: regionHexes(db, campaignId) ?? [],
    settlements,
  });
  return savePolitics(db, campaignId, computed);
}

/** The county and realm holding a place, keyed by its anchor hex; nulls without a region or division. */
export function placePolitics(db: Db, campaignId: number, place: WorldPlace): PlacePolitics {
  const politics = ensurePolitics(db, campaignId);
  if (!politics) return { county: null, realm: null };

  const hex = place.hexes[0];
  const county = politics.counties.find((entry) => entry.hexes.includes(hex));
  if (!county) return { county: null, realm: null };

  const realm = politics.realms.find((entry) => entry.id === county.realm_id);
  if (!realm) return { county: { id: county.id, name: county.name }, realm: null };

  const capital = getRegion(db, campaignId)?.places.find((entry) => entry.id === realm.capital_place_id);
  return {
    county: { id: county.id, name: county.name },
    realm: { id: realm.id, name: realm.name, capital: capital?.name ?? null },
  };
}
