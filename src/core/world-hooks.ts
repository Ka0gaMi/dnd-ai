// Advance the living world as in-game days pass and deliver its news where the party stands.
import type { Db } from '../db/connection.js';
import { findPlace } from './region.js';
import { ensureWorld } from './world-seed.js';
import { currentGameDay } from './world-store.js';
import { deliverWorldNews } from './world-resolve.js';
import { tickTo } from './world-tick.js';

export function onDayChange(db: Db, campaignId: number): void {
  if (!ensureWorld(db, campaignId)) return;

  const today = currentGameDay(db, campaignId);
  // Each tick covers at most 60 days; six calls catch up 360 days and the rest waits for the next change.
  for (let call = 0; call < 6; call += 1) {
    const result = tickTo(db, campaignId, today);
    if (result.to_day >= today || result.to_day === result.from_day) break;
  }

  const scene = db
    .prepare(
      'SELECT location_name FROM scene WHERE campaign_id = ? AND location_name IS NOT NULL ORDER BY id DESC LIMIT 1',
    )
    .get(campaignId) as { location_name: string } | undefined;
  if (!scene) return;
  const place = findPlace(db, campaignId, scene.location_name);
  if (place?.kind === 'settlement') deliverWorldNews(db, campaignId, place.id, today);
}
