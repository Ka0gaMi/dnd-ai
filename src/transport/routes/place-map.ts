import type { Express, Request, Response } from 'express';
import type { Db } from '../../db/connection.js';
import { getPlaceMap } from '../../core/place-map.js';

interface PlaceRow {
  id: number;
  name: string;
  kind: string;
  known_to_party: number;
}

/** Reads both numeric params, or answers 400 once for either. */
function numericIds(req: Request, res: Response): { campaignId: number; entityId: number } | null {
  const campaignId = Number(req.params.id);
  const entityId = Number(req.params.eid);
  if (!Number.isInteger(campaignId) || !Number.isInteger(entityId)) {
    res.status(400).json({ error: 'bad id' });
    return null;
  }
  return { campaignId, entityId };
}

/** Serves a revealed settlement's city or village map; every miss, dungeon included, answers one 404. */
export default function registerPlaceMapRoutes(app: Express, db: Db): void {
  app.get('/api/campaigns/:id/entities/:eid/town-map', (req, res) => {
    const ids = numericIds(req, res);
    if (ids === null) return;

    const row = db
      .prepare('SELECT id, name, kind, known_to_party FROM world_place WHERE campaign_id = ? AND entity_id = ?')
      .get(ids.campaignId, ids.entityId) as PlaceRow | undefined;

    if (!row || row.kind !== 'settlement' || row.known_to_party !== 1) {
      res.status(404).json({ error: 'no town map' });
      return;
    }

    const map = getPlaceMap(db, ids.campaignId, row.id);
    if (!map || (map.kind !== 'city' && map.kind !== 'village')) {
      res.status(404).json({ error: 'no town map' });
      return;
    }

    res.json({ name: row.name, kind: map.kind, geojson: map.raw });
  });
}
