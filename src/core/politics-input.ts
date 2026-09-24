// Builds the county engine's input from a stored region: settlements, roads, areas, edge hexes and
// tags. Pure over a RegionView; the DB helper only reads.
import type { Db } from '../db/connection.js';
import type { RegionView } from './region.js';
import { getRegion } from './region.js';
import { regionHexes } from './politics-store.js';
import type { PoliticsHex, PoliticsInput, PoliticsSettlement, PoliticsStronghold } from './politics-types.js';

/** The city generator's size query parameter from a place link, or undefined when absent or invalid. */
function settlementPopulation(link: string | null): number | undefined {
  if (link === null || !URL.canParse(link)) return undefined;
  const raw = new URL(link).searchParams.get('size');
  if (raw === null || raw.trim() === '') return undefined;
  const size = Number(raw);
  return Number.isFinite(size) ? size : undefined;
}

/** Hexes on the map's outer ring: the ones whose q or r is the smallest or largest present. */
function edgeHexes(hexes: PoliticsHex[]): string[] {
  if (hexes.length === 0) return [];
  const qs = hexes.map((hex) => hex.q);
  const rs = hexes.map((hex) => hex.r);
  const minQ = Math.min(...qs);
  const maxQ = Math.max(...qs);
  const minR = Math.min(...rs);
  const maxR = Math.max(...rs);
  return hexes
    .filter((hex) => hex.q === minQ || hex.q === maxQ || hex.r === minR || hex.r === maxR)
    .map((hex) => hex.id);
}

/** The county engine's input for a stored region: settlements with sizes and coasts, and no strongholds. */
export function politicsInputFrom(view: RegionView, hexes: PoliticsHex[]): PoliticsInput {
  const settlements: PoliticsSettlement[] = view.places
    .filter((place) => place.kind === 'settlement' && place.hexes[0] !== undefined)
    .map((place) => ({
      place_id: place.id,
      name: place.name,
      size: place.tags.size as PoliticsSettlement['size'],
      hex: place.hexes[0],
      coast: place.tags.coast === true,
      population: settlementPopulation(place.link),
    }));

  // Perilous Shores dangers are dungeons and monster lairs, never lordly castles, so none seat a county.
  const strongholds: PoliticsStronghold[] = [];

  const roads = view.routes.filter((route) => route.kind === 'road').map((route) => route.hexes);

  const areas = view.places
    .filter((place) => place.kind === 'area')
    .map((place) => ({ name: place.name, hexes: place.hexes }));

  return {
    region_name: view.name,
    tags: view.tags,
    hexes,
    settlements,
    strongholds,
    roads,
    areas,
    edge_hexes: edgeHexes(hexes),
  };
}

/** Reads a campaign's region and terrain hexes, or null when it has no region. */
export function politicsInputFromDb(db: Db, campaignId: number): PoliticsInput | null {
  const view = getRegion(db, campaignId);
  if (!view) return null;
  return politicsInputFrom(view, regionHexes(db, campaignId) ?? []);
}
