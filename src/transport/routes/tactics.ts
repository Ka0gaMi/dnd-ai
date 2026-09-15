import type { Express } from 'express';
import type { Db } from '../../db/connection.js';
import { tacticsBetween } from '../../combat/engine.js';
import { activeEncounter } from '../../combat/state.js';

/** Distance, sight, cover, reach and range between two combatants, for the companion window tooltips. */
export default function registerTacticsRoutes(app: Express, db: Db): void {
  app.get('/api/campaigns/:id/tactics', (req, res) => {
    const id = Number(req.params.id);
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isInteger(id) || !Number.isInteger(from) || !Number.isInteger(to)) {
      res.status(400).json({ error: 'from and to must be combatant ids' });
      return;
    }
    if (!activeEncounter(db, id)) {
      res.status(404).json({ error: 'no active encounter' });
      return;
    }
    try {
      res.json(tacticsBetween(db, id, from, to));
    } catch {
      res.status(404).json({ error: 'no such combatant' });
    }
  });
}
