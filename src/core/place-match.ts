// Resolves a free-text party location to a known region place: an exact name first, then the longest
// known place name appearing in the text as a whole word. The text scan reuses locatePlace.
import type { Db } from '../db/connection.js';
import { locatePlace } from './region-graph.js';
import { findPlace, getRegion, type WorldPlace } from './region.js';

export function matchPlace(db: Db, campaignId: number, location: string): WorldPlace | undefined {
  const exact = findPlace(db, campaignId, location);
  if (exact) return exact;
  const view = getRegion(db, campaignId);
  return view ? locatePlace(view, location) : undefined;
}
