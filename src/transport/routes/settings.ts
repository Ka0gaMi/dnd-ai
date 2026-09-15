import type { Express } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { getSettings, updateSettings } from '../../core/settings.js';

export default function registerSettingsRoutes(app: Express, db: Db): void {
  app.get('/api/campaigns/:id/settings', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    try {
      res.json(getSettings(db, id));
    } catch {
      res.status(404).json({ error: 'no such campaign' });
    }
  });

  app.patch('/api/campaigns/:id/settings', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    try {
      res.json(updateSettings(db, id, (req.body ?? {}) as Record<string, unknown>));
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'invalid settings', details: err.issues });
        return;
      }
      res.status(404).json({ error: 'no such campaign' });
    }
  });
}
