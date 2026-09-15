import type { Express } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { DIRECT_FIELDS, OVERRIDE_FIELDS, setOverrides, type OverridePatch } from '../../core/overrides.js';
import { getSettings } from '../../core/settings.js';

const field = z.number().int().nullable().optional();
const patchSchema = z
  .object(Object.fromEntries([...OVERRIDE_FIELDS, ...DIRECT_FIELDS].map((name) => [name, field])))
  .strict();

/** Hand-set sheet numbers. Player-only, and only while cheat mode is on. */
export default function registerOverrideRoutes(app: Express, db: Db): void {
  app.post('/api/characters/:id/overrides', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad character id' });
      return;
    }
    const character = db.prepare('SELECT campaign_id FROM character WHERE id = ?').get(id) as
      | { campaign_id: number }
      | undefined;
    if (!character) {
      res.status(404).json({ error: 'no such character' });
      return;
    }
    if (!getSettings(db, character.campaign_id).cheat_mode) {
      res.status(403).json({ error: 'cheat mode is off' });
      return;
    }
    const patch = patchSchema.safeParse(req.body ?? {});
    if (!patch.success) {
      res.status(400).json({ error: 'invalid overrides', details: patch.error.issues });
      return;
    }
    try {
      res.json(setOverrides(db, id, patch.data as OverridePatch));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
}
