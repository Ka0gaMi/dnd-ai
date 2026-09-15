import type { Express } from 'express';
import type { Db } from '../../db/connection.js';
import { RewindError, rewindToCheckpoint } from '../../core/rewind.js';

/** Undo back to the last checkpoint. The player's call, never the DM's, so there is no tool for it. */
export default function registerRewindRoutes(app: Express, db: Db): void {
  app.post('/api/campaigns/:id/rewind', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    try {
      res.json(rewindToCheckpoint(db, id));
    } catch (err) {
      // Nothing to rewind to is a 404; anything thrown inside the restore is a failure on our side.
      res.status(err instanceof RewindError ? err.status : 500).json({ error: (err as Error).message });
    }
  });
}
