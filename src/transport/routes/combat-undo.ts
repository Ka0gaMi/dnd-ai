import type { Express } from 'express';
import type { Db } from '../../db/connection.js';
import { undoLastCombatAction } from '../../combat/engine.js';

/** Taking back the last combat call is the player's button, so it is a route as well as a tool. */
export default function registerCombatUndoRoutes(app: Express, db: Db): void {
  app.post('/api/campaigns/:id/combat/undo', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    try {
      // The tool name stays on the DM side; the window gets a plain note.
      res.json({ ...undoLastCombatAction(db, id), undone: 'the last action' });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });
}
