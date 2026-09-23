import type { Express } from 'express';
import type { Db } from '../../db/connection.js';
import { getCampaign, type CampaignRow } from '../../core/campaign.js';
import { ensurePolitics } from '../../core/politics-service.js';
import { regionHexes } from '../../core/politics-store.js';
import { getRegion } from '../../core/region.js';
import { locatePlace } from '../../core/region-graph.js';
import { playerRegionMap } from '../../core/region-view.js';

/** getCampaign throws for an unknown campaign; the route answers that as a plain 404. */
function findCampaign(db: Db, campaignId: number): CampaignRow | null {
  try {
    return getCampaign(db, campaignId);
  } catch {
    return null;
  }
}

/** The current scene's named location, else the newest scene that named one. */
function partyLocation(db: Db, campaign: CampaignRow): string | null {
  if (campaign.current_scene_id !== null) {
    const current = db
      .prepare('SELECT location_name FROM scene WHERE id = ?')
      .get(campaign.current_scene_id) as { location_name: string | null } | undefined;
    if (current?.location_name) return current.location_name;
  }
  const recent = db
    .prepare(
      'SELECT location_name FROM scene WHERE campaign_id = ? AND location_name IS NOT NULL ORDER BY id DESC LIMIT 1',
    )
    .get(campaign.id) as { location_name: string } | undefined;
  return recent?.location_name ?? null;
}

/** Serves the player-safe region map: only what the party knows, plus where it stands. */
export default function registerRegionMapRoutes(app: Express, db: Db): void {
  app.get('/api/campaigns/:id/region-map', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad id' });
      return;
    }

    const campaign = findCampaign(db, id);
    if (!campaign) {
      res.status(404).json({ error: 'no such campaign' });
      return;
    }

    const view = getRegion(db, id);
    if (!view) {
      res.json({ map: null });
      return;
    }

    const politics = ensurePolitics(db, id);
    const hexes = regionHexes(db, id) ?? [];
    const partyPlace = locatePlace(view, partyLocation(db, campaign)) ?? null;
    res.json({ map: playerRegionMap({ view, hexes, politics, partyPlace }) });
  });
}
