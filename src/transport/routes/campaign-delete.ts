import type { Express } from 'express';
import type { Db } from '../../db/connection.js';
import { UnknownCampaignError, deleteCampaign } from '../../core/campaign-delete.js';

/** The status and body for a failed delete: a missing campaign is 404, anything else is our failure. */
export function deleteCampaignError(error: unknown): { status: number; error: string } {
  if (error instanceof UnknownCampaignError) return { status: 404, error: 'no such campaign' };
  return { status: 500, error: 'failed to delete campaign' };
}

/** The player's permanent delete: the campaign, every row that belongs to it and its portrait files. */
export default function registerCampaignDeleteRoutes(app: Express, db: Db): void {
  app.delete('/api/campaigns/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    try {
      const { deleted_rows } = deleteCampaign(db, id);
      res.json({ deleted: true, deleted_rows });
    } catch (err) {
      const { status, error } = deleteCampaignError(err);
      res.status(status).json({ error });
    }
  });
}
