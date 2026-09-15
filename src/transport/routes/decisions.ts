import type { Express } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { DecisionError, openDecisions, resolveDecision } from '../../core/decisions.js';
import { mechanicsSchema } from '../../core/progression.js';

const resolveSchema = z.object({
  decision: z.enum(['accept', 'reject', 'edit']),
  edits: z
    .object({ name: z.string().optional(), text: z.string().optional(), mechanics: mechanicsSchema.optional() })
    .optional(),
});

/** The homebrew dialog in the player's window: they accept, reject or edit what the DM proposed. */
export default function registerDecisionRoutes(app: Express, db: Db): void {
  app.get('/api/campaigns/:id/decisions', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    res.json(
      openDecisions(db, id).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) as unknown })),
    );
  });

  app.post('/api/decisions/:id/resolve', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad decision id' });
      return;
    }
    const parsed = resolveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid decision', details: parsed.error.issues });
      return;
    }
    try {
      res.json(resolveDecision(db, id, parsed.data));
    } catch (err) {
      if (err instanceof DecisionError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
