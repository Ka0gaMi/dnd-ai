import type { Express, Request, Response } from 'express';
import type { Db } from '../../db/connection.js';
import { listBuildings } from '../../core/building.js';
import { playerPlan } from '../../core/building-plan.js';

interface PlaceRow {
  id: number;
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

/** Serves a revealed settlement's known buildings with secret rooms removed; every miss answers an empty list. */
export default function registerBuildingRoutes(app: Express, db: Db): void {
  app.get('/api/campaigns/:id/entities/:eid/buildings', (req, res) => {
    const ids = numericIds(req, res);
    if (ids === null) return;

    const row = db
      .prepare('SELECT id, kind, known_to_party FROM world_place WHERE campaign_id = ? AND entity_id = ?')
      .get(ids.campaignId, ids.entityId) as PlaceRow | undefined;

    if (!row || row.kind !== 'settlement' || row.known_to_party !== 1) {
      res.json({ buildings: [] });
      return;
    }

    const buildings = listBuildings(db, ids.campaignId, row.id, { knownOnly: true }).map((b) => ({
      id: b.id,
      name: b.name,
      kind: b.kind,
      plan: playerPlan(b.raw),
    }));

    res.json({ buildings });
  });
}
