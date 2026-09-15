import type { Express } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import {
  RollError,
  applyRollBoost,
  inspirePendingRoll,
  openPendingRolls,
  previewPendingRoll,
  resolvePendingRoll,
  rollBoosts,
} from '../../core/rolls.js';

const overrideSchema = z
  .object({
    dice: z.array(z.number().int()).min(1).optional(),
    natural: z.number().int().optional(),
    total: z.number().int().optional(),
  })
  .refine(
    (o) => o.dice !== undefined || o.natural !== undefined || o.total !== undefined,
    'override needs the dice the player set',
  );

/** The player's Roll button: the server rolls, cheat mode may edit the result, the DM waits. */
export default function registerRollRoutes(app: Express, db: Db): void {
  app.get('/api/campaigns/:id/pending-rolls', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    // The boosts ride along with every card, so the window can offer them before the die is clicked.
    res.json(openPendingRolls(db, id).map((row) => ({ ...row, ...rollBoosts(row) })));
  });

  // Cheat mode only: the honest roll, shown before the player accepts or edits it.
  app.post('/api/rolls/:id/preview', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad roll id' });
      return;
    }
    try {
      res.json(previewPendingRoll(db, id));
    } catch (err) {
      if (err instanceof RollError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // Heroic Inspiration: the player has seen the d20 and spends it to take a second one.
  app.post('/api/rolls/:id/inspire', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad roll id' });
      return;
    }
    try {
      res.json(inspirePendingRoll(db, id));
    } catch (err) {
      if (err instanceof RollError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // A homebrew clause the player spends before rolling: the roll is recomputed, the use waits for resolve.
  app.post('/api/rolls/:id/boost', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad roll id' });
      return;
    }
    const body = (req.body ?? {}) as { boost_id?: unknown };
    if (typeof body.boost_id !== 'string' || body.boost_id.length === 0) {
      res.status(400).json({ error: 'boost_id is the id of the boost to apply' });
      return;
    }
    try {
      res.json(applyRollBoost(db, id, body.boost_id));
    } catch (err) {
      if (err instanceof RollError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.post('/api/rolls/:id/resolve', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad roll id' });
      return;
    }
    const body = (req.body ?? {}) as { override?: unknown };
    let override;
    if (body.override !== undefined && body.override !== null) {
      const parsed = overrideSchema.safeParse(body.override);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid override', details: parsed.error.issues });
        return;
      }
      override = parsed.data;
    }
    try {
      res.json(resolvePendingRoll(db, id, override));
    } catch (err) {
      if (err instanceof RollError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
