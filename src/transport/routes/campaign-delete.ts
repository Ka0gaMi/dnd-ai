import type { Express } from 'express';
import type { Db } from '../../db/connection.js';
import { deleteCampaign } from '../../core/campaign-delete.js';

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
    } catch {
      res.status(404).json({ error: 'no such campaign' });
    }
  });
}
